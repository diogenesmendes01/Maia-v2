"""P00.2 (spec §6.4.2, §6.5.4) — cliente IPC e bomba de controle.

Duas coisas acontecem ao mesmo tempo no worker e é isso que este arquivo
resolve: ``run_conversation`` BLOQUEIA numa thread enquanto frames de controle
(``tool.result``, ``cancel``) continuam chegando pelo pipe. Um leitor que só
rodasse entre turnos jamais entregaria o resultado de uma tool — o agente
esperaria para sempre por algo que já chegou.

Decisões que a spec fixa e que o código abaixo implementa literalmente:

- **Correlação por ``call_seq``, com um future por chamada.** Nada de "slot
  global de resposta aguardada": um batch de tools pode ser concorrente
  (§6.5.4), e o "último callback" não identifica o próximo handler.
- **``call_seq`` é gerado UMA vez por chamada.** Um retry de TRANSPORTE (a Maia
  respondeu ``in_progress``) reenvia o MESMO ``call_seq``. Gerar outro
  transformaria uma reentrega em uma segunda operação de negócio.
- **O lock de escrita nunca é segurado esperando tool.** Ele cobre só a
  serialização da linha (``FrameWriter``); a espera acontece fora dele.
- **Autoridade é a posse do pipe.** ``run_id`` no frame é comparado e recusado
  em divergência — nunca usado para escolher execução.
"""

from __future__ import annotations

import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Final, Mapping

from .bridge_tools import BridgeOutcome, BridgeUnavailable
from .protocol import (
    HERMES_WORKER_PROTOCOL_VERSION,
    WIRE_LIMITS,
    FrameWriter,
    NdjsonFrameReader,
    ParsedFrame,
)

__all__ = ["ControlPump", "IpcBridge", "read_start_frame"]

#: Teto de reentregas ``in_progress`` por chamada. Existe para que um broker que
#: responda ``in_progress`` em laço não prenda o turno além do deadline.
MAX_IN_PROGRESS_RETRIES: Final[int] = 64

_READ_CHUNK: Final[int] = 65536


@dataclass
class _Slot:
    """Espera de UMA chamada. Mutável por natureza — fica fora do binding."""

    event: threading.Event = field(default_factory=threading.Event)
    outcome: Mapping[str, Any] | None = None


class IpcBridge:
    """Cliente IPC por execução. Implementa o protocolo ``ToolBridge``."""

    def __init__(
        self,
        writer: FrameWriter,
        run_id: str,
        *,
        max_tool_calls: int,
        deadline_monotonic: float | None = None,
    ) -> None:
        self._writer = writer
        self._run_id = run_id
        self._max_tool_calls = max_tool_calls
        self._deadline = deadline_monotonic
        self._lock = threading.Lock()
        self._next_call_seq = 0
        self._allocated: list[int] = []
        self._slots: dict[int, _Slot] = {}
        self._closed = False

    @property
    def allocated_call_seqs(self) -> tuple[int, ...]:
        """O que o worker AFIRMA ter chamado — evidência é o journal da Maia."""
        with self._lock:
            return tuple(self._allocated)

    def is_available(self) -> bool:
        """Disponibilidade do canal. ``check_fn`` é cacheado pelo Hermes e NÃO é
        autenticação nem revogação (§6.5.2) — a proteção real é o handler."""
        with self._lock:
            return not self._closed

    def invoke(
        self, name: str, args: Mapping[str, Any], *, observed_session_id: str | None
    ) -> BridgeOutcome:
        with self._lock:
            if self._closed:
                raise BridgeUnavailable("canal encerrado")
            if len(self._allocated) >= self._max_tool_calls:
                return BridgeOutcome(refusal_code="budget_exhausted")
            if self._next_call_seq > WIRE_LIMITS.max_call_seq:
                return BridgeOutcome(refusal_code="budget_exhausted")
            call_seq = self._next_call_seq
            self._next_call_seq += 1
            self._allocated.append(call_seq)
            slot = _Slot()
            self._slots[call_seq] = slot

        try:
            return self._await_outcome(call_seq, slot, name, args, observed_session_id)
        finally:
            with self._lock:
                self._slots.pop(call_seq, None)

    def _await_outcome(
        self,
        call_seq: int,
        slot: _Slot,
        name: str,
        args: Mapping[str, Any],
        observed_session_id: str | None,
    ) -> BridgeOutcome:
        for _ in range(MAX_IN_PROGRESS_RETRIES + 1):
            self._send_request(call_seq, name, args, observed_session_id)
            if not slot.event.wait(timeout=self._remaining_seconds()):
                # Sem resposta até o prazo: o efeito pode ter acontecido. O
                # modelo recebe "desconhecido", nunca "falhou, tente de novo".
                return BridgeOutcome(refusal_code="effect_unknown")

            outcome = slot.outcome or {}
            kind = outcome.get("kind")
            if kind == "result":
                return BridgeOutcome(result=outcome.get("result"))
            if kind == "refused":
                return BridgeOutcome(refusal_code=str(outcome.get("code")))
            if kind == "in_progress":
                delay_ms = outcome.get("retry_after_ms")
                slot.event.clear()
                slot.outcome = None
                if self._sleep_bounded(delay_ms):
                    continue
                return BridgeOutcome(refusal_code="effect_unknown")
            return BridgeOutcome(refusal_code="protocol_error")
        return BridgeOutcome(refusal_code="effect_unknown")

    def _send_request(
        self,
        call_seq: int,
        name: str,
        args: Mapping[str, Any],
        observed_session_id: str | None,
    ) -> None:
        self._writer.send(
            {
                "protocol": HERMES_WORKER_PROTOCOL_VERSION,
                "type": "tool.request",
                "run_id": self._run_id,
                "call_seq": call_seq,
                "name": name,
                "args": dict(args),
                "observed_session_id": observed_session_id,
            }
        )

    def _remaining_seconds(self) -> float | None:
        if self._deadline is None:
            return None
        return max(0.0, self._deadline - time.monotonic())

    def _sleep_bounded(self, delay_ms: Any) -> bool:
        if not isinstance(delay_ms, int) or isinstance(delay_ms, bool) or delay_ms < 1:
            return False
        remaining = self._remaining_seconds()
        delay = delay_ms / 1000.0
        if remaining is not None and delay > remaining:
            return False
        time.sleep(delay)
        return True

    def resolve(self, call_seq: int, outcome: Mapping[str, Any]) -> bool:
        """Entrega o desfecho ao future daquele ``call_seq``. Chamada pela bomba."""
        with self._lock:
            slot = self._slots.get(call_seq)
        if slot is None:
            # Resultado de uma chamada que já expirou ou nunca existiu: descartar.
            # Nunca inventar a qual chamada ele "deve" pertencer.
            return False
        slot.outcome = dict(outcome)
        slot.event.set()
        return True

    def close(self, *, refusal_code: str = "run_not_authorized") -> None:
        """Desautoriza o canal e libera quem estiver esperando, com erro fechado."""
        with self._lock:
            self._closed = True
            pending = list(self._slots.values())
        for slot in pending:
            if not slot.event.is_set():
                slot.outcome = {"kind": "refused", "code": refusal_code}
                slot.event.set()


class ControlPump(threading.Thread):
    """Lê frames da Maia enquanto ``run_conversation`` bloqueia noutra thread."""

    def __init__(
        self,
        stream: Any,
        reader: NdjsonFrameReader,
        *,
        run_id: str,
        bridge: IpcBridge,
        on_cancel: Callable[[str], None],
        on_result_ack: Callable[[str], None],
        on_protocol_error: Callable[[str], None],
    ) -> None:
        super().__init__(name="maia-hermes-control", daemon=True)
        self._stream = stream
        self._reader = reader
        self._run_id = run_id
        self._bridge = bridge
        self._on_cancel = on_cancel
        self._on_result_ack = on_result_ack
        self._on_protocol_error = on_protocol_error
        self.invalid_frames = 0
        self.foreign_frames = 0

    def run(self) -> None:  # pragma: no cover - exercido por P00.4
        try:
            while True:
                chunk = self._stream.read(_READ_CHUNK)
                if not chunk:
                    break
                for parsed in self._reader.feed(chunk):
                    self.handle(parsed)
            for parsed in self._reader.close():
                self.handle(parsed)
        except OSError:
            # Pipe fechado = autoridade perdida. Quem trata é o supervisor.
            pass
        finally:
            self._bridge.close()

    def handle(self, parsed: ParsedFrame) -> None:
        """Despacha um frame já lido. Separada de ``run`` para ser testável."""
        if parsed.kind == "invalid":
            self.invalid_frames += 1
            # Linha inválida não vira instrução nem derruba o turno; ela é
            # contada e reportada no canal de LOG, nunca no canal de protocolo.
            print(
                f"[hermes-worker] frame inválido descartado: {parsed.code}",
                file=sys.stderr,
            )
            return

        frame = parsed.frame or {}
        if frame.get("run_id") != self._run_id:
            # Correlação divergente: recusar, nunca usar para escolher execução.
            self.foreign_frames += 1
            return

        frame_type = frame.get("type")
        if frame_type == "tool.result":
            self._bridge.resolve(int(frame["call_seq"]), frame["outcome"])
            return
        if frame_type == "cancel":
            self._on_cancel(str(frame["reason"]))
            return
        if frame_type == "result_ack":
            self._on_result_ack(str(frame["terminal_digest"]))
            return
        if frame_type == "start":
            # §6.4.2: um segundo `start` no mesmo processo é erro, mesmo que o
            # primeiro tenha falhado. Não existe "reiniciar" este worker.
            self._on_protocol_error("start_duplicado")


def read_start_frame(stream: Any, reader: NdjsonFrameReader) -> ParsedFrame:
    """Lê o PRIMEIRO frame do pipe, que precisa ser o ``start``.

    Usa o mesmo ``NdjsonFrameReader`` que a bomba usará depois: um leitor novo
    perderia os bytes que já vieram grudados na mesma leitura do pipe.
    """
    while True:
        chunk = stream.read(_READ_CHUNK)
        if not chunk:
            trailing = reader.close()
            if trailing:
                return trailing[0]
            return ParsedFrame("invalid", code="not_json", detail="pipe fechado sem start")
        frames = reader.feed(chunk)
        if frames:
            return frames[0]
