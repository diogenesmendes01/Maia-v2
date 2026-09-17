"""Cliente IPC e bomba de controle (spec §6.4.2, §6.5.4).

O caso central é ``test_retry_de_transporte_reusa_o_mesmo_call_seq``. A regra da
spec é explícita: ``call_seq`` é gerado UMA vez por chamada e reaproveitado se
houver retry de transporte. Gerar um número novo ao reenviar transformaria uma
REENTREGA (a Maia ainda está processando) numa SEGUNDA operação de negócio — e o
broker, que deduplica por ``(execution_id, call_seq)``, não teria como saber.
"""

from __future__ import annotations

import io
import json
import threading
import time

import pytest

from hermes_worker.bridge_tools import BridgeUnavailable
from hermes_worker.ipc import ControlPump, IpcBridge
from hermes_worker.protocol import (
    HERMES_WORKER_PROTOCOL_VERSION,
    FrameWriter,
    NdjsonFrameReader,
    parse_maia_frame,
)

RUN_ID = "3f7c1f4e-6a1b-4c6d-9f1a-2b3c4d5e6f70"
OUTRO_RUN = "11111111-2222-4333-8444-555555555555"


def _writer() -> tuple[FrameWriter, io.BytesIO]:
    buffer = io.BytesIO()
    return FrameWriter(buffer), buffer


def _linhas(buffer: io.BytesIO) -> list[dict]:
    bruto = buffer.getvalue().decode("utf-8")
    return [json.loads(linha) for linha in bruto.split("\n") if linha.strip()]


def _espera_linhas(buffer: io.BytesIO, quantas: int, timeout: float = 3.0) -> list[dict]:
    limite = time.monotonic() + timeout
    while time.monotonic() < limite:
        linhas = _linhas(buffer)
        if len(linhas) >= quantas:
            return linhas
        time.sleep(0.005)
    raise AssertionError(f"esperava {quantas} linhas, vi {len(_linhas(buffer))}")


def _invoca_em_thread(bridge: IpcBridge, caixa: dict) -> threading.Thread:
    def alvo() -> None:
        caixa["outcome"] = bridge.invoke(
            "fixture_echo", {"texto": "oi"}, observed_session_id="sess-1"
        )

    thread = threading.Thread(target=alvo, daemon=True)
    thread.start()
    return thread


# ─── identidade da chamada ──────────────────────────────────────────────────


def test_call_seq_comeca_em_zero_e_e_monotonico() -> None:
    writer, buffer = _writer()
    bridge = IpcBridge(writer, RUN_ID, max_tool_calls=4)

    caixa: dict = {}
    thread = _invoca_em_thread(bridge, caixa)
    _espera_linhas(buffer, 1)
    bridge.resolve(0, {"kind": "result", "result": {"ok": True}})
    thread.join(timeout=3)

    assert caixa["outcome"].result == {"ok": True}
    assert bridge.allocated_call_seqs == (0,)
    assert _linhas(buffer)[0]["call_seq"] == 0


def test_retry_de_transporte_reusa_o_mesmo_call_seq() -> None:
    writer, buffer = _writer()
    bridge = IpcBridge(writer, RUN_ID, max_tool_calls=4)

    caixa: dict = {}
    thread = _invoca_em_thread(bridge, caixa)

    _espera_linhas(buffer, 1)
    # A Maia diz "ainda estou processando": isso é transporte, não nova operação.
    bridge.resolve(0, {"kind": "in_progress", "retry_after_ms": 1})

    linhas = _espera_linhas(buffer, 2)
    bridge.resolve(0, {"kind": "result", "result": {"saldo": "10.00"}})
    thread.join(timeout=3)

    assert caixa["outcome"].result == {"saldo": "10.00"}
    # DUAS emissões, UM call_seq, UMA chamada alocada.
    assert [linha["call_seq"] for linha in linhas[:2]] == [0, 0]
    assert bridge.allocated_call_seqs == (0,)


def test_frame_emitido_e_um_tool_request_valido() -> None:
    writer, buffer = _writer()
    bridge = IpcBridge(writer, RUN_ID, max_tool_calls=4)
    caixa: dict = {}
    thread = _invoca_em_thread(bridge, caixa)
    _espera_linhas(buffer, 1)
    bridge.resolve(0, {"kind": "result", "result": None})
    thread.join(timeout=3)

    linha = _linhas(buffer)[0]
    assert linha["type"] == "tool.request"
    assert linha["run_id"] == RUN_ID
    assert linha["observed_session_id"] == "sess-1"
    # O worker não escolhe id de chamada: não existe `call_id` no frame.
    assert "call_id" not in linha


# ─── recusas fechadas ───────────────────────────────────────────────────────


def test_orcamento_de_tools_esgotado_recusa_sem_emitir_frame() -> None:
    writer, buffer = _writer()
    bridge = IpcBridge(writer, RUN_ID, max_tool_calls=0)
    outcome = bridge.invoke("fixture_echo", {}, observed_session_id=None)
    assert outcome.refusal_code == "budget_exhausted"
    assert _linhas(buffer) == []


def test_prazo_estourado_devolve_desconhecido_nao_falha() -> None:
    """Sem resposta até o prazo, o efeito pode ter acontecido (§6.9.1, item 7)."""
    writer, _ = _writer()
    bridge = IpcBridge(
        writer, RUN_ID, max_tool_calls=4, deadline_monotonic=time.monotonic() - 1
    )
    outcome = bridge.invoke("fixture_echo", {}, observed_session_id=None)
    assert outcome.refusal_code == "effect_unknown"


def test_perda_do_canal_libera_quem_espera_com_erro_fechado() -> None:
    """Perder o pipe é perder a autoridade (§6.4.2): ninguém fica pendurado."""
    writer, buffer = _writer()
    bridge = IpcBridge(writer, RUN_ID, max_tool_calls=4)
    caixa: dict = {}
    thread = _invoca_em_thread(bridge, caixa)
    _espera_linhas(buffer, 1)

    bridge.close()
    thread.join(timeout=3)
    assert caixa["outcome"].refusal_code == "run_not_authorized"
    assert bridge.is_available() is False


def test_invoke_depois_do_fechamento_nao_cai_para_outro_backend() -> None:
    writer, _ = _writer()
    bridge = IpcBridge(writer, RUN_ID, max_tool_calls=4)
    bridge.close()
    with pytest.raises(BridgeUnavailable):
        bridge.invoke("fixture_echo", {}, observed_session_id=None)


def test_resolve_de_call_seq_desconhecido_e_descartado() -> None:
    """Nunca adivinhar a qual chamada um resultado órfão "deve" pertencer."""
    writer, _ = _writer()
    bridge = IpcBridge(writer, RUN_ID, max_tool_calls=4)
    assert bridge.resolve(99, {"kind": "result", "result": {}}) is False


def test_desfecho_desconhecido_vira_protocol_error() -> None:
    writer, buffer = _writer()
    bridge = IpcBridge(writer, RUN_ID, max_tool_calls=4)
    caixa: dict = {}
    thread = _invoca_em_thread(bridge, caixa)
    _espera_linhas(buffer, 1)
    bridge.resolve(0, {"kind": "inventado"})
    thread.join(timeout=3)
    assert caixa["outcome"].refusal_code == "protocol_error"


# ─── bomba de controle ──────────────────────────────────────────────────────


class _BridgeEspiao:
    def __init__(self) -> None:
        self.resolvidos: list[tuple[int, dict]] = []
        self.fechado = False

    def resolve(self, call_seq, outcome):
        self.resolvidos.append((call_seq, dict(outcome)))
        return True

    def close(self, *, refusal_code="run_not_authorized"):
        self.fechado = True


def _pump(bridge) -> tuple[ControlPump, dict]:
    eventos: dict = {"cancel": [], "ack": [], "erro": []}
    pump = ControlPump(
        None,
        NdjsonFrameReader("maia_to_worker"),
        run_id=RUN_ID,
        bridge=bridge,
        on_cancel=eventos["cancel"].append,
        on_result_ack=eventos["ack"].append,
        on_protocol_error=eventos["erro"].append,
    )
    return pump, eventos


def _tool_result(run_id: str = RUN_ID) -> str:
    return json.dumps(
        {
            "protocol": HERMES_WORKER_PROTOCOL_VERSION,
            "type": "tool.result",
            "run_id": run_id,
            "call_seq": 0,
            "outcome": {"kind": "result", "result": {"ok": True}, "is_error": False},
        }
    )


def test_pump_entrega_tool_result_ao_bridge() -> None:
    bridge = _BridgeEspiao()
    pump, _ = _pump(bridge)
    pump.handle(parse_maia_frame(_tool_result()))
    assert bridge.resolvidos[0][0] == 0


def test_pump_recusa_frame_de_outra_execucao() -> None:
    """``run_id`` é CORRELAÇÃO: divergiu, descarta — nunca seleciona execução."""
    bridge = _BridgeEspiao()
    pump, _ = _pump(bridge)
    pump.handle(parse_maia_frame(_tool_result(run_id=OUTRO_RUN)))
    assert bridge.resolvidos == []
    assert pump.foreign_frames == 1


def test_pump_conta_frame_invalido_sem_derrubar_o_turno() -> None:
    bridge = _BridgeEspiao()
    pump, _ = _pump(bridge)
    pump.handle(parse_maia_frame("isto não é json"))
    assert pump.invalid_frames == 1
    assert bridge.resolvidos == []


def test_pump_repassa_cancelamento_como_categoria_fechada() -> None:
    bridge = _BridgeEspiao()
    pump, eventos = _pump(bridge)
    pump.handle(
        parse_maia_frame(
            json.dumps(
                {
                    "protocol": HERMES_WORKER_PROTOCOL_VERSION,
                    "type": "cancel",
                    "run_id": RUN_ID,
                    "reason": "ownership_lost",
                    "grace_deadline_at": "2026-09-15T23:00:00.000Z",
                }
            )
        )
    )
    assert eventos["cancel"] == ["ownership_lost"]


def test_pump_trata_segundo_start_como_erro_de_protocolo() -> None:
    """§6.4.2: receber ``start`` duas vezes no mesmo processo é erro."""
    bridge = _BridgeEspiao()
    pump, eventos = _pump(bridge)
    start = json.dumps(
        {
            "protocol": HERMES_WORKER_PROTOCOL_VERSION,
            "type": "start",
            "run_id": RUN_ID,
            "request_key": "8a1e2c3d-4b5a-4c7d-8e9f-0a1b2c3d4e5f",
            "binding": {
                "execution_id": RUN_ID,
                "task_id": "task-1",
                "initial_session_id": "sess-1",
                "manifest_digest": "b" * 64,
                "mode": "live",
            },
            "manifest": {
                "schema": "maia-hermes-runtime-manifest/v1",
                "tools": [],
                "result_limit_chars": 4096,
            },
            "context": {"system": "s", "user_message": "u", "history": []},
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
    )
    pump.handle(parse_maia_frame(start))
    assert eventos["erro"] == ["start_duplicado"]
