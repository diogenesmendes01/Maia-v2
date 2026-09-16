"""Worker privado ``maia.hermes.worker.v1`` (spec §6.4-§6.8).

Pacote Python que hospeda UM ``AIAgent`` do Hermes pinado e conversa com a Maia
por um pipe privado em NDJSON. Ver ``README.md`` deste diretório.

O import deste pacote é deliberadamente barato e **não toca no Hermes**: os
imports do motor acontecem dentro de ``main.run_worker``, depois que os
descritores de IPC e o home efêmero já estão fixados (§6.6, invariante 1). É o
que permite a suíte de testes rodar num Python sem as dependências do Hermes.
"""

from .binding import WorkerBinding, WorkerBindingError
from .protocol import (
    HERMES_WORKER_PROTOCOL_VERSION,
    WIRE_LIMITS,
    parse_maia_frame,
    parse_worker_frame,
    serialize_frame,
)

__all__ = [
    "HERMES_WORKER_PROTOCOL_VERSION",
    "WIRE_LIMITS",
    "WorkerBinding",
    "WorkerBindingError",
    "parse_maia_frame",
    "parse_worker_frame",
    "serialize_frame",
]

__version__ = "0.1.0"
