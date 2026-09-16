"""P00.2 (spec §6.8) — projeção do resultado do turno para o frame ``result``.

O envelope normal do Hermes é montado em ``agent/turn_finalizer.py:550-579``. O
detalhe que obriga este módulo a existir está em como ``completed`` é calculado
lá: ``final_response is not None and not failed and api_call_count < max_iterations``.
**Ele não testa ``interrupted``.** Um turno cancelado no meio pode voltar com
``completed=True`` e texto. Projetar "tem texto → é resposta" entregaria ao
cliente a fala de um turno que a Maia já revogou.

Por isso a PRECEDÊNCIA do §6.8 é obrigatória e está escrita aqui numa função
pura, testável sem Hermes e sem rede:

    estado autoritativo (cancel recebido) → interrupted → failed →
    partial / completed is not True → só então candidato

Retornos antecipados trazem MENOS campos (``turn_tool_validation.py:53-68``
devolve seis chaves), então nada aqui exige a presença de um campo: ausência de
``failed`` não é sucesso.

Três traduções são decisões deste pacote, não do motor — estão no README:

- ``interrupted=True`` sem ``cancel`` da Maia vira ``cancelled/shutdown``. O
  contrato não tem "o motor se interrompeu sozinho", e inventar um ``reply``
  seria pior.
- ``cancel`` com ``reason=deadline`` vira ``failed/deadline_exceeded`` (o wire
  tem código exato); ``policy`` vira ``cancelled/operator`` (o conjunto fechado
  de ``cancelled`` não tem ``policy``).
- ``usage.source`` nunca é ``provider_accounted``: o worker não fala com o
  provider, ele reporta o que o motor contou.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Final, Mapping

from .protocol import WIRE_LIMITS

__all__ = [
    "CANCEL_REASON_TO_STOP",
    "project_observed",
    "project_stop",
    "project_usage",
]

#: Tradução das categorias de ``cancel`` (5 valores) para os desfechos do
#: ``result`` (``cancelled`` só admite 3). Ver README para o porquê de cada par.
CANCEL_REASON_TO_STOP: Final[dict[str, dict[str, str]]] = {
    "ownership_lost": {"kind": "cancelled", "reason": "ownership_lost"},
    "operator": {"kind": "cancelled", "reason": "operator"},
    "shutdown": {"kind": "cancelled", "reason": "shutdown"},
    "deadline": {"kind": "failed", "code": "deadline_exceeded"},
    "policy": {"kind": "cancelled", "reason": "operator"},
}


def project_stop(
    result: Mapping[str, Any] | None,
    *,
    cancel_reason: str | None = None,
    max_iterations: int | None = None,
) -> dict[str, Any]:
    """Desfecho deliberativo, com a precedência do §6.8. Função pura."""
    # 1. Estado autoritativo: a Maia já decidiu antes de o motor terminar.
    if cancel_reason is not None:
        stop = CANCEL_REASON_TO_STOP.get(cancel_reason)
        if stop is None:
            return {"kind": "failed", "code": "protocol_error"}
        return dict(stop)

    # O loop não devolveu envelope nenhum (exceção, morte da thread).
    if result is None:
        return {"kind": "failed", "code": "reasoner_failed"}

    # 2. `interrupted` ANTES de `completed` — `completed` não o testa.
    if result.get("interrupted") is True:
        return {"kind": "cancelled", "reason": "shutdown"}

    # 3. Falha declarada pelo motor.
    if result.get("failed") is True:
        return {"kind": "failed", "code": "reasoner_failed"}

    # 4. Parcial é falha de turno (`_partial_exit` carimba failure "truncated").
    if result.get("partial") is True:
        return {"kind": "failed", "code": "reasoner_failed"}

    if result.get("completed") is not True:
        return {"kind": "no_reply", "reason": _no_reply_reason(result, max_iterations)}

    # 5. Só agora o texto pode ser candidato.
    text = result.get("final_response")
    if isinstance(text, str) and text.strip():
        if len(text) > WIRE_LIMITS.max_text_chars:
            # Recusar, nunca cortar: metade de uma resposta é uma resposta nova.
            return {"kind": "failed", "code": "protocol_error"}
        return {"kind": "reply", "raw_text": text}
    return {"kind": "no_reply", "reason": "empty_final_text"}


def _no_reply_reason(result: Mapping[str, Any], max_iterations: int | None) -> str:
    api_calls = result.get("api_calls")
    if (
        max_iterations is not None
        and isinstance(api_calls, int)
        and not isinstance(api_calls, bool)
        and api_calls >= max_iterations
    ):
        return "iteration_cap"
    return "empty_final_text"


def _non_negative_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if value >= 0 else None


def _micro_usd(value: Any) -> str | None:
    """Custo em micro-USD como STRING decimal — dinheiro nunca viaja em float."""
    if value is None or isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    # NaN/Infinity atravessam o `Decimal` intactos e só estouram na COMPARAÇÃO
    # lá embaixo (`InvalidOperation`). Recusar aqui é o que mantém a projeção
    # uma função total: custo que não é número vira `None`, não exceção no meio
    # da montagem do frame terminal.
    if isinstance(value, float) and (
        value != value or value in (float("inf"), float("-inf"))
    ):
        return None
    try:
        micros = (Decimal(str(value)) * 1_000_000).quantize(
            Decimal(1), rounding=ROUND_HALF_UP
        )
    except (InvalidOperation, ValueError):
        return None
    if micros < 0:
        return None
    return str(int(micros))


def project_usage(result: Mapping[str, Any] | None) -> dict[str, Any]:
    """Contadores reportados pelo motor — não contabilidade fechada (§6.10).

    Com ``session_db=None`` o uso auxiliar (compressão, títulos) tem trilha
    própria e NÃO entra nestes acumuladores (``agent/aux_accounting.py:27-91``),
    então declarar ``provider_accounted`` aqui seria falso.
    """
    if result is None:
        return {
            "input_tokens": None,
            "output_tokens": None,
            "cost_microusd": None,
            "source": "unavailable",
        }
    input_tokens = _non_negative_int(result.get("input_tokens"))
    output_tokens = _non_negative_int(result.get("output_tokens"))
    cost = _micro_usd(result.get("estimated_cost_usd"))
    reported = any(item is not None for item in (input_tokens, output_tokens, cost))
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cost_microusd": cost,
        "source": "engine_reported" if reported else "unavailable",
    }


def _short_code(value: Any) -> str | None:
    """Campo diagnóstico curto: cabe no teto ou vira ``None``, nunca cortado."""
    if not isinstance(value, str) or not value:
        return None
    if len(value) > WIRE_LIMITS.max_error_code_chars:
        return None
    return value


def _bounded_text(value: Any, limit: int) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return value if len(value) <= limit else None


def project_observed(result: Mapping[str, Any] | None) -> dict[str, Any]:
    """Rota observada, para o supervisor confrontar com a seleção autorizada.

    ``last_reasoning``, ``pre_transform_response`` e ``base_url`` existem no
    envelope e NÃO entram aqui (§6.8): raciocínio bruto e host interno não saem
    do processo.
    """
    if result is None:
        return {
            "model": None,
            "provider": None,
            "final_session_id": None,
            "turn_exit_reason": None,
            "failure_code": None,
        }
    return {
        "model": _bounded_text(result.get("model"), 256),
        "provider": _bounded_text(result.get("provider"), 64),
        # Pode divergir da sessão inicial por compressão — é alias de auditoria.
        "final_session_id": _bounded_text(result.get("session_id"), 256),
        "turn_exit_reason": _short_code(result.get("turn_exit_reason")),
        "failure_code": _short_code(result.get("failure_reason")),
    }
