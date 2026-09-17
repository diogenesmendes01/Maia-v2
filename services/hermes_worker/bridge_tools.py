"""P00.2 (spec §6.5) — closures de handler e registro no ``ToolRegistry`` do Hermes.

Aqui mora a regra que o resto do worker não pode relaxar: **uma ferramenta só
executa se o ``task_id`` do runtime bater com o binding e se o nome estiver na
allowlist daquele binding.** Tudo o mais é transporte.

Três fatos VERIFICADOS no checkout pinado (SHA 5d59366) moldaram este arquivo:

1. ``registry.dispatch`` ECOA o texto da exceção de volta ao modelo —
   ``tools/registry.py:857-866`` monta ``f"Tool execution failed: {type(e).__name__}: {e}"``.
   Por isso nenhum caminho aqui deixa exceção escapar do handler, e nenhuma
   mensagem de exceção deste módulo contém payload: as recusas são CÓDIGOS
   fechados, montados a partir de constantes.
2. ``registry.register`` devolve ``None`` em silêncio quando a ferramenta
   colidiria com outro toolset — ``tools/registry.py:676-682`` só loga
   ``Tool registration REJECTED``. Um bootstrap que confia no retorno seguiria
   para o ``ready`` com uma tool a menos. Por isso checamos ``get_entry`` ANTES
   (colisão) e DEPOIS (registro efetivamente aceito).
3. O handler recebe ``task_id``, ``session_id`` e ``user_task`` como keywords —
   ``model_tools.py:817-826``. ``tool_call_id``, ``turn_id`` e ``api_request_id``
   **não chegam**, então nada aqui pode depender deles para idempotência.

``session_id`` é aceito e repassado como DIAGNÓSTICO, nunca como autoridade: o
Hermes rotaciona a sessão ao comprimir contexto
(``agent/conversation_compression.py:3012``), e exigir a sessão inicial
quebraria chamadas legítimas depois da primeira compressão (§6.5.3).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Final, Mapping, Protocol, Sequence

from .binding import WorkerBinding
from .canonical_json import canonical_byte_length, canonical_json_stringify
from .protocol import WIRE_LIMITS

__all__ = [
    "BridgeOutcome",
    "BridgeUnavailable",
    "ToolBridge",
    "ToolRegistrationError",
    "ToolSpec",
    "ToolSpecError",
    "make_handler",
    "register_bridge_tools",
    "tool_schema_digest",
]

#: Toolset próprio. Resolvido dinamicamente pelo Hermes (``toolsets.py:400-441``),
#: sem editar ``TOOLSETS`` nem instalar plugin no perfil pessoal (§6.5.1).
BRIDGE_TOOLSET: Final[str] = "maia_bridge_v1"

#: Códigos de recusa que o handler pode devolver ao modelo. Fechado de propósito:
#: o modelo nunca recebe texto livre nosso, e o supervisor nunca precisa
#: interpretar uma frase para saber o que aconteceu.
_HANDLER_ERROR_CODES: Final[frozenset[str]] = frozenset(
    {
        "invalid_runtime_binding",
        "tool_not_allowed",
        "invalid_arguments",
        "bridge_unavailable",
        "bridge_error",
        "result_too_large",
        "run_not_authorized",
        "payload_conflict",
        "budget_exhausted",
        "effect_unknown",
        "protocol_error",
    }
)

_JSON_SCHEMA_TYPES: Final[dict[str, tuple[type, ...] | None]] = {
    "string": (str,),
    "boolean": (bool,),
    "object": (dict,),
    "array": (list,),
    "number": (int, float),
    "integer": (int,),
    "null": None,
}


class ToolSpecError(ValueError):
    """Entrada de manifest que não descreve uma ferramenta utilizável."""


class ToolRegistrationError(RuntimeError):
    """Registro impossível ou rejeitado pelo registry — nunca "seguir sem"."""


class BridgeUnavailable(RuntimeError):
    """Canal IPC indisponível. Erro fechado; jamais cair para outro backend."""


@dataclass(frozen=True, slots=True)
class BridgeOutcome:
    """Desfecho de uma chamada ao broker da Maia."""

    #: ``None`` quando ``refusal_code`` está preenchido.
    result: Any = None
    refusal_code: str | None = None

    @property
    def refused(self) -> bool:
        return self.refusal_code is not None


class ToolBridge(Protocol):
    """Contrato mínimo do cliente IPC visto pelo handler."""

    def invoke(
        self, name: str, args: Mapping[str, Any], *, observed_session_id: str | None
    ) -> BridgeOutcome:
        """Chama o broker. Gera ``call_seq`` UMA vez e o reusa em retry de transporte."""

    def is_available(self) -> bool:
        """Disponibilidade do canal — NÃO é autenticação nem revogação (§6.5.2)."""


@dataclass(frozen=True, slots=True)
class ToolSpec:
    """Uma ferramenta da projeção do manifest, em forma realmente imutável.

    O ``input_schema`` é guardado como STRING canônica, não como ``dict``: um
    dict aninhado dentro de um ``frozen=True`` continua editável por dentro, e
    este objeto é capturado por closures que decidem autorização.
    """

    name: str
    input_schema_json: str
    allowed_arg_names: tuple[str, ...]
    required_arg_names: tuple[str, ...]
    arg_types: tuple[tuple[str, str], ...]
    result_limit_chars: int
    description: str = ""

    @classmethod
    def from_projection(cls, entry: Mapping[str, Any]) -> "ToolSpec":
        """Constrói a partir de uma entrada de ``manifest.tools`` do frame ``start``."""
        name = entry.get("name")
        schema = entry.get("input_schema")
        limit = entry.get("result_limit_chars")
        if not isinstance(name, str) or not name:
            raise ToolSpecError("tool sem nome")
        if not isinstance(schema, dict):
            raise ToolSpecError(f"input_schema de {name} precisa ser objeto")
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
            raise ToolSpecError(f"result_limit_chars de {name} precisa ser inteiro > 0")
        if schema.get("type") != "object":
            raise ToolSpecError(f"input_schema de {name} precisa ser type=object")
        # Fail-closed: um schema que admite campo extra é um schema que deixa o
        # modelo anexar `tenant_id`/`approved` aos args (§6.5.3).
        if schema.get("additionalProperties") is not False:
            raise ToolSpecError(
                f"input_schema de {name} precisa ter additionalProperties=false"
            )
        properties = schema.get("properties", {})
        if not isinstance(properties, dict):
            raise ToolSpecError(f"properties de {name} precisa ser objeto")
        required = schema.get("required", [])
        if not isinstance(required, list) or any(
            not isinstance(item, str) for item in required
        ):
            raise ToolSpecError(f"required de {name} precisa ser lista de strings")
        missing = [item for item in required if item not in properties]
        if missing:
            raise ToolSpecError(f"required de {name} cita campo inexistente")

        arg_types: list[tuple[str, str]] = []
        for prop_name, prop_schema in properties.items():
            declared = (
                prop_schema.get("type") if isinstance(prop_schema, dict) else None
            )
            if isinstance(declared, str):
                if declared not in _JSON_SCHEMA_TYPES:
                    raise ToolSpecError(f"tipo desconhecido em {name}.{prop_name}")
                arg_types.append((prop_name, declared))

        description = schema.get("description")
        return cls(
            name=name,
            input_schema_json=canonical_json_stringify(schema),
            allowed_arg_names=tuple(properties.keys()),
            required_arg_names=tuple(required),
            arg_types=tuple(arg_types),
            result_limit_chars=limit,
            description=description if isinstance(description, str) else "",
        )

    def input_schema(self) -> dict[str, Any]:
        """Cópia nova do schema a cada chamada — o original é a string imutável."""
        return json.loads(self.input_schema_json)

    def registry_schema(self) -> dict[str, Any]:
        """Schema INTERNO esperado por ``registry.register`` (§6.5.1).

        O envelope OpenAI (``{"type":"function","function":…}``) é montado pelo
        próprio Hermes em ``get_definitions`` (``tools/registry.py:792-819``);
        mandar o envelope aqui produziria uma tool aninhada duas vezes.
        """
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.input_schema(),
        }


def tool_schema_digest(specs: Sequence[ToolSpec]) -> str:
    """Digest da superfície registrada, para o ``ready`` (§6.4.2).

    DECISÃO DESTE PACOTE, não herdada do TS: a projeção é ordenada por nome e
    reduzida a ``{name, input_schema, result_limit_chars}`` antes do digest, para
    que a ordem em que a Maia listou as tools não mude o valor. O supervisor
    precisa calcular do MESMO jeito quando for comparar (ver README).
    """
    from .canonical_json import canonical_digest

    projection = [
        {
            "name": spec.name,
            "input_schema": spec.input_schema(),
            "result_limit_chars": spec.result_limit_chars,
        }
        for spec in sorted(specs, key=lambda spec: spec.name)
    ]
    return canonical_digest(projection)


def _closed_error(code: str) -> str:
    """Erro fechado em JSON. ``code`` vem sempre de constante, nunca de payload."""
    if code not in _HANDLER_ERROR_CODES:
        code = "protocol_error"
    return json.dumps({"error": code}, ensure_ascii=False, separators=(",", ":"))


class _ArgsRejected(Exception):
    """Args recusados. A mensagem carrega só o NOME do campo, nunca o valor."""


def validate_args(spec: ToolSpec, args: Any) -> dict[str, Any]:
    """Valida os args do modelo contra o schema do manifest.

    Campos extras são RECUSADOS (não removidos): remover silenciosamente ensina
    o modelo que mandar ``tenant_id`` é inofensivo, e transforma um sinal de
    ataque em ruído.
    """
    if not isinstance(args, dict):
        raise _ArgsRejected("args precisa ser objeto")
    for key in args:
        if not isinstance(key, str):
            raise _ArgsRejected("chave de args precisa ser string")
        if key not in spec.allowed_arg_names:
            raise _ArgsRejected("campo não declarado no schema")
    for required in spec.required_arg_names:
        if required not in args:
            raise _ArgsRejected(f"campo obrigatório ausente: {required}")
    for arg_name, declared in spec.arg_types:
        if arg_name not in args:
            continue
        value = args[arg_name]
        expected = _JSON_SCHEMA_TYPES[declared]
        if expected is None:
            if value is not None:
                raise _ArgsRejected(f"tipo inválido em {arg_name}")
            continue
        if declared in ("number", "integer") and isinstance(value, bool):
            raise _ArgsRejected(f"tipo inválido em {arg_name}")
        if declared == "boolean" and not isinstance(value, bool):
            raise _ArgsRejected(f"tipo inválido em {arg_name}")
        if not isinstance(value, expected):
            raise _ArgsRejected(f"tipo inválido em {arg_name}")
    try:
        size = canonical_byte_length(args)
    except Exception as exc:  # canonicalização falhou: fora do domínio JSON
        raise _ArgsRejected("args fora do domínio JSON") from exc
    if size > WIRE_LIMITS.max_tool_payload_bytes:
        raise _ArgsRejected("args acima do teto de payload")
    return dict(args)


class _ResultRejected(Exception):
    """Resultado recusado. Nunca truncado: um resultado cortado mente ao modelo."""


def validate_model_result(spec: ToolSpec, result: Any) -> str:
    """Serializa o resultado para o modelo, limitado pelo manifest.

    Usa a forma CANÔNICA para que a mesma resposta lógica produza sempre os
    mesmos bytes — o que torna auditoria e comparação de retry possíveis.
    """
    try:
        payload = canonical_json_stringify(result)
    except Exception as exc:
        raise _ResultRejected("resultado fora do domínio JSON") from exc
    if len(payload) > spec.result_limit_chars:
        raise _ResultRejected("resultado acima do limite do manifest")
    if len(payload.encode("utf-8")) > WIRE_LIMITS.max_tool_payload_bytes:
        raise _ResultRejected("resultado acima do teto de payload")
    return payload


def make_handler(
    spec: ToolSpec, binding: WorkerBinding, bridge: ToolBridge
) -> Callable[..., str]:
    """Closure do §6.5.2: captura spec/binding imutáveis e o cliente IPC.

    A assinatura absorve ``**_runtime_kwargs`` porque o Hermes acrescenta
    ``user_task`` (e pode acrescentar outros) ao despachar
    (``model_tools.py:817-826``); um handler estrito quebraria o turno inteiro
    por um keyword novo.
    """

    def handler(
        args: Any,
        *,
        task_id: str | None = None,
        session_id: str | None = None,
        **_runtime_kwargs: Any,
    ) -> str:
        # Tripwire de execução: `task_id` é estabelecido por quem chamou
        # `run_conversation`, não por `args` (§6.5.3).
        if task_id != binding.task_id:
            return _closed_error("invalid_runtime_binding")
        if not binding.allows(spec.name):
            return _closed_error("tool_not_allowed")

        try:
            checked = validate_args(spec, args)
        except _ArgsRejected:
            return _closed_error("invalid_arguments")

        try:
            outcome = bridge.invoke(
                spec.name, checked, observed_session_id=session_id
            )
        except BridgeUnavailable:
            return _closed_error("bridge_unavailable")
        except Exception:
            # Nenhuma exceção sobe daqui: o registry ecoaria o texto ao modelo.
            return _closed_error("bridge_error")

        if outcome.refused:
            return _closed_error(outcome.refusal_code or "protocol_error")

        try:
            return validate_model_result(spec, outcome.result)
        except _ResultRejected:
            return _closed_error("result_too_large")

    handler.__name__ = f"maia_bridge_handler_{spec.name}"
    return handler


def register_bridge_tools(
    registry: Any,
    specs: Sequence[ToolSpec],
    binding: WorkerBinding,
    bridge: ToolBridge,
    *,
    result_limit_chars: int,
    toolset: str = BRIDGE_TOOLSET,
) -> tuple[str, ...]:
    """Registra as tools da execução. Falha ALTO em colisão ou rejeição silenciosa."""
    registered: list[str] = []
    for spec in specs:
        if not binding.allows(spec.name):
            raise ToolRegistrationError(
                f"tool fora do binding não se registra: {spec.name}"
            )
        if registry.get_entry(spec.name) is not None:
            raise ToolRegistrationError("tool_name_collision")

        registry.register(
            name=spec.name,
            toolset=toolset,
            schema=spec.registry_schema(),
            handler=make_handler(spec, binding, bridge),
            check_fn=bridge.is_available,
            requires_env=[],
            is_async=False,
            override=False,
            max_result_size_chars=min(spec.result_limit_chars, result_limit_chars),
        )
        # `register` devolve None em silêncio quando rejeita
        # (tools/registry.py:676-682): a única prova de registro é reler.
        if registry.get_entry(spec.name) is None:
            raise ToolRegistrationError(f"registro rejeitado pelo registry: {spec.name}")
        registered.append(spec.name)
    return tuple(registered)
