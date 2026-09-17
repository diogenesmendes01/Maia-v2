"""Paridade caso a caso com o TypeScript, pelas fixtures COMPARTILHADAS.

O contrato ``maia.hermes.worker.v1`` tem duas implementações: a do supervisor
(``src/integrations/hermes/protocol.ts``, exercitada por
``tests/unit/hermes-wire-contract.spec.ts``) e a deste worker. Elas leem o MESMO
arquivo de casos, ``tests/fixtures/hermes-wire/frames.json``.

É esse arquivo comum que impede a divergência silenciosa. Se um lado afrouxar um
schema, ele passa a aceitar um caso que o outro recusa — e o buraco aparece aqui,
não em produção. Por isso o teste afirma o CÓDIGO da recusa, não só o fato de
recusar: dois motivos diferentes para o mesmo "não" já seriam divergência.
"""

from __future__ import annotations

import json

import pytest
from conftest import WIRE_FIXTURES

from hermes_worker.canonical_json import js_json_stringify
from hermes_worker.protocol import (
    HERMES_WORKER_PROTOCOL_VERSION,
    parse_maia_frame,
    parse_worker_frame,
)

_FIXTURES = json.loads(WIRE_FIXTURES.read_text(encoding="utf-8"))
_CASOS = _FIXTURES["cases"]
_LINHAS_CRUAS = _FIXTURES["raw_line_cases"]


def _parser(direction: str):
    return parse_worker_frame if direction == "worker_to_maia" else parse_maia_frame


def test_versao_do_protocolo_da_fixture_e_a_do_modulo() -> None:
    assert _FIXTURES["protocol"] == HERMES_WORKER_PROTOCOL_VERSION


def test_ids_unicos_e_arquivo_nao_vazio() -> None:
    ids = [caso["id"] for caso in _CASOS + _LINHAS_CRUAS]
    assert len(ids) >= 15
    assert len(set(ids)) == len(ids)


@pytest.mark.parametrize("caso", _CASOS, ids=[caso["id"] for caso in _CASOS])
def test_fixture_de_frame(caso: dict) -> None:
    parsed = _parser(caso["direction"])(js_json_stringify(caso["frame"]))
    if caso["expect"] == "ok":
        assert parsed.kind == "ok", f"{caso['id']}: {parsed.code}: {parsed.detail}"
    else:
        assert parsed.kind == "invalid", caso["id"]
        assert parsed.code == caso["expect"], f"{caso['id']}: {parsed.detail}"


@pytest.mark.parametrize(
    "caso", _LINHAS_CRUAS, ids=[caso["id"] for caso in _LINHAS_CRUAS]
)
def test_fixture_de_linha_crua(caso: dict) -> None:
    parsed = _parser(caso["direction"])(caso["line"])
    assert parsed.kind == "invalid", caso["id"]
    assert parsed.code == caso["expect"], f"{caso['id']}: {parsed.detail}"


# ─── os mesmos casos que o TS exercita fora da fixture ──────────────────────

RUN_ID = "3f7c1f4e-6a1b-4c6d-9f1a-2b3c4d5e6f70"


def _tool_request(**over) -> str:
    frame = {
        "protocol": HERMES_WORKER_PROTOCOL_VERSION,
        "type": "tool.request",
        "run_id": RUN_ID,
        "call_seq": 0,
        "name": "fixture_echo",
        "args": {"texto": "oi"},
        "observed_session_id": None,
    }
    frame.update(over)
    return js_json_stringify(frame)


@pytest.mark.parametrize(
    "chave,valor",
    [
        ("tenant_id", "primary"),
        ("agent_id", "primary"),
        ("pessoa_id", RUN_ID),
        ("conversa_id", RUN_ID),
        ("claim_token", RUN_ID),
        ("approved", True),
        ("grants", ["all"]),
        ("dispatched", True),
        ("callback_url", "http://attacker.example/cb"),
    ],
)
def test_campo_de_autoridade_e_recusado_nao_ignorado(chave: str, valor: object) -> None:
    parsed = parse_worker_frame(_tool_request(**{chave: valor}))
    assert parsed.kind == "invalid"
    assert parsed.code == "schema"


def test_call_seq_comeca_em_zero_e_e_inteiro_nao_negativo() -> None:
    assert parse_worker_frame(_tool_request(call_seq=0)).kind == "ok"
    # `1.0` é inteiro para o JS: aceitar aqui também é o que mantém a paridade.
    assert parse_worker_frame(_tool_request(call_seq=1.0)).kind == "ok"
    for seq in (-1, 1.5, "0", None, 10_001):
        assert parse_worker_frame(_tool_request(call_seq=seq)).kind == "invalid"


def test_linhas_que_nao_sao_objeto_json_sao_recusadas_sem_lancar() -> None:
    for ruim in ("", "   ", "não é json", "[1,2,3]", '"texto"', "null", "42"):
        assert parse_worker_frame(ruim).kind == "invalid"


def test_nan_e_infinity_nao_sao_json() -> None:
    """O ``json`` do Python aceita esses literais por default; o ``JSON.parse`` não."""
    for literal in ("NaN", "Infinity", "-Infinity"):
        linha = (
            f'{{"protocol":"{HERMES_WORKER_PROTOCOL_VERSION}","type":"progress",'
            f'"run_id":"{RUN_ID}","seq":{literal},"event":"tool_start",'
            '"call_seq":0,"tool_name":null}'
        )
        parsed = parse_worker_frame(linha)
        assert parsed.kind == "invalid"
        assert parsed.code == "not_json"


def test_reply_so_com_espacos_nao_e_reply() -> None:
    def resultado(stop: dict) -> str:
        return js_json_stringify(
            {
                "protocol": HERMES_WORKER_PROTOCOL_VERSION,
                "type": "result",
                "run_id": RUN_ID,
                "request_key": "8a1e2c3d-4b5a-4c7d-8e9f-0a1b2c3d4e5f",
                "stop": stop,
                "iterations": 1,
                "observed_tool_call_seqs": [],
                "usage": {
                    "input_tokens": None,
                    "output_tokens": None,
                    "cost_microusd": None,
                    "source": "unavailable",
                },
                "observed": {
                    "model": None,
                    "provider": None,
                    "final_session_id": None,
                    "turn_exit_reason": None,
                    "failure_code": None,
                },
            }
        )

    assert parse_worker_frame(resultado({"kind": "reply", "raw_text": "ok"})).kind == "ok"
    for stop in (
        {"kind": "reply", "raw_text": ""},
        {"kind": "reply", "raw_text": "   \n\t "},
        {"kind": "no_reply", "reason": "porque sim"},
        {"kind": "failed", "code": "qualquer_coisa"},
        {"kind": "cancelled", "reason": "operator", "extra": 1},
        {"kind": "delivered"},
    ):
        assert parse_worker_frame(resultado(stop)).kind == "invalid"


def test_instante_iso_segue_o_regex_do_zod() -> None:
    def cancel(instante: str) -> str:
        return js_json_stringify(
            {
                "protocol": HERMES_WORKER_PROTOCOL_VERSION,
                "type": "cancel",
                "run_id": RUN_ID,
                "reason": "operator",
                "grace_deadline_at": instante,
            }
        )

    assert parse_maia_frame(cancel("2026-09-15T23:00:00.000Z")).kind == "ok"
    assert parse_maia_frame(cancel("2026-09-15T23:00:00Z")).kind == "ok"
    for ruim in (
        "2026-09-15T23:00:00+00:00",  # offset explícito é recusado
        "2026-09-15T23:00:00",  # sem Z
        "2026-02-30T23:00:00Z",  # data impossível
        "ontem",
    ):
        assert parse_maia_frame(cancel(ruim)).kind == "invalid"
