"""Handler da ponte: tripwire de binding, allowlist e silêncio sobre payload.

O teste mais importante deste arquivo é
``test_nenhuma_recusa_vaza_o_payload``. O motivo é concreto e foi verificado no
checkout pinado: ``ToolRegistry.dispatch`` captura qualquer exceção do handler e
devolve ``f"Tool execution failed: {type(e).__name__}: {e}"`` ao MODELO
(``tools/registry.py:857-866``). Uma validação que levante
``ValueError(f"cpf inválido: {args['cpf']}")`` acabou de mandar o CPF do cliente
para o provider de inferência.
"""

from __future__ import annotations

import json

import pytest

from hermes_worker.binding import WorkerBinding
from hermes_worker.bridge_tools import (
    BridgeOutcome,
    BridgeUnavailable,
    ToolRegistrationError,
    ToolSpec,
    ToolSpecError,
    make_handler,
    register_bridge_tools,
    tool_schema_digest,
)

RUN_ID = "3f7c1f4e-6a1b-4c6d-9f1a-2b3c4d5e6f70"
TASK_ID = "task-3f7c1f4e"
SEGREDO = "SALDO-SECRETO-4815162342"

ENTRADA = {
    "name": "maia_fixture_echo",
    "input_schema": {
        "type": "object",
        "properties": {"texto": {"type": "string"}},
        "required": ["texto"],
        "additionalProperties": False,
    },
    "result_limit_chars": 4096,
}


def _spec(**over) -> ToolSpec:
    entrada = {**ENTRADA, **over}
    return ToolSpec.from_projection(entrada)


def _binding(nomes=("maia_fixture_echo",)) -> WorkerBinding:
    return WorkerBinding(
        execution_id=RUN_ID,
        task_id=TASK_ID,
        initial_session_id="sess-1",
        manifest_digest="b" * 64,
        allowed_tool_names=nomes,
        mode="live",
    )


class BridgeFake:
    def __init__(self, outcome: BridgeOutcome | None = None, erro: Exception | None = None):
        self.outcome = outcome or BridgeOutcome(result={"ok": True})
        self.erro = erro
        self.chamadas: list[tuple[str, dict, str | None]] = []

    def invoke(self, name, args, *, observed_session_id):
        self.chamadas.append((name, dict(args), observed_session_id))
        if self.erro is not None:
            raise self.erro
        return self.outcome

    def is_available(self) -> bool:
        return True


# ─── binding e allowlist ────────────────────────────────────────────────────


def test_task_id_divergente_recusa_antes_de_tocar_o_bridge() -> None:
    bridge = BridgeFake()
    handler = make_handler(_spec(), _binding(), bridge)
    saida = handler({"texto": "oi"}, task_id="task-de-outro", session_id="sess-1")
    assert json.loads(saida) == {"error": "invalid_runtime_binding"}
    assert bridge.chamadas == []


def test_task_id_ausente_recusa() -> None:
    """``task_id`` vem do runtime, não de ``args``; ausência é divergência."""
    bridge = BridgeFake()
    handler = make_handler(_spec(), _binding(), bridge)
    assert json.loads(handler({"texto": "oi"}))["error"] == "invalid_runtime_binding"
    assert bridge.chamadas == []


def test_tool_fora_do_binding_recusa() -> None:
    bridge = BridgeFake()
    handler = make_handler(_spec(), _binding(nomes=("outra_tool",)), bridge)
    saida = handler({"texto": "oi"}, task_id=TASK_ID)
    assert json.loads(saida) == {"error": "tool_not_allowed"}
    assert bridge.chamadas == []


def test_args_com_task_id_embutido_nao_alteram_o_keyword_do_runtime() -> None:
    """§6.5.3: mesmo que ``args`` traga ``task_id``, quem manda é o keyword."""
    bridge = BridgeFake()
    handler = make_handler(_spec(), _binding(), bridge)
    saida = handler({"texto": "oi", "task_id": TASK_ID}, task_id="task-de-outro")
    assert json.loads(saida) == {"error": "invalid_runtime_binding"}


def test_sessao_rotacionada_nao_quebra_chamada_legitima() -> None:
    """Compressão troca ``agent.session_id``; a sessão é diagnóstico, não autoridade."""
    bridge = BridgeFake()
    handler = make_handler(_spec(), _binding(), bridge)
    saida = handler({"texto": "oi"}, task_id=TASK_ID, session_id="sess-99-depois-da-compressao")
    assert json.loads(saida) == {"ok": True}
    assert bridge.chamadas[0][2] == "sess-99-depois-da-compressao"


def test_handler_absorve_keywords_novos_do_runtime() -> None:
    """``_execute_tool`` acrescenta ``user_task``; um handler estrito quebraria o turno."""
    bridge = BridgeFake()
    handler = make_handler(_spec(), _binding(), bridge)
    saida = handler({"texto": "oi"}, task_id=TASK_ID, session_id="s", user_task="UT")
    assert json.loads(saida) == {"ok": True}


# ─── validação de args ──────────────────────────────────────────────────────


def test_campo_extra_e_recusado_nao_removido() -> None:
    bridge = BridgeFake()
    handler = make_handler(_spec(), _binding(), bridge)
    saida = handler({"texto": "oi", "tenant_id": "primary"}, task_id=TASK_ID)
    assert json.loads(saida) == {"error": "invalid_arguments"}
    assert bridge.chamadas == []


def test_campo_obrigatorio_ausente_e_tipo_errado_sao_recusados() -> None:
    handler = make_handler(_spec(), _binding(), BridgeFake())
    assert json.loads(handler({}, task_id=TASK_ID))["error"] == "invalid_arguments"
    assert json.loads(handler({"texto": 42}, task_id=TASK_ID))["error"] == "invalid_arguments"
    assert json.loads(handler("nao é objeto", task_id=TASK_ID))["error"] == "invalid_arguments"


def test_schema_aberto_e_recusado_no_carregamento_do_manifest() -> None:
    """``additionalProperties`` ausente deixaria o modelo anexar campo de autoridade."""
    aberto = {
        **ENTRADA,
        "input_schema": {"type": "object", "properties": {"texto": {"type": "string"}}},
    }
    with pytest.raises(ToolSpecError):
        ToolSpec.from_projection(aberto)


# ─── resultado ──────────────────────────────────────────────────────────────


def test_resultado_acima_do_limite_e_recusado_nao_truncado() -> None:
    bridge = BridgeFake(BridgeOutcome(result={"t": "x" * 5000}))
    handler = make_handler(_spec(), _binding(), bridge)
    saida = handler({"texto": "oi"}, task_id=TASK_ID)
    assert json.loads(saida) == {"error": "result_too_large"}
    assert "xxxx" not in saida


def test_recusa_do_broker_vira_codigo_fechado() -> None:
    bridge = BridgeFake(BridgeOutcome(refusal_code="budget_exhausted"))
    handler = make_handler(_spec(), _binding(), bridge)
    assert json.loads(handler({"texto": "oi"}, task_id=TASK_ID)) == {
        "error": "budget_exhausted"
    }


def test_codigo_de_recusa_desconhecido_e_normalizado() -> None:
    """O worker não repassa texto livre ao modelo, nem vindo do broker."""
    bridge = BridgeFake(BridgeOutcome(refusal_code="porque_sim"))
    handler = make_handler(_spec(), _binding(), bridge)
    assert json.loads(handler({"texto": "oi"}, task_id=TASK_ID)) == {
        "error": "protocol_error"
    }


def test_canal_indisponivel_devolve_erro_fechado_sem_fallback() -> None:
    bridge = BridgeFake(erro=BridgeUnavailable("pipe fechado"))
    handler = make_handler(_spec(), _binding(), bridge)
    assert json.loads(handler({"texto": "oi"}, task_id=TASK_ID)) == {
        "error": "bridge_unavailable"
    }


# ─── o teste que protege o cliente ──────────────────────────────────────────


def test_nenhuma_recusa_vaza_o_payload() -> None:
    """``registry.dispatch`` ecoa texto de exceção ao modelo — nada pode vazar.

    Cobre TODOS os caminhos de saída do handler, incluindo um bridge cuja
    própria exceção carrega o segredo.
    """
    spec = _spec()
    casos = [
        (BridgeFake(), {"texto": SEGREDO, "extra": SEGREDO}, TASK_ID),
        (BridgeFake(), {"texto": SEGREDO}, "task-de-outro"),
        (BridgeFake(erro=RuntimeError(f"falhou com {SEGREDO}")), {"texto": SEGREDO}, TASK_ID),
        (BridgeFake(erro=BridgeUnavailable(SEGREDO)), {"texto": SEGREDO}, TASK_ID),
        (BridgeFake(BridgeOutcome(result={"t": SEGREDO + "y" * 5000})), {"texto": SEGREDO}, TASK_ID),
        (BridgeFake(BridgeOutcome(refusal_code=SEGREDO)), {"texto": SEGREDO}, TASK_ID),
    ]
    for bridge, args, task_id in casos:
        handler = make_handler(spec, _binding(), bridge)
        saida = handler(args, task_id=task_id, session_id="sess-1")
        assert SEGREDO not in saida, saida
        # E o que sai continua sendo JSON fechado, não texto livre.
        assert set(json.loads(saida)) <= {"error", "ok", "t"}


def test_handler_nunca_levanta_excecao() -> None:
    """Exceção que escapa vira texto ecoado ao modelo; por isso nenhuma escapa."""

    class BridgeExplosivo:
        def invoke(self, name, args, *, observed_session_id):
            raise KeyError(SEGREDO)

        def is_available(self):
            return True

    handler = make_handler(_spec(), _binding(), BridgeExplosivo())
    saida = handler({"texto": "oi"}, task_id=TASK_ID)
    assert json.loads(saida) == {"error": "bridge_error"}


# ─── registro ───────────────────────────────────────────────────────────────


class RegistryFake:
    def __init__(self, *, aceita: bool = True, ocupado: tuple[str, ...] = ()):
        self.aceita = aceita
        self.entradas: dict[str, dict] = {nome: {"pre-existente": True} for nome in ocupado}
        self.chamadas: list[dict] = []

    def get_entry(self, name, *, scope=None):
        return self.entradas.get(name)

    def register(self, **kwargs):
        self.chamadas.append(kwargs)
        if self.aceita:
            self.entradas[kwargs["name"]] = kwargs
        # Igual ao Hermes: rejeição devolve None em silêncio.
        return None


def test_registro_feliz_usa_schema_interno_e_toolset_proprio() -> None:
    registry = RegistryFake()
    nomes = register_bridge_tools(
        registry, (_spec(),), _binding(), BridgeFake(), result_limit_chars=4096
    )
    assert nomes == ("maia_fixture_echo",)
    chamada = registry.chamadas[0]
    assert chamada["toolset"] == "maia_bridge_v1"
    assert chamada["override"] is False
    # Schema INTERNO: o envelope {"type":"function"} é montado pelo Hermes.
    assert set(chamada["schema"]) == {"name", "description", "parameters"}
    assert chamada["schema"]["parameters"]["type"] == "object"


def test_colisao_de_nome_falha_alto() -> None:
    registry = RegistryFake(ocupado=("maia_fixture_echo",))
    with pytest.raises(ToolRegistrationError, match="tool_name_collision"):
        register_bridge_tools(
            registry, (_spec(),), _binding(), BridgeFake(), result_limit_chars=4096
        )


def test_rejeicao_silenciosa_do_registry_e_detectada() -> None:
    """``register`` devolve ``None`` ao rejeitar (tools/registry.py:676-682).

    Sem reler ``get_entry``, o bootstrap seguiria para o ``ready`` com uma tool
    a menos e o modelo veria uma superfície diferente da que a Maia compilou.
    """
    registry = RegistryFake(aceita=False)
    with pytest.raises(ToolRegistrationError, match="rejeitado"):
        register_bridge_tools(
            registry, (_spec(),), _binding(), BridgeFake(), result_limit_chars=4096
        )


def test_tool_fora_do_binding_nao_se_registra() -> None:
    registry = RegistryFake()
    with pytest.raises(ToolRegistrationError):
        register_bridge_tools(
            registry,
            (_spec(),),
            _binding(nomes=("outra",)),
            BridgeFake(),
            result_limit_chars=4096,
        )
    assert registry.chamadas == []


def test_digest_da_superficie_independe_da_ordem_das_tools() -> None:
    outra = _spec(name="maia_fixture_outro")
    assert tool_schema_digest((_spec(), outra)) == tool_schema_digest((outra, _spec()))
    assert tool_schema_digest((_spec(),)) != tool_schema_digest((outra,))
