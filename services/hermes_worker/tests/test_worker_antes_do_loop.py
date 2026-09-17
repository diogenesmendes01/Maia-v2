"""``run_worker`` real diante de controle que chega ANTES do loop (§6.7.2, §6.7.3).

Duas regras normativas, e o que cada uma exige do processo:

- §6.7.3 item 2: "Se ``start``/construção ainda não concluiu, guardar
  cancelamento e não iniciar o loop." Guardar só o motivo não basta — o
  ``run_worker`` lia ``cancel_reason`` apenas DEPOIS do loop, e rodava o turno
  inteiro mesmo com o cancelamento já recebido.
- §6.7.2 item 3 e §6.4.2: aceitar no máximo um ``start``; o segundo é erro. A
  bomba detectava e gravava ``protocol_error``, que ninguém lia.

O teste roda o ``run_worker`` de verdade, no mesmo processo. O que é dublado é
só o que não pertence a esta suíte (ver conftest): o motor Hermes, trocado por
módulos em ``sys.modules``, e o pipe, trocado por um roteiro. O roteiro não usa
relógio para decidir ordem: cada passo espera um EVENTO (construção começou,
frame saiu). O prazo só existe para o teste falhar em vez de travar.
"""

from __future__ import annotations

import io
import json
import sys
import threading
import types

import pytest
from conftest import WIRE_FIXTURES

from hermes_worker import main as worker_main
from hermes_worker.protocol import HERMES_WORKER_PROTOCOL_VERSION, FrameWriter

PRAZO = 10.0


def _start() -> dict:
    casos = json.loads(WIRE_FIXTURES.read_text(encoding="utf-8"))["cases"]
    return next(caso["frame"] for caso in casos if caso["id"] == "start-ok")


START_FRAME = _start()
RUN_ID = START_FRAME["run_id"]
OUTRO_RUN = "11111111-2222-4333-8444-555555555555"
NOMES_DO_MANIFEST = [tool["name"] for tool in START_FRAME["manifest"]["tools"]]


def _linha(frame: dict) -> bytes:
    return (json.dumps(frame) + "\n").encode("utf-8")


def _cancel(run_id: str = RUN_ID, reason: str = "ownership_lost") -> bytes:
    return _linha(
        {
            "protocol": HERMES_WORKER_PROTOCOL_VERSION,
            "type": "cancel",
            "run_id": run_id,
            "reason": reason,
            "grace_deadline_at": "2026-09-15T23:00:00.000Z",
        }
    )


START = _linha(START_FRAME)
CANCEL = _cancel()
ACK = _linha(
    {
        "protocol": HERMES_WORKER_PROTOCOL_VERSION,
        "type": "result_ack",
        "run_id": RUN_ID,
        "terminal_digest": "c" * 64,
    }
)


class _Saida(io.BytesIO):
    def close(self) -> None:  # o worker fecha o writer no finally; manter legível
        pass

    def frames(self) -> list[dict]:
        return [json.loads(x) for x in self.getvalue().decode("utf-8").splitlines() if x.strip()]

    def tipos(self) -> list[str]:
        return [frame["type"] for frame in self.frames()]


class _Roteiro:
    """``read`` executa passos até ter um bloco para devolver; sem passos, EOF."""

    def __init__(self, passos: list[tuple], saida: _Saida) -> None:
        self._passos = list(passos)
        self._saida = saida

    def read(self, _n: int) -> bytes:
        while self._passos:
            tipo, valor = self._passos.pop(0)
            if tipo == "bloco":
                return valor
            if tipo == "espera":
                assert valor.wait(PRAZO), "roteiro: o evento esperado não ocorreu"
            elif tipo == "sinaliza":
                valor.set()
            elif tipo == "ate_frame":
                pausa = threading.Event()
                for _ in range(int(PRAZO / 0.01)):
                    if valor in self._saida.tipos():
                        break
                    pausa.wait(0.01)
                else:
                    raise AssertionError(f"roteiro: frame {valor!r} não saiu")
        return b""


class _Motor:
    """Estado observável do Hermes dublado."""

    def __init__(self) -> None:
        self.construcoes = 0
        self.construcao_iniciou = threading.Event()
        self.pode_terminar_construcao = threading.Event()
        self.pode_terminar_construcao.set()
        self.loop_iniciou = threading.Event()
        self.interrompido = threading.Event()
        self.bloquear_loop = False
        self.run_calls = 0
        self.interrupts: list[str | None] = []
        self.fechamentos = 0


@pytest.fixture
def motor(monkeypatch: pytest.MonkeyPatch, tmp_path) -> _Motor:
    m = _Motor()

    class AIAgent:
        def __init__(self, **_kwargs) -> None:
            m.construcoes += 1
            m.construcao_iniciou.set()
            assert m.pode_terminar_construcao.wait(PRAZO)
            self.tools = [{"function": {"name": nome}} for nome in NOMES_DO_MANIFEST]
            self.valid_tool_names = set(NOMES_DO_MANIFEST)

        def run_conversation(self, **_kwargs) -> dict:
            m.run_calls += 1
            m.loop_iniciou.set()
            if m.bloquear_loop:
                assert m.interrompido.wait(PRAZO), "loop dublado: interrupção não chegou"
                return {"completed": False, "interrupted": True, "api_calls": 1}
            return {"completed": True, "final_response": "oi", "api_calls": 1}

        def hard_interrupt(self, message=None, *, tool_reason=None) -> None:
            m.interrupts.append(tool_reason)
            m.interrompido.set()

        def close(self) -> None:
            m.fechamentos += 1

    class _Registry:
        def __init__(self) -> None:
            self._entradas: dict[str, dict] = {}

        def get_entry(self, nome: str):
            return self._entradas.get(nome)

        def register(self, **kwargs) -> None:
            self._entradas[kwargs["name"]] = kwargs

    tools_mod = types.ModuleType("tools")
    registry_mod = types.ModuleType("tools.registry")
    registry_mod.registry = _Registry()
    run_agent_mod = types.ModuleType("run_agent")
    run_agent_mod.AIAgent = AIAgent
    monkeypatch.setitem(sys.modules, "tools", tools_mod)
    monkeypatch.setitem(sys.modules, "tools.registry", registry_mod)
    monkeypatch.setitem(sys.modules, "run_agent", run_agent_mod)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    return m


def _roda(monkeypatch: pytest.MonkeyPatch, passos: list[tuple]) -> tuple[int, _Saida]:
    saida = _Saida()
    stream = _Roteiro(passos, saida)
    monkeypatch.setattr(worker_main, "split_ipc_from_logs", lambda: (stream, FrameWriter(saida)))
    return worker_main.run_worker(), saida


def _ultimo_result(saida: _Saida) -> dict:
    results = [frame for frame in saida.frames() if frame["type"] == "result"]
    assert len(results) == 1, saida.tipos()
    return results[0]


# ─── cancelamento antes do loop ─────────────────────────────────────────────


def test_cancel_no_mesmo_read_do_start_nao_constroi_nem_roda(monkeypatch, motor) -> None:
    code, saida = _roda(
        monkeypatch, [("bloco", START + CANCEL), ("ate_frame", "result"), ("bloco", ACK)]
    )
    assert code == worker_main.EXIT_OK
    assert saida.tipos() == ["cancel_ack", "result"]
    result = _ultimo_result(saida)
    assert result["stop"] == {"kind": "cancelled", "reason": "ownership_lost"}
    assert result["iterations"] == 0
    assert result["observed_tool_call_seqs"] == []
    assert motor.construcoes == 0
    assert motor.run_calls == 0


def test_excedentes_chegam_ao_worker_na_ordem_do_pipe(monkeypatch, motor) -> None:
    """Dois cancels colados: o motivo que vale é o PRIMEIRO que a Maia escreveu."""
    code, saida = _roda(
        monkeypatch,
        [
            ("bloco", START + CANCEL + _cancel(reason="operator")),
            ("ate_frame", "result"),
            ("bloco", ACK),
        ],
    )
    assert code == worker_main.EXIT_OK
    assert saida.tipos() == ["cancel_ack", "cancel_ack", "result"]
    assert _ultimo_result(saida)["stop"] == {"kind": "cancelled", "reason": "ownership_lost"}


def test_cancel_durante_a_construcao_nao_emite_ready_nem_roda(monkeypatch, motor) -> None:
    motor.pode_terminar_construcao.clear()
    code, saida = _roda(
        monkeypatch,
        [
            ("bloco", START),
            ("espera", motor.construcao_iniciou),
            ("bloco", CANCEL),
            # Só roda depois de a bomba despachar o cancel acima.
            ("sinaliza", motor.pode_terminar_construcao),
            ("ate_frame", "result"),
            ("bloco", ACK),
        ],
    )
    assert code == worker_main.EXIT_OK
    assert saida.tipos() == ["cancel_ack", "result"]
    assert _ultimo_result(saida)["stop"] == {"kind": "cancelled", "reason": "ownership_lost"}
    assert motor.construcoes == 1
    assert motor.run_calls == 0
    # O agente construído é fechado mesmo sem loop (§6.7.2 item 7).
    assert motor.fechamentos == 1


# ─── segundo start ──────────────────────────────────────────────────────────


def test_segundo_start_no_mesmo_read_encerra_sem_ready_nem_result(monkeypatch, motor) -> None:
    code, saida = _roda(monkeypatch, [("bloco", START + START)])
    assert code == worker_main.EXIT_PROTOCOL
    assert saida.tipos() == []
    assert motor.construcoes == 0
    assert motor.run_calls == 0


def test_cancel_e_segundo_start_colados_erro_de_protocolo_prevalece(monkeypatch, motor) -> None:
    """Canal que violou o protocolo não fecha o turno com `result` de cancelamento."""
    code, saida = _roda(monkeypatch, [("bloco", START + CANCEL + START)])
    assert code == worker_main.EXIT_PROTOCOL
    assert saida.tipos() == ["cancel_ack"]
    assert motor.construcoes == 0


def test_segundo_start_durante_a_construcao_encerra_sem_ready(monkeypatch, motor) -> None:
    motor.pode_terminar_construcao.clear()
    code, saida = _roda(
        monkeypatch,
        [
            ("bloco", START),
            ("espera", motor.construcao_iniciou),
            ("bloco", START),
            ("sinaliza", motor.pode_terminar_construcao),
        ],
    )
    assert code == worker_main.EXIT_PROTOCOL
    assert saida.tipos() == []
    assert motor.run_calls == 0
    assert motor.fechamentos == 1


def test_segundo_start_durante_o_loop_interrompe_e_nao_oferece_resposta(monkeypatch, motor) -> None:
    motor.bloquear_loop = True
    code, saida = _roda(
        monkeypatch,
        [
            ("bloco", START),
            ("espera", motor.loop_iniciou),
            ("bloco", START),
            ("ate_frame", "result"),
            ("bloco", ACK),
        ],
    )
    assert code == worker_main.EXIT_PROTOCOL
    assert saida.tipos() == ["ready", "result"]
    assert _ultimo_result(saida)["stop"] == {"kind": "failed", "code": "protocol_error"}
    assert motor.run_calls == 1
    assert motor.interrupts == [worker_main.CANCEL_TOOL_REASON]


# ─── controles: o caminho normal não muda ───────────────────────────────────


def test_controle_so_start_roda_o_turno(monkeypatch, motor) -> None:
    code, saida = _roda(monkeypatch, [("bloco", START), ("ate_frame", "result"), ("bloco", ACK)])
    assert code == worker_main.EXIT_OK
    assert saida.tipos() == ["ready", "result"]
    assert _ultimo_result(saida)["stop"] == {"kind": "reply", "raw_text": "oi"}
    assert motor.run_calls == 1
    assert motor.interrupts == []


def test_controle_cancel_durante_o_loop_interrompe_o_motor(monkeypatch, motor) -> None:
    motor.bloquear_loop = True
    code, saida = _roda(
        monkeypatch,
        [
            ("bloco", START),
            ("espera", motor.loop_iniciou),
            ("bloco", CANCEL),
            ("ate_frame", "result"),
            ("bloco", ACK),
        ],
    )
    assert code == worker_main.EXIT_OK
    assert saida.tipos() == ["ready", "cancel_ack", "result"]
    assert _ultimo_result(saida)["stop"] == {"kind": "cancelled", "reason": "ownership_lost"}
    assert motor.interrupts == [worker_main.CANCEL_TOOL_REASON]


def test_controle_primeiro_frame_cancel_e_recusado_sem_construir(monkeypatch, motor) -> None:
    code, saida = _roda(monkeypatch, [("bloco", CANCEL + START)])
    assert code == worker_main.EXIT_PROTOCOL
    assert saida.tipos() == []
    assert motor.construcoes == 0


def test_controle_cancel_de_outra_execucao_colado_ao_start_nao_cancela(monkeypatch, motor) -> None:
    code, saida = _roda(
        monkeypatch,
        [("bloco", START + _cancel(OUTRO_RUN)), ("ate_frame", "result"), ("bloco", ACK)],
    )
    assert code == worker_main.EXIT_OK
    assert saida.tipos() == ["ready", "result"]
    assert motor.run_calls == 1
