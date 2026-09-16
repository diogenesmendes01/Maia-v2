"""Bootstrap: home efêmero, config.yaml e superfície efetiva (spec §6.6, §6.7).

Nada aqui importa o Hermes — e um dos testes AFIRMA isso. A ordem do §6.7.2 só
funciona se os imports do motor acontecerem depois de os descritores e o home
estarem fixados; um import no topo de ``main.py`` criaria ``state.db``,
``SOUL.md`` e ``memories/`` no perfil pessoal de quem apenas importou o módulo.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from hermes_worker import main as worker_main
from hermes_worker.main import (
    BootstrapError,
    SurfaceMismatch,
    build_agent_kwargs,
    inventory_home,
    render_worker_config,
    require_ephemeral_home,
    verify_effective_surface,
)

RUN_ID = "3f7c1f4e-6a1b-4c6d-9f1a-2b3c4d5e6f70"

# Parâmetros REAIS de ``AIAgent.__init__`` (run_agent.py:233-280) no SHA
# 5d59366. Fixados aqui para que um keyword inventado falhe no teste em vez de
# virar ``TypeError`` só quando alguém tiver o motor instalado.
PARAMETROS_AIAGENT = {
    "base_url", "api_key", "provider", "api_mode", "acp_command", "acp_args",
    "command", "args", "model", "max_iterations", "tool_delay", "enabled_toolsets",
    "disabled_toolsets", "save_trajectories", "verbose_logging", "quiet_mode",
    "tool_progress_mode", "ephemeral_system_prompt", "log_prefix_chars", "log_prefix",
    "providers_allowed", "providers_ignored", "providers_order", "provider_sort",
    "provider_require_parameters", "provider_data_collection",
    "openrouter_min_coding_score", "session_id", "tool_progress_callback",
    "tool_start_callback", "tool_complete_callback", "thinking_callback",
    "reasoning_callback", "clarify_callback", "read_terminal_callback",
    "read_preview_callback", "drive_preview_callback", "read_window_below_callback",
    "connection_callback", "tour_callback", "step_callback", "stream_delta_callback",
    "interim_assistant_callback", "tool_gen_callback", "status_callback",
    "notice_callback", "notice_clear_callback", "event_callback", "reaction_callback",
    "max_tokens", "reasoning_config", "service_tier", "request_overrides",
    "prefill_messages", "platform", "user_id", "user_id_alt", "user_name", "chat_id",
    "chat_name", "chat_type", "thread_id", "gateway_session_key", "skip_context_files",
    "load_soul_identity", "skip_memory", "skip_background_review", "session_db",
    "parent_session_id", "iteration_budget", "run_budget_seconds", "fallback_model",
    "credential_pool", "checkpoints_enabled", "checkpoint_max_snapshots",
    "checkpoint_max_total_size_mb", "checkpoint_max_file_size_mb", "pass_session_id",
    "requested_provider", "capabilities",
}

START = {
    "protocol": "maia.hermes.worker.v1",
    "type": "start",
    "run_id": RUN_ID,
    "request_key": "8a1e2c3d-4b5a-4c7d-8e9f-0a1b2c3d4e5f",
    "binding": {
        "execution_id": RUN_ID,
        "task_id": "task-3f7c1f4e",
        "initial_session_id": "sess-1",
        "manifest_digest": "b" * 64,
        "mode": "live",
    },
    "manifest": {
        "schema": "maia-hermes-runtime-manifest/v1",
        "tools": [],
        "result_limit_chars": 4096,
    },
    "context": {
        "system": "instruções aprovadas",
        "user_message": "qual o saldo?",
        "history": [{"role": "user", "text": "oi"}, {"role": "assistant", "text": "olá"}],
    },
    "limits": {
        "max_iterations": 5,
        "max_output_tokens_per_call": 1024,
        "max_tool_calls": 4,
        "max_inference_calls": 8,
        "run_budget_seconds": 60,
        "deadline_at": "2026-09-15T23:00:00.000Z",
    },
    "inference": {
        "base_url": "http://127.0.0.1:8099/internal/hermes-inference/v1",
        "model": "stub-model",
        "provider": "openai_compatible",
        "api_mode": "chat_completions",
    },
}


class _BindingFake:
    task_id = "task-3f7c1f4e"
    initial_session_id = "sess-1"


# ─── importar o worker não toca no Hermes ───────────────────────────────────


def test_importar_main_nao_importa_hermes() -> None:
    """Se isto falhar, o simples import já escreveu no home de alguém."""
    for modulo in ("run_agent", "tools.registry", "model_tools", "agent.agent_init"):
        assert modulo not in sys.modules


# ─── home efêmero ───────────────────────────────────────────────────────────


def test_home_ausente_ou_vazio_e_recusado() -> None:
    for env in ({}, {"HERMES_HOME": "   "}):
        with pytest.raises(BootstrapError, match="HERMES_HOME"):
            require_ephemeral_home(env, platform="win32")


def test_home_relativo_e_recusado() -> None:
    with pytest.raises(BootstrapError, match="absoluto"):
        require_ephemeral_home({"HERMES_HOME": "home-relativo"}, platform="win32")


def test_home_igual_ao_perfil_pessoal_e_recusado(tmp_path: Path) -> None:
    """``%LOCALAPPDATA%\\hermes`` é o perfil do Hermes Desktop — proibido."""
    local_appdata = tmp_path / "AppData" / "Local"
    pessoal = local_appdata / "hermes"
    pessoal.mkdir(parents=True)
    with pytest.raises(BootstrapError, match="perfil pessoal"):
        require_ephemeral_home(
            {"HERMES_HOME": str(pessoal), "LOCALAPPDATA": str(local_appdata)},
            platform="win32",
        )


def test_home_dentro_do_perfil_pessoal_e_recusado(tmp_path: Path) -> None:
    local_appdata = tmp_path / "AppData" / "Local"
    dentro = local_appdata / "hermes" / "efemero"
    dentro.mkdir(parents=True)
    with pytest.raises(BootstrapError, match="perfil pessoal"):
        require_ephemeral_home(
            {"HERMES_HOME": str(dentro), "LOCALAPPDATA": str(local_appdata)},
            platform="win32",
        )


def test_home_posix_pessoal_e_recusado(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    pessoal = tmp_path / ".hermes"
    pessoal.mkdir()
    with pytest.raises(BootstrapError, match="perfil pessoal"):
        require_ephemeral_home({"HERMES_HOME": str(pessoal)}, platform="linux")


def test_home_existente_com_conteudo_e_recusado(tmp_path: Path) -> None:
    """Home reaproveitado carrega sessão, memória e SOUL.md de outra execução."""
    home = tmp_path / "home"
    home.mkdir()
    (home / "state.db").write_text("resto de outra execução", encoding="utf-8")
    with pytest.raises(BootstrapError, match="VAZIO"):
        require_ephemeral_home(
            {"HERMES_HOME": str(home), "LOCALAPPDATA": str(tmp_path / "AppData")},
            platform="win32",
        )


def test_home_novo_e_criado(tmp_path: Path) -> None:
    home = tmp_path / "novo" / "home"
    devolvido = require_ephemeral_home(
        {"HERMES_HOME": str(home), "LOCALAPPDATA": str(tmp_path / "AppData")},
        platform="win32",
    )
    assert devolvido == home
    assert home.is_dir()


# ─── config.yaml ────────────────────────────────────────────────────────────


def test_config_fixa_contexto_e_desliga_tool_search() -> None:
    texto = render_worker_config(context_length=200_000)
    assert "context_length: 200000" in texto
    # ASPAS obrigatórias: `off` sem aspas é booleano em YAML 1.1, e a chave
    # precisa da STRING "off" (tools/tool_search.py:64, _tri_state).
    assert 'enabled: "off"' in texto
    assert "memory_enabled: false" in texto
    assert "user_profile_enabled: false" in texto
    assert "engine: \"compressor\"" in texto
    assert "mcp_servers: {}" in texto


def test_config_recusa_contexto_abaixo_do_piso_do_hermes() -> None:
    """Abaixo de 64.000 o próprio construtor levanta ValueError."""
    for ruim in (0, 1024, 63_999, "200000", None):
        with pytest.raises(BootstrapError):
            render_worker_config(context_length=ruim)  # type: ignore[arg-type]


# ─── kwargs do AIAgent ──────────────────────────────────────────────────────


def test_kwargs_usam_somente_parametros_reais_do_aiagent() -> None:
    kwargs = build_agent_kwargs(START, _BindingFake(), api_key=None)
    desconhecidos = set(kwargs) - PARAMETROS_AIAGENT
    assert desconhecidos == set()


def test_kwargs_fixam_limites_finitos_e_isolamento() -> None:
    kwargs = build_agent_kwargs(START, _BindingFake(), api_key="chave-de-transporte")
    assert kwargs["max_iterations"] == 5  # nunca o default sys.maxsize
    assert kwargs["max_tokens"] == 1024
    assert kwargs["run_budget_seconds"] == 60
    assert kwargs["enabled_toolsets"] == ["maia_bridge_v1"]
    assert kwargs["skip_memory"] is True
    assert kwargs["skip_context_files"] is True
    assert kwargs["load_soul_identity"] is False
    assert kwargs["skip_background_review"] is True
    assert kwargs["save_trajectories"] is False
    assert kwargs["session_db"] is None
    assert kwargs["checkpoints_enabled"] is False
    assert kwargs["credential_pool"] is None
    assert kwargs["fallback_model"] is None
    assert kwargs["quiet_mode"] is True
    assert kwargs["session_id"] == "sess-1"
    assert kwargs["ephemeral_system_prompt"] == "instruções aprovadas"


def test_credencial_vem_do_ambiente_nunca_do_frame() -> None:
    """O schema do ``start`` recusa ``api_key``; o valor só pode vir do spawn."""
    assert "api_key" not in START["inference"]
    kwargs = build_agent_kwargs(START, _BindingFake(), api_key="sk-do-ambiente")
    assert kwargs["api_key"] == "sk-do-ambiente"
    assert build_agent_kwargs(START, _BindingFake(), api_key=None)["api_key"] is None


def test_historico_vira_texto_sem_blocos_de_tool() -> None:
    historico = worker_main._history(START)
    assert historico == [
        {"role": "user", "content": "oi"},
        {"role": "assistant", "content": "olá"},
    ]


# ─── superfície efetiva ─────────────────────────────────────────────────────


class _AgenteFake:
    def __init__(self, nomes, valid=None):
        self.tools = [{"type": "function", "function": {"name": n}} for n in nomes]
        self.valid_tool_names = set(nomes if valid is None else valid)


def test_superficie_igual_ao_manifest_passa() -> None:
    agente = _AgenteFake(["maia_fixture_echo"])
    assert verify_effective_surface(agente, ("maia_fixture_echo",)) == (
        "maia_fixture_echo",
    )


def test_bridge_de_tool_search_na_superficie_bloqueia_a_readiness() -> None:
    """O default ``auto`` troca as tools por tool_search/describe/call."""
    agente = _AgenteFake(["tool_search", "tool_describe", "tool_call"])
    with pytest.raises(SurfaceMismatch, match="extra"):
        verify_effective_surface(agente, ("maia_fixture_echo",))


def test_nome_extra_ou_ausente_bloqueia() -> None:
    with pytest.raises(SurfaceMismatch):
        verify_effective_surface(
            _AgenteFake(["maia_fixture_echo", "terminal"]), ("maia_fixture_echo",)
        )
    with pytest.raises(SurfaceMismatch):
        verify_effective_surface(_AgenteFake([]), ("maia_fixture_echo",))


def test_duplicata_bloqueia() -> None:
    with pytest.raises(SurfaceMismatch, match="duplicado"):
        verify_effective_surface(
            _AgenteFake(["maia_fixture_echo", "maia_fixture_echo"]),
            ("maia_fixture_echo",),
        )


def test_valid_tool_names_divergente_bloqueia() -> None:
    """Defesa de runtime do Hermes usa ``valid_tool_names``; divergir é drift."""
    agente = _AgenteFake(["maia_fixture_echo"], valid=["maia_fixture_echo", "terminal"])
    with pytest.raises(SurfaceMismatch, match="valid_tool_names"):
        verify_effective_surface(agente, ("maia_fixture_echo",))


# ─── inventário do home ─────────────────────────────────────────────────────


def test_inventario_lista_o_que_o_home_acumulou(tmp_path: Path) -> None:
    """``session_db=None`` não é zero persistência: o import já cria arquivos."""
    home = tmp_path / "home"
    (home / "sessions").mkdir(parents=True)
    (home / "state.db").write_bytes(b"x")
    (home / "sessions" / "a.json").write_text("{}", encoding="utf-8")

    inventario = inventory_home(home)
    assert "state.db" in inventario
    assert "sessions/" in inventario
    assert "sessions/a.json" in inventario


def test_inventario_de_home_inexistente_e_vazio(tmp_path: Path) -> None:
    assert inventory_home(tmp_path / "nao-existe") == ()
