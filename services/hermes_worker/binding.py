"""P00.2 (spec §6.4.1) — ``WorkerBinding``: identidade da execução no filho.

O que este objeto É: a tupla mínima que o handler precisa para provar, sem
perguntar a ninguém, que a chamada que chegou pertence à execução que a Maia
autorizou — ``task_id`` como tripwire e a lista de nomes permitidos.

O que este objeto NÃO É, por decisão da spec §6.4.1:

- **não carrega tenant, pessoa, conversa ou cliente.** A autoridade comercial
  mora no broker da Maia, do outro lado do pipe. Um campo de tenant aqui seria
  um campo que alguém, algum dia, lê para decidir alguma coisa — e a decisão
  estaria sendo tomada dentro do processo que hospeda motor de terceiros.
- **não carrega segredo.** A credencial de inferência chega por variável de
  ambiente no spawn (§9.1), nunca por frame e nunca por este objeto.
- **não carrega estado de transporte.** Contador de ``call_seq``, locks e
  futures vivem no cliente IPC, que é mutável por natureza. Misturar os dois é
  como um binding "congelado" volta a mudar.

``frozen=True`` congela os ATRIBUTOS, não o conteúdo deles: um ``dict`` ou
``list`` aninhado continuaria mutável por dentro, e um binding que pode ser
alterado depois da autorização não é um binding. Por isso todo campo aqui é de
tipo realmente imutável, e ``allowed_tool_names`` é ``tuple`` — validada no
``__post_init__`` para que passar uma ``list`` falhe alto em vez de congelar
pela metade.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Final, Literal

__all__ = ["WorkerBinding", "WorkerBindingError"]

_UUID_RE: Final = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)
_SHA256_RE: Final = re.compile(r"^[0-9a-f]{64}$")

RunMode = Literal["live", "shadow"]


class WorkerBindingError(ValueError):
    """Binding malformado. Falha alto: não existe binding "quase válido"."""


@dataclass(frozen=True, slots=True)
class WorkerBinding:
    """Binding imutável de UMA execução. Ver spec §6.4.1."""

    #: O MESMO uuid do run (§4.1) — correlação, nunca seleção de autoridade.
    execution_id: str
    #: Tripwire do handler: ``task_id`` divergente recusa a chamada (§6.5.3).
    task_id: str
    #: Sessão Hermes inicial. Pode rotacionar por compressão
    #: (agent/conversation_compression.py:3012); guardamos a INICIAL como alias
    #: de auditoria e nunca autorizamos por sessão.
    initial_session_id: str
    #: Digest do manifest COMPLETO compilado pela Maia. O worker não o recalcula
    #: (não recebe o manifest completo, só a projeção); é eco de auditoria.
    manifest_digest: str
    #: Nomes permitidos, imutáveis e sem duplicata.
    allowed_tool_names: tuple[str, ...]
    mode: RunMode

    def __post_init__(self) -> None:
        if not isinstance(self.execution_id, str) or not _UUID_RE.match(
            self.execution_id
        ):
            raise WorkerBindingError("execution_id precisa ser UUID")
        for field_name in ("task_id", "initial_session_id"):
            value = getattr(self, field_name)
            if not isinstance(value, str) or not value or len(value) > 128:
                raise WorkerBindingError(f"{field_name} precisa ser string de 1..128")
        if not isinstance(self.manifest_digest, str) or not _SHA256_RE.match(
            self.manifest_digest
        ):
            raise WorkerBindingError("manifest_digest precisa ser sha256 hex minúsculo")
        if self.mode not in ("live", "shadow"):
            raise WorkerBindingError("mode precisa ser live ou shadow")

        names = self.allowed_tool_names
        # `tuple` não é detalhe de estilo: uma `list` aqui deixaria a allowlist
        # editável depois da autorização, dentro do processo que hospeda o motor.
        if not isinstance(names, tuple):
            raise WorkerBindingError("allowed_tool_names precisa ser tuple imutável")
        if any(not isinstance(name, str) or not name for name in names):
            raise WorkerBindingError("allowed_tool_names só aceita strings não vazias")
        if len(set(names)) != len(names):
            raise WorkerBindingError("allowed_tool_names não admite duplicata")

    def allows(self, tool_name: str) -> bool:
        """Nome está na allowlist desta execução? Comparação exata, sem normalizar.

        O Hermes repara nomes alucinados ANTES de validar
        (agent/turn_tool_validation.py:92-96); o que chega ao handler é o nome
        EFETIVO, e é ele que a auditoria registra — não o nome originalmente
        alucinado pelo modelo.
        """
        return tool_name in self.allowed_tool_names
