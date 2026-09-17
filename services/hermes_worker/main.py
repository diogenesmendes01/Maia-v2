"""P00.2 (spec §6.6, §6.7) — bootstrap do worker, na ordem que a spec exige.

A ordem aqui não é estilo, é a diferença entre um worker isolado e um worker que
herdou o perfil pessoal de alguém. Ela está no §6.7.2 e é reproduzida em
``run_worker``:

1. **Separar IPC de log ANTES de importar Hermes.** Mesmo com
   ``quiet_mode=True`` o Hermes imprime em stdout — ``agent/turn_tool_validation.py:96``
   faz ``print`` incondicional ao reparar nome de tool. Se o protocolo morasse no
   FD 1, esse print entraria no meio de um frame NDJSON.
2. **Home efêmero exigido e conferido.** ``get_hermes_home`` cai no perfil da
   plataforma quando ``HERMES_HOME`` não está setado (``hermes_constants.py:101-108``;
   no Windows, ``%LOCALAPPDATA%/hermes``). Só o IMPORT do Hermes já cria
   ``state.db``, ``SOUL.md``, ``memories/`` e ``sessions/`` lá dentro.
3. **``config.yaml`` próprio, com dois valores que mudam comportamento de rede
   e de superfície** — ver `render_worker_config`.
4. Registrar as tools, construir UM ``AIAgent``, CONFERIR a superfície efetiva e
   só então emitir ``ready``.

**Por que duplicar o FD 1 em vez de herdar um terceiro descritor:** a herança de
FD extra não é garantida pelo ``child_process`` do Node no Windows, e a spec
manda validar a estratégia na plataforma de deploy (§6.4.2). Duplicar o FD 1
(que o Node sempre entrega) e redirecioná-lo para o FD 2 funciona igual em POSIX
e em Windows, sem depender de pipe nomeado nem de socket — e não abre porta
nenhuma.
"""

from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path
from typing import Any, Final, Mapping, Sequence

from .binding import WorkerBinding
from .bridge_tools import (
    ToolSpec,
    register_bridge_tools,
    tool_schema_digest,
)
from .canonical_json import canonical_digest
from .ipc import ControlPump, IpcBridge, read_start_frame
from .protocol import (
    HERMES_WORKER_PROTOCOL_VERSION,
    FrameWriter,
    NdjsonFrameReader,
)
from .result_projection import project_observed, project_stop, project_usage

__all__ = [
    "BootstrapError",
    "SurfaceMismatch",
    "build_agent_kwargs",
    "inventory_home",
    "render_worker_config",
    "require_ephemeral_home",
    "run_worker",
    "split_ipc_from_logs",
    "verify_effective_surface",
]

BRIDGE_REVISION: Final[str] = "hermes-worker-0.1.0"

#: Variável de ambiente allowlisted no spawn com a credencial CURTA de
#: inferência (§9.1). Nunca chega por frame — o schema do `start` recusa
#: `api_key` dentro de `inference` justamente para isso.
INFERENCE_KEY_ENV: Final[str] = "MAIA_HERMES_INFERENCE_KEY"

#: Categoria FIXA passada a `hard_interrupt`. Nunca texto do cliente (§6.7.3).
CANCEL_TOOL_REASON: Final[str] = "maia_run_cancelled"

EXIT_OK: Final[int] = 0
EXIT_BOOTSTRAP: Final[int] = 2
EXIT_SURFACE: Final[int] = 3
EXIT_PROTOCOL: Final[int] = 4


class BootstrapError(RuntimeError):
    """Pré-condição de isolamento não satisfeita. Nunca "seguir assim mesmo"."""


class SurfaceMismatch(RuntimeError):
    """Superfície efetiva diverge do manifest — drift bloqueia a readiness."""


# ─── 1. descritores ─────────────────────────────────────────────────────────


def split_ipc_from_logs() -> tuple[Any, FrameWriter]:
    """Separa o canal de protocolo do canal de log. Chamar ANTES de importar Hermes.

    Devolve ``(stream de entrada, escritor de frames)``. Depois desta função,
    qualquer ``print`` do Hermes (ou nosso) cai no stderr, porque o FD 1 passa a
    ser uma cópia do FD 2.
    """
    sys.stdout.flush()
    sys.stderr.flush()
    protocol_fd = os.dup(1)  # o pipe que o supervisor entregou como stdout
    os.dup2(2, 1)  # a partir daqui, stdout == stderr
    writer_stream = os.fdopen(protocol_fd, "wb", buffering=0)
    reader_stream = os.fdopen(os.dup(0), "rb", buffering=0)
    return reader_stream, FrameWriter(writer_stream)


# ─── 2. home efêmero ────────────────────────────────────────────────────────


def _personal_profile_home(env: Mapping[str, str], platform: str) -> Path | None:
    """Home pessoal do Hermes Desktop — o lugar que este worker jamais toca.

    Espelha ``_get_platform_default_hermes_home`` (hermes_constants.py:45-51).
    """
    if platform == "win32":
        local_appdata = (env.get("LOCALAPPDATA") or "").strip()
        base = Path(local_appdata) if local_appdata else Path.home() / "AppData" / "Local"
        return base / "hermes"
    return Path.home() / ".hermes"


def require_ephemeral_home(
    env: Mapping[str, str] | None = None, *, platform: str | None = None
) -> Path:
    """Exige ``HERMES_HOME`` novo e vazio, e recusa o perfil pessoal.

    Recusar é o ponto: sem ``HERMES_HOME``, o próprio import do Hermes escreve no
    perfil do usuário. Um worker que "cai no default" contamina a máquina de
    quem o rodou e passa a ler memória, sessões e SOUL.md de outra pessoa.
    """
    environment = os.environ if env is None else env
    platform_name = sys.platform if platform is None else platform

    raw = (environment.get("HERMES_HOME") or "").strip()
    if not raw:
        raise BootstrapError("HERMES_HOME é obrigatório e não pode ser vazio")
    home = Path(raw)
    if not home.is_absolute():
        raise BootstrapError("HERMES_HOME precisa ser caminho absoluto")

    personal = _personal_profile_home(environment, platform_name)
    if personal is not None:
        home_cmp = Path(os.path.normcase(str(home)))
        personal_cmp = Path(os.path.normcase(str(personal)))
        if home_cmp == personal_cmp:
            raise BootstrapError("HERMES_HOME não pode ser o perfil pessoal do Hermes")
        if personal_cmp in home_cmp.parents or home_cmp in personal_cmp.parents:
            raise BootstrapError(
                "HERMES_HOME não pode conter nem viver dentro do perfil pessoal"
            )

    if home.exists():
        if not home.is_dir():
            raise BootstrapError("HERMES_HOME precisa ser diretório")
        if any(home.iterdir()):
            raise BootstrapError("HERMES_HOME precisa estar VAZIO (home efêmero)")
    else:
        home.mkdir(parents=True)
    return home


# ─── 3. config.yaml do home efêmero ─────────────────────────────────────────


def _yaml_scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    # Aspas sempre: `off` sem aspas é lido como booleano em YAML 1.1, e
    # `tools.tool_search.enabled` precisa da STRING "off".
    text = str(value).replace("\\", "\\\\").replace('"', '\\"')
    return f'"{text}"'


def _render_yaml(data: Mapping[str, Any], indent: int = 0) -> str:
    lines: list[str] = []
    prefix = "  " * indent
    for key, value in data.items():
        if isinstance(value, Mapping):
            if not value:
                lines.append(f"{prefix}{key}: {{}}")
            else:
                lines.append(f"{prefix}{key}:")
                lines.append(_render_yaml(value, indent + 1))
        else:
            lines.append(f"{prefix}{key}: {_yaml_scalar(value)}")
    return "\n".join(lines)


def render_worker_config(*, context_length: int) -> str:
    """``config.yaml`` do home efêmero. Só chaves VERIFICADAS no SHA 5d59366.

    Dois valores aqui mudam comportamento observável e não são cosméticos:

    ``model.context_length`` — sem ele, construir o ``AIAgent`` faz I/O DE REDE.
    ``_enforce_minimum_context`` (``agent/agent_init.py:1890``) lê
    ``context_compressor.context_length``, que resolve por
    ``get_model_context_length`` (``agent/model_metadata.py:1945``); o passo 0
    dessa função só retorna sem tocar a rede quando há um inteiro positivo
    configurado (``:1946-1948``). Com endpoint custom e host desconhecido, ela
    sonda ``/models``. O piso é 64.000 (``MINIMUM_CONTEXT_LENGTH``,
    ``model_metadata.py:318``): abaixo disso o construtor levanta ``ValueError``.

    ``tools.tool_search.enabled: "off"`` — o default é ``"auto"``
    (``tools/tool_search.py:64``) e ``should_activate`` trata ``auto`` como
    ``on`` sempre que existir QUALQUER tool diferível (``:189-198``). Uma tool de
    toolset próprio é diferível, então com o default a superfície efetiva vira
    ``tool_search``/``tool_describe``/``tool_call`` — e nenhuma tool da Maia
    aparece para o modelo. Isso foi observado por probe, não deduzido.

    O resto desliga caminhos que ampliam superfície ou abrem rota de egress
    fora do gateway (§6.6).
    """
    if not isinstance(context_length, int) or context_length < 64_000:
        raise BootstrapError(
            "model.context_length precisa ser inteiro >= 64000 (piso do Hermes)"
        )
    config: dict[str, Any] = {
        "model": {"context_length": context_length},
        # Superfície: sem o bridge de Tool Search.
        "tools": {"tool_search": {"enabled": "off"}},
        # Memória: nem store nativo, nem perfil de usuário.
        "memory": {"memory_enabled": False, "user_profile_enabled": False},
        # Contexto: compressor da build aprovada, nunca o context engine (lcm_*).
        "context": {"engine": "compressor"},
        # Compressão desligada: as rotas auxiliares constroem clientes próprios
        # (agent/auxiliary_client.py:164-185) e sairiam fora do gateway.
        "compression": {"enabled": False},
        # Nenhum servidor MCP.
        "mcp_servers": {},
    }
    return _render_yaml(config) + "\n"


def write_worker_config(home: Path, *, context_length: int) -> Path:
    path = home / "config.yaml"
    path.write_text(render_worker_config(context_length=context_length), encoding="utf-8")
    return path


# ─── 4. construção do agente ────────────────────────────────────────────────


def build_agent_kwargs(
    start_frame: Mapping[str, Any],
    binding: WorkerBinding,
    *,
    api_key: str | None,
    tool_start_callback: Any = None,
    tool_complete_callback: Any = None,
) -> dict[str, Any]:
    """Kwargs explícitos do §6.7.1. Todo limite é finito e declarado.

    O default de ``max_iterations`` neste commit é ``sys.maxsize``
    (``run_agent.py:239``), não o 500 que a documentação pública ainda mostra —
    por isso nada aqui depende de default.
    """
    limits = start_frame["limits"]
    inference = start_frame["inference"]
    return {
        "model": inference["model"],
        "provider": inference["provider"],
        "api_mode": inference["api_mode"],
        "base_url": inference["base_url"],
        "api_key": api_key,
        "enabled_toolsets": ["maia_bridge_v1"],
        "disabled_toolsets": [],
        "session_id": binding.initial_session_id,
        "max_iterations": limits["max_iterations"],
        "max_tokens": limits["max_output_tokens_per_call"],
        "run_budget_seconds": limits["run_budget_seconds"],
        "quiet_mode": True,
        "verbose_logging": False,
        "tool_progress_mode": "none",
        "save_trajectories": False,
        "skip_context_files": True,
        "load_soul_identity": False,
        "skip_memory": True,
        "skip_background_review": True,
        "session_db": None,
        "parent_session_id": None,
        "fallback_model": None,
        "credential_pool": None,
        "checkpoints_enabled": False,
        "pass_session_id": False,
        "ephemeral_system_prompt": start_frame["context"]["system"],
        "tool_start_callback": tool_start_callback,
        "tool_complete_callback": tool_complete_callback,
    }


def verify_effective_surface(agent: Any, expected: Sequence[str]) -> tuple[str, ...]:
    """Compara a superfície EFETIVA do agente com o manifest (§6.6, invariante 2).

    Não basta passar ``enabled_toolsets``: Tool Search, memória, context engine,
    Bot Mode e MCP acrescentam nomes por caminhos próprios. O que prova a
    superfície é ``agent.tools``/``agent.valid_tool_names`` depois do init
    (``agent/agent_init.py:1065-1070``) — e divergência BLOQUEIA o ``ready``.
    """
    tools = getattr(agent, "tools", None) or []
    names: list[str] = []
    for entry in tools:
        function = entry.get("function") if isinstance(entry, Mapping) else None
        name = function.get("name") if isinstance(function, Mapping) else None
        if not isinstance(name, str):
            raise SurfaceMismatch("definição de tool sem nome utilizável")
        names.append(name)

    expected_set = set(expected)
    if len(names) != len(set(names)):
        raise SurfaceMismatch("superfície efetiva tem nome duplicado")
    if set(names) != expected_set:
        extra = sorted(set(names) - expected_set)
        missing = sorted(expected_set - set(names))
        raise SurfaceMismatch(f"superfície diverge: extra={extra} ausente={missing}")

    valid = set(getattr(agent, "valid_tool_names", None) or set())
    if valid != expected_set:
        raise SurfaceMismatch("valid_tool_names diverge de agent.tools")
    return tuple(sorted(names))


# ─── 5. home: inventário e limpeza ──────────────────────────────────────────


def inventory_home(home: Path) -> tuple[str, ...]:
    """Tudo que o home efêmero acumulou, em caminhos relativos e ordenados.

    ``session_db=None`` NÃO é promessa de zero persistência: só o import já cria
    ``state.db``, ``SOUL.md``, ``memories/`` e ``sessions/`` (§6.7.1). O
    inventário é o que transforma isso em fato observável na hora de reter ou
    apagar.
    """
    if not home.exists():
        return ()
    found: list[str] = []
    for path in sorted(home.rglob("*")):
        relative = path.relative_to(home).as_posix()
        found.append(relative + ("/" if path.is_dir() else ""))
    return tuple(found)


# ─── 6. lifecycle ───────────────────────────────────────────────────────────


class _RunState:
    """Estado mutável do turno, compartilhado entre a thread do loop e a de controle."""

    def __init__(self) -> None:
        self.cancel_reason: str | None = None
        self.result_acked = threading.Event()
        self.protocol_error: str | None = None
        self.lock = threading.Lock()

    def snapshot(self) -> tuple[str | None, str | None]:
        """``(protocol_error, cancel_reason)`` lidos juntos, sob o lock."""
        with self.lock:
            return self.protocol_error, self.cancel_reason


def run_worker() -> int:
    """Executa UM turno e encerra. Nunca reutiliza o processo (§6.7.2, item 8)."""
    reader_stream, writer = split_ipc_from_logs()
    state = _RunState()
    home: Path | None = None
    agent: Any = None

    try:
        home = require_ephemeral_home()
        frame_reader = NdjsonFrameReader("maia_to_worker")
        parsed, surplus = read_start_frame(reader_stream, frame_reader)
        if parsed.kind != "ok" or (parsed.frame or {}).get("type") != "start":
            print(
                f"[hermes-worker] start inválido: {parsed.code}: {parsed.detail}",
                file=sys.stderr,
            )
            return EXIT_PROTOCOL
        start = dict(parsed.frame or {})

        specs = tuple(
            ToolSpec.from_projection(entry) for entry in start["manifest"]["tools"]
        )
        binding = WorkerBinding(
            execution_id=start["binding"]["execution_id"],
            task_id=start["binding"]["task_id"],
            initial_session_id=start["binding"]["initial_session_id"],
            manifest_digest=start["binding"]["manifest_digest"],
            allowed_tool_names=tuple(spec.name for spec in specs),
            mode=start["binding"]["mode"],
        )
        run_id = start["run_id"]
        limits = start["limits"]

        write_worker_config(
            home, context_length=_resolved_context_length(start)
        )

        bridge = IpcBridge(
            writer,
            run_id,
            max_tool_calls=limits["max_tool_calls"],
            deadline_monotonic=time.monotonic() + limits["run_budget_seconds"],
        )

        def on_cancel(reason: str) -> None:
            with state.lock:
                if state.cancel_reason is None:
                    state.cancel_reason = reason
            writer.send(
                {
                    "protocol": HERMES_WORKER_PROTOCOL_VERSION,
                    "type": "cancel_ack",
                    "run_id": run_id,
                    "received_at": _now_iso(),
                }
            )
            bridge.close()
            local_agent = agent
            if local_agent is not None:
                # Categoria FIXA; jamais texto do cliente como mensagem (§6.7.3).
                local_agent.hard_interrupt(tool_reason=CANCEL_TOOL_REASON)

        def on_protocol_error(detail: str) -> None:
            with state.lock:
                if state.protocol_error is None:
                    state.protocol_error = detail
            bridge.close()
            local_agent = agent
            if local_agent is not None:
                # Canal que violou o protocolo não é mais autoridade (§6.4.2):
                # o loop não continua gastando inferência com as tools fechadas.
                local_agent.hard_interrupt(tool_reason=CANCEL_TOOL_REASON)

        def send_result(stop: Mapping[str, Any], raw: Mapping[str, Any] | None) -> None:
            writer.send(
                {
                    "protocol": HERMES_WORKER_PROTOCOL_VERSION,
                    "type": "result",
                    "run_id": run_id,
                    "request_key": start["request_key"],
                    "stop": dict(stop),
                    "iterations": _bounded_iterations(raw),
                    "observed_tool_call_seqs": list(bridge.allocated_call_seqs),
                    "usage": project_usage(raw),
                    "observed": project_observed(raw),
                }
            )
            # O ACK é do supervisor; sua ausência não muda o desfecho, só o registro.
            state.result_acked.wait(timeout=30.0)

        def stop_before_loop() -> int | None:
            """Barreira antes do loop (§6.7.3 item 2; §6.7.2 item 3).

            Sem janela entre a barreira e o loop: ``on_cancel`` e
            ``on_protocol_error`` gravam o estado ANTES de olhar ``agent``. Se
            viram ``agent`` vazio, a barreira seguinte (que roda depois da
            atribuição) vê o estado; se viram o agente, interrompem-no.
            """
            protocol_error, cancel_reason = state.snapshot()
            if protocol_error is not None:
                print(
                    f"[hermes-worker] erro de protocolo antes do loop: {protocol_error}",
                    file=sys.stderr,
                )
                return EXIT_PROTOCOL
            if cancel_reason is None:
                return None
            # Executor resolvido sem loop: o `result` diz isso ao supervisor
            # (zero iterações, nenhuma tool), sem `ready` — não houve readiness.
            send_result(
                project_stop(
                    None,
                    cancel_reason=cancel_reason,
                    max_iterations=limits["max_iterations"],
                ),
                None,
            )
            return EXIT_OK

        pump = ControlPump(
            reader_stream,
            frame_reader,
            run_id=run_id,
            bridge=bridge,
            on_cancel=on_cancel,
            on_result_ack=lambda _digest: state.result_acked.set(),
            on_protocol_error=on_protocol_error,
        )
        # O que chegou no mesmo `read` do `start` é despachado ANTES de a bomba
        # ler o pipe, para manter a ordem em que a Maia escreveu.
        for frame in surplus:
            pump.handle(frame)
        pump.start()

        exit_code = stop_before_loop()
        if exit_code is not None:
            return exit_code

        # ── imports do Hermes: só agora, com FDs e home já fixados ──
        from tools.registry import registry  # noqa: PLC0415
        from run_agent import AIAgent  # noqa: PLC0415

        register_bridge_tools(
            registry,
            specs,
            binding,
            bridge,
            result_limit_chars=start["manifest"]["result_limit_chars"],
        )

        agent = AIAgent(
            **build_agent_kwargs(
                start, binding, api_key=os.environ.get(INFERENCE_KEY_ENV)
            )
        )
        effective = verify_effective_surface(agent, binding.allowed_tool_names)

        # Cancelamento ou segundo `start` recebidos durante a construção.
        exit_code = stop_before_loop()
        if exit_code is not None:
            return exit_code

        writer.send(
            {
                "protocol": HERMES_WORKER_PROTOCOL_VERSION,
                "type": "ready",
                "run_id": run_id,
                "worker": {
                    "bridge_revision": BRIDGE_REVISION,
                    "hermes_sha": _hermes_sha(),
                    "python_version": ".".join(str(p) for p in sys.version_info[:3]),
                },
                "effective_tool_names": list(effective),
                "tool_schema_digest": tool_schema_digest(specs),
            }
        )

        raw_result = _run_turn(agent, start, binding)

        protocol_error, cancel_reason = state.snapshot()
        if protocol_error is not None:
            # Nenhum texto é candidato depois de o canal violar o protocolo.
            send_result({"kind": "failed", "code": "protocol_error"}, raw_result)
            return EXIT_PROTOCOL
        send_result(
            project_stop(
                raw_result,
                cancel_reason=cancel_reason,
                max_iterations=limits["max_iterations"],
            ),
            raw_result,
        )
        return EXIT_OK

    except BootstrapError as exc:
        print(f"[hermes-worker] bootstrap recusado: {exc}", file=sys.stderr)
        return EXIT_BOOTSTRAP
    except SurfaceMismatch as exc:
        print(f"[hermes-worker] superfície efetiva divergente: {exc}", file=sys.stderr)
        return EXIT_SURFACE
    finally:
        if agent is not None:
            try:
                # `close()` na thread dona; `release_clients()` conserva
                # deliberadamente sessão/tools/processos (run_agent.py:908-916).
                agent.close()
            except Exception as exc:  # pragma: no cover - depende do motor
                print(f"[hermes-worker] falha no close: {exc!r}", file=sys.stderr)
        if home is not None:
            for entry in inventory_home(home):
                print(f"[hermes-worker] home: {entry}", file=sys.stderr)
        writer.close()


def _run_turn(
    agent: Any, start: Mapping[str, Any], binding: WorkerBinding
) -> Mapping[str, Any] | None:
    """Roda ``run_conversation`` UMA vez numa thread dedicada (§6.4.2).

    A thread de controle precisa continuar lendo frames enquanto isto bloqueia;
    é por isso que o loop não roda na thread principal.
    """
    box: dict[str, Any] = {}

    def target() -> None:
        try:
            box["result"] = agent.run_conversation(
                user_message=start["context"]["user_message"],
                conversation_history=_history(start),
                task_id=binding.task_id,
            )
        except Exception as exc:  # pragma: no cover - depende do motor
            box["error"] = exc
            print(f"[hermes-worker] run_conversation falhou: {exc!r}", file=sys.stderr)

    thread = threading.Thread(target=target, name="maia-hermes-turn")
    thread.start()
    # Espera o RETORNO REAL do executor: `cancel_ack` não substitui isso, e
    # cancelar só o future deixaria o motor rodando (§6.7.3, item 3).
    thread.join()
    result = box.get("result")
    return result if isinstance(result, Mapping) else None


def _history(start: Mapping[str, Any]) -> list[dict[str, str]]:
    return [
        {"role": message["role"], "content": message["text"]}
        for message in start["context"]["history"]
    ]


def _bounded_iterations(result: Mapping[str, Any] | None) -> int:
    api_calls = (result or {}).get("api_calls")
    if not isinstance(api_calls, int) or isinstance(api_calls, bool) or api_calls < 0:
        return 0
    return min(api_calls, 1_000)


def _resolved_context_length(start: Mapping[str, Any]) -> int:
    """Janela declarada para o modelo roteado.

    UNKNOWN por contrato: o frame ``start`` NÃO carrega a janela do modelo. Até
    o supervisor publicar esse campo, o worker usa o piso do Hermes (64.000),
    que é o único valor que não inventa capacidade nem dispara descoberta de
    contexto por rede. Ver README, "O que não está coberto".
    """
    return 64_000


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".000Z"


def _hermes_sha() -> str:
    """SHA do checkout pinado, informado pelo supervisor no spawn."""
    return (os.environ.get("MAIA_HERMES_SHA") or "0" * 40).strip().lower()


def main() -> int:  # pragma: no cover - entrada de processo
    return run_worker()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
