"""Precedência da projeção de saída (spec §6.8).

O caso que justifica o arquivo inteiro é
``test_completed_true_com_interrupted_true_nao_vira_resposta``: o ``completed``
do finalizador é ``final_response is not None and not failed and api_call_count <
max_iterations`` (``agent/turn_finalizer.py``) e **não testa ``interrupted``**.
Um turno cancelado no meio volta com ``completed=True`` e texto. Sem a
precedência, a Maia entregaria ao cliente a fala de um turno já revogado.
"""

from __future__ import annotations

from hermes_worker.result_projection import (
    project_observed,
    project_stop,
    project_usage,
)


def _resultado(**over) -> dict:
    base = {
        "final_response": "resposta candidata",
        "completed": True,
        "failed": False,
        "partial": False,
        "interrupted": False,
        "api_calls": 2,
    }
    base.update(over)
    return base


# ─── precedência ────────────────────────────────────────────────────────────


def test_completed_true_com_interrupted_true_nao_vira_resposta() -> None:
    stop = project_stop(_resultado(interrupted=True), max_iterations=5)
    assert stop == {"kind": "cancelled", "reason": "shutdown"}


def test_cancelamento_autoritativo_vence_ate_resultado_completo() -> None:
    stop = project_stop(_resultado(), cancel_reason="ownership_lost", max_iterations=5)
    assert stop == {"kind": "cancelled", "reason": "ownership_lost"}


def test_deadline_vira_failed_com_codigo_exato() -> None:
    """O conjunto fechado de ``cancelled`` não tem ``deadline``; o de ``failed`` tem."""
    stop = project_stop(_resultado(), cancel_reason="deadline", max_iterations=5)
    assert stop == {"kind": "failed", "code": "deadline_exceeded"}


def test_policy_vira_cancelled_operator() -> None:
    stop = project_stop(_resultado(), cancel_reason="policy", max_iterations=5)
    assert stop == {"kind": "cancelled", "reason": "operator"}


def test_cancel_reason_desconhecido_nao_vira_resposta() -> None:
    stop = project_stop(_resultado(), cancel_reason="inventado", max_iterations=5)
    assert stop == {"kind": "failed", "code": "protocol_error"}


def test_failed_vence_texto_presente() -> None:
    stop = project_stop(_resultado(failed=True), max_iterations=5)
    assert stop == {"kind": "failed", "code": "reasoner_failed"}


def test_partial_e_falha_de_turno() -> None:
    """``_partial_exit`` carimba failure "truncated": não é silêncio, é falha."""
    stop = project_stop(
        {"final_response": "meia", "completed": False, "partial": True, "api_calls": 1},
        max_iterations=5,
    )
    assert stop == {"kind": "failed", "code": "reasoner_failed"}


def test_ausencia_de_failed_nao_e_sucesso() -> None:
    """Retornos antecipados trazem menos campos; ausência não vira ``completed``."""
    stop = project_stop({"final_response": "texto", "api_calls": 1}, max_iterations=5)
    assert stop["kind"] == "no_reply"


def test_teto_de_iteracoes_distingue_o_motivo_do_silencio() -> None:
    assert project_stop({"completed": False, "api_calls": 5}, max_iterations=5) == {
        "kind": "no_reply",
        "reason": "iteration_cap",
    }
    assert project_stop({"completed": False, "api_calls": 1}, max_iterations=5) == {
        "kind": "no_reply",
        "reason": "empty_final_text",
    }


def test_resultado_ausente_e_falha_nao_silencio() -> None:
    assert project_stop(None) == {"kind": "failed", "code": "reasoner_failed"}


def test_texto_vazio_ou_so_espacos_e_no_reply() -> None:
    for texto in ("", "   \n\t "):
        stop = project_stop(_resultado(final_response=texto), max_iterations=5)
        assert stop == {"kind": "no_reply", "reason": "empty_final_text"}


def test_candidato_valido_vira_reply() -> None:
    stop = project_stop(_resultado(), max_iterations=5)
    assert stop == {"kind": "reply", "raw_text": "resposta candidata"}


def test_texto_absurdo_e_recusado_em_vez_de_cortado() -> None:
    stop = project_stop(_resultado(final_response="x" * 300_000), max_iterations=5)
    assert stop == {"kind": "failed", "code": "protocol_error"}


# ─── uso e rota observada ───────────────────────────────────────────────────


def test_usage_nunca_afirma_contabilidade_do_provider() -> None:
    usage = project_usage(_resultado(input_tokens=10, output_tokens=5))
    assert usage["source"] == "engine_reported"
    assert usage["input_tokens"] == 10
    assert usage["output_tokens"] == 5


def test_usage_sem_contador_e_unavailable() -> None:
    assert project_usage(_resultado())["source"] == "unavailable"
    assert project_usage(None)["source"] == "unavailable"


def test_custo_vai_em_micro_usd_como_string_inteira() -> None:
    """Dinheiro nunca em float no wire (§5.3.1)."""
    usage = project_usage(_resultado(estimated_cost_usd=0.001234))
    assert usage["cost_microusd"] == "1234"
    assert isinstance(usage["cost_microusd"], str)


def test_custo_invalido_vira_none() -> None:
    for valor in (None, -1.0, "caro", float("nan")):
        assert project_usage(_resultado(estimated_cost_usd=valor))["cost_microusd"] is None


def test_observed_nao_exporta_raciocinio_nem_host_interno() -> None:
    observed = project_observed(
        _resultado(
            model="stub-model",
            provider="openai_compatible",
            session_id="sess-2",
            base_url="http://interno:8099/v1",
            last_reasoning="cadeia de pensamento",
            pre_transform_response="rascunho",
        )
    )
    assert set(observed) == {
        "model",
        "provider",
        "final_session_id",
        "turn_exit_reason",
        "failure_code",
    }
    assert "http://interno:8099/v1" not in str(observed)
    assert "cadeia de pensamento" not in str(observed)


def test_sessao_final_pode_divergir_da_inicial() -> None:
    """Rotação por compressão é alias de auditoria, não erro."""
    observed = project_observed(_resultado(session_id="sess-depois-da-compressao"))
    assert observed["final_session_id"] == "sess-depois-da-compressao"


def test_codigo_longo_demais_vira_none_em_vez_de_cortado() -> None:
    observed = project_observed(_resultado(turn_exit_reason="x" * 200))
    assert observed["turn_exit_reason"] is None
