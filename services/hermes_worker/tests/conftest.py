"""Fixtures da suíte do worker.

Duas decisões que valem para todos os testes:

1. **Nada aqui importa o Hermes.** A suíte roda num Python 3.12 com pytest e
   mais nada — é o que permite rodá-la sem o venv do motor e sem rede. Exercitar
   o ``AIAgent`` de verdade é a unidade P00.4.
2. **Ambiente limpo por padrão.** Se a máquina de quem roda tiver ``HERMES_HOME``
   apontando para o perfil pessoal, ou uma chave de API exportada, um teste que
   por acidente construísse um agente usaria isso. A fixture autouse remove
   essas variáveis do processo de teste.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# ``services/`` não é pacote; o import canônico é ``hermes_worker``.
_PACKAGE_PARENT = Path(__file__).resolve().parents[2]
if str(_PACKAGE_PARENT) not in sys.path:
    sys.path.insert(0, str(_PACKAGE_PARENT))

#: Raiz do repositório — as fixtures do wire são COMPARTILHADAS com o TypeScript.
REPO_ROOT = Path(__file__).resolve().parents[3]
WIRE_FIXTURES = REPO_ROOT / "tests" / "fixtures" / "hermes-wire" / "frames.json"

_DIRTY_ENV_PREFIXES = ("ANTHROPIC_", "OPENAI_", "HERMES_")
_DIRTY_ENV_SUFFIXES = ("_API_KEY", "_AUTH_TOKEN")


@pytest.fixture(autouse=True)
def ambiente_limpo(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove herança de perfil/credencial do ambiente do teste."""
    import os

    for name in list(os.environ):
        if name.startswith(_DIRTY_ENV_PREFIXES) or name.endswith(_DIRTY_ENV_SUFFIXES):
            monkeypatch.delenv(name, raising=False)
