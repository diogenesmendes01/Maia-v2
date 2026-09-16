"""``WorkerBinding``: imutável de verdade e sem autoridade comercial (spec §6.4.1)."""

from __future__ import annotations

import dataclasses

import pytest

from hermes_worker.binding import WorkerBinding, WorkerBindingError

RUN_ID = "3f7c1f4e-6a1b-4c6d-9f1a-2b3c4d5e6f70"
DIGEST = "b" * 64


def _binding(**over) -> WorkerBinding:
    kwargs = {
        "execution_id": RUN_ID,
        "task_id": "task-3f7c1f4e",
        "initial_session_id": "sess-1",
        "manifest_digest": DIGEST,
        "allowed_tool_names": ("maia_fixture_echo",),
        "mode": "live",
    }
    kwargs.update(over)
    return WorkerBinding(**kwargs)


def test_binding_valido_expoe_allowlist_exata() -> None:
    binding = _binding()
    assert binding.allows("maia_fixture_echo")
    assert not binding.allows("maia_fixture_ECHO")
    assert not binding.allows("terminal")


def test_atributos_sao_imutaveis() -> None:
    binding = _binding()
    with pytest.raises(dataclasses.FrozenInstanceError):
        binding.task_id = "outro"  # type: ignore[misc]
    with pytest.raises(dataclasses.FrozenInstanceError):
        binding.allowed_tool_names = ()  # type: ignore[misc]


def test_slots_impede_campo_novo_em_runtime() -> None:
    """Sem ``__dict__`` não há como pendurar um ``tenant_id`` no binding depois.

    A EXCEÇÃO varia e por isso o teste não fixa a classe dela: em CPython
    3.12.10, atribuir um nome que NÃO é campo num dataclass
    ``frozen=True, slots=True`` levanta ``TypeError`` (o ``__setattr__`` gerado
    guarda a classe de ANTES da recriação por slots e o ``super()`` interno
    falha), enquanto atribuir um campo declarado levanta ``FrozenInstanceError``
    — como afirma o teste acima. O que importa aqui é a propriedade: a
    atribuição não acontece.
    """
    binding = _binding()
    with pytest.raises((AttributeError, TypeError)):
        binding.tenant_id = "primary"  # type: ignore[attr-defined]
    assert not hasattr(binding, "tenant_id")


def test_allowlist_precisa_ser_tupla() -> None:
    """Uma ``list`` continuaria editável por dentro apesar do ``frozen=True``."""
    with pytest.raises(WorkerBindingError):
        _binding(allowed_tool_names=["maia_fixture_echo"])


def test_allowlist_recusa_duplicata_e_vazio() -> None:
    with pytest.raises(WorkerBindingError):
        _binding(allowed_tool_names=("a", "a"))
    with pytest.raises(WorkerBindingError):
        _binding(allowed_tool_names=("",))


def test_campos_malformados_falham_alto() -> None:
    with pytest.raises(WorkerBindingError):
        _binding(execution_id="não-uuid")
    with pytest.raises(WorkerBindingError):
        _binding(manifest_digest="abc")
    with pytest.raises(WorkerBindingError):
        _binding(mode="producao")
    with pytest.raises(WorkerBindingError):
        _binding(task_id="")


def test_binding_nao_tem_campo_de_tenant_pessoa_ou_segredo() -> None:
    """§6.4.1: o filho não carrega autoridade comercial nem credencial."""
    campos = {campo.name for campo in dataclasses.fields(WorkerBinding)}
    proibidos = {
        "tenant_id",
        "agent_id",
        "pessoa_id",
        "conversa_id",
        "api_key",
        "token",
        "authorization",
        "claim_token",
        "grants",
    }
    assert campos.isdisjoint(proibidos)
    assert campos == {
        "execution_id",
        "task_id",
        "initial_session_id",
        "manifest_digest",
        "allowed_tool_names",
        "mode",
    }
