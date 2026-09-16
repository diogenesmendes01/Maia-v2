"""Limites do transporte: recusa determinística, nunca truncamento (spec §5.3.4, T07).

Os tetos aparecem em VALORES ABSOLUTOS aqui de propósito, pelo mesmo motivo
documentado no teste TypeScript: escrever ``"x" * WIRE_LIMITS.max_frame_bytes``
faria o payload crescer junto com a constante, e multiplicar o limite por 100
manteria a suíte verde. Um teste que se ajusta sozinho ao limite não testa o
limite.
"""

from __future__ import annotations

import pytest

from hermes_worker.canonical_json import js_json_stringify
from hermes_worker.protocol import (
    HERMES_WORKER_PROTOCOL_VERSION,
    WIRE_LIMITS,
    NdjsonFrameReader,
    WireLimitError,
    WireSerializeError,
    derive_call_id,
    parse_worker_frame,
    serialize_frame,
)

RUN_ID = "3f7c1f4e-6a1b-4c6d-9f1a-2b3c4d5e6f70"


def _tool_request(args: dict) -> str:
    return js_json_stringify(
        {
            "protocol": HERMES_WORKER_PROTOCOL_VERSION,
            "type": "tool.request",
            "run_id": RUN_ID,
            "call_seq": 0,
            "name": "maia_fixture_echo",
            "args": args,
            "observed_session_id": None,
        }
    )


def test_os_tetos_sao_os_valores_acordados_na_spec() -> None:
    assert WIRE_LIMITS.max_frame_bytes == 1_048_576
    assert WIRE_LIMITS.max_tool_payload_bytes == 262_144
    assert WIRE_LIMITS.max_json_depth == 32


def test_frame_acima_do_teto_de_bytes_e_recusado() -> None:
    parsed = parse_worker_frame(_tool_request({"texto": "x" * 2_000_000}))
    assert parsed.kind == "invalid"
    assert parsed.code == "too_large"


def test_args_acima_do_teto_de_payload_e_recusado() -> None:
    parsed = parse_worker_frame(_tool_request({"texto": "x" * 300_000}))
    assert parsed.kind == "invalid"
    assert parsed.code in ("too_large", "schema")


def test_json_mais_profundo_que_o_limite_e_recusado_antes_do_schema() -> None:
    profundo: object = "fim"
    for _ in range(WIRE_LIMITS.max_json_depth + 5):
        profundo = {"n": profundo}
    parsed = parse_worker_frame(_tool_request({"p": profundo}))
    assert parsed.kind == "invalid"
    assert parsed.code == "too_deep"


def test_serialize_recusa_emitir_acima_do_limite_em_vez_de_cortar() -> None:
    with pytest.raises(WireLimitError):
        serialize_frame(
            {
                "protocol": HERMES_WORKER_PROTOCOL_VERSION,
                "type": "tool.result",
                "run_id": RUN_ID,
                "call_seq": 0,
                "outcome": {
                    "kind": "result",
                    "result": {"texto": "y" * WIRE_LIMITS.max_tool_payload_bytes},
                    "is_error": False,
                },
            }
        )


def test_serialize_emite_exatamente_uma_linha_ndjson() -> None:
    linha = serialize_frame(
        {
            "protocol": HERMES_WORKER_PROTOCOL_VERSION,
            "type": "cancel",
            "run_id": RUN_ID,
            "reason": "operator",
            "grace_deadline_at": "2026-09-15T23:00:00.000Z",
        }
    )
    assert linha.endswith("\n")
    assert "\n" not in linha.rstrip("\n")


def test_serialize_recusa_frame_invalido_e_tipo_desconhecido() -> None:
    with pytest.raises(WireSerializeError):
        serialize_frame({"protocol": HERMES_WORKER_PROTOCOL_VERSION, "type": "inventado"})
    with pytest.raises(WireSerializeError):
        serialize_frame(
            {
                "protocol": HERMES_WORKER_PROTOCOL_VERSION,
                "type": "cancel",
                "run_id": "não-uuid",
                "reason": "operator",
                "grace_deadline_at": "2026-09-15T23:00:00.000Z",
            }
        )


def test_derive_call_id_falha_alto_em_entrada_malformada() -> None:
    assert derive_call_id(RUN_ID, 0) == f"{RUN_ID}:0"
    assert derive_call_id(RUN_ID, 7) == f"{RUN_ID}:7"
    for run_id, call_seq in ((RUN_ID, -1), ("não-uuid", 0), (RUN_ID, 10_001)):
        with pytest.raises(ValueError):
            derive_call_id(run_id, call_seq)


# ─── leitor incremental ─────────────────────────────────────────────────────


def test_leitor_entrega_frames_completos_por_pedaco() -> None:
    reader = NdjsonFrameReader("worker_to_maia")
    linha = _tool_request({"texto": "oi"}) + "\n"
    metade = len(linha) // 2
    assert reader.feed(linha[:metade].encode("utf-8")) == []
    frames = reader.feed(linha[metade:].encode("utf-8"))
    assert len(frames) == 1
    assert frames[0].kind == "ok"


def test_leitor_recusa_linha_gigante_sem_truncar_e_ressincroniza() -> None:
    """A linha gigante é DESCARTADA inteira; a próxima linha volta a valer.

    Entregar o começo de uma linha acima do teto seria oferecer ao schema um
    payload plausível fabricado pelo transporte.
    """
    reader = NdjsonFrameReader("worker_to_maia", max_frame_bytes=200)
    gigante = _tool_request({"texto": "x" * 500}) + "\n"
    boa = _tool_request({"texto": "oi"}) + "\n"

    resultados = reader.feed(gigante.encode("utf-8"))
    assert [r.code for r in resultados] == ["too_large"]
    # Nenhum frame parcial foi entregue junto com a recusa.
    assert all(r.kind == "invalid" for r in resultados)

    seguintes = reader.feed(boa.encode("utf-8"))
    assert len(seguintes) == 1
    assert seguintes[0].kind == "ok"


def test_leitor_trata_ultima_linha_sem_quebra() -> None:
    reader = NdjsonFrameReader("worker_to_maia")
    reader.feed(_tool_request({"texto": "oi"}).encode("utf-8"))
    frames = reader.close()
    assert len(frames) == 1
    assert frames[0].kind == "ok"


def test_leitor_nao_engasga_com_linha_vazia() -> None:
    reader = NdjsonFrameReader("worker_to_maia")
    frames = reader.feed(b"\n\n")
    assert [f.code for f in frames] == ["not_json", "not_json"]
