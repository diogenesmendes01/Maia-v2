r"""P00.2 (spec §5.3.4, §5.6.2, §6.5.4) — ESPELHO PYTHON DE ``canonical-json.ts``.

Este módulo existe para uma coisa só: o mesmo conteúdo lógico precisa produzir o
MESMO digest nos dois lados da ponte. O lado TypeScript é
``src/integrations/hermes/canonical-json.ts``; este arquivo é a tradução fiel
dele, e ``tests/test_canonical_json.py`` fixa os bytes que o TS realmente
emitiu (gerados uma vez, com o comando anotado lá).

Um espelho "aproximado" é pior do que nenhum: ele concorda em 99% dos casos e
diverge exatamente no payload estranho — que é o payload que interessa. Por isso
as quatro armadilhas abaixo foram traduzidas explicitamente, em vez de delegadas
ao ``json`` da stdlib:

1. **Números.** ``json.dumps`` usa ``repr`` de float: ``1e-07``, ``100.0``,
   ``1e+17``. O JavaScript emite ``1e-7``, ``100`` e ``100000000000000000``.
   `_js_number` implementa o algoritmo Number::toString do ECMAScript.
2. **Inteiros grandes.** JSON não distingue int de float; o JS lê TODO número
   como double. ``12345678901234567890`` vira ``12345678901234567000`` lá. Aqui
   um ``int`` acima de 2^53-1 passa por ``float`` para que o digest bata.
3. **Ordem de chaves.** ``sorted()`` do Python ordena por code point; o
   ``Array.prototype.sort`` do JS ordena por unidade de código UTF-16. Os dois
   divergem entre BMP alto e astral: o TS emite o emoji U+1F600 ANTES de U+FFFD.
   `_utf16_units` dá a ordem do JS.
4. **Surrogates solitários.** ``JSON.stringify`` do ES2019 os escapa (\ud800
   vira texto ``\ud800``); ``json.dumps`` os emite crus e o ``encode("utf-8")``
   seguinte estoura. `_js_string` escapa como o JS.

Tudo fora do domínio ``None | bool | int | float finito | str | list | dict`` é
ERRO TIPADO, nunca conversão silenciosa — a mesma regra do TS, pelo mesmo
motivo: para um hash de identidade, cada conversão silenciosa é uma colisão em
potencial entre dois pedidos distintos.

Nota de implementação: os literais de escape aqui são STRINGS CRUAS (``r"..."``)
de propósito. O valor de ``_SHORT_ESCAPES[0x08]`` precisa ser o TEXTO de dois
caracteres barra-invertida + ``b``, que é o que o JSON de saída carrega — não o
caractere de controle 0x08.
"""

from __future__ import annotations

import hashlib
import math
from decimal import Decimal
from typing import Any, Final, Literal

__all__ = [
    "CANONICAL_JSON_VERSION",
    "FORBIDDEN_JSON_KEYS",
    "CanonicalJsonError",
    "CanonicalJsonErrorCode",
    "canonical_byte_length",
    "canonical_digest",
    "canonical_json_stringify",
    "js_json_stringify",
    "utf16_length",
]

#: Versão do algoritmo. Muda junto com QUALQUER mudança de bytes emitidos.
#: Espelha ``CANONICAL_JSON_VERSION`` em canonical-json.ts:58.
CANONICAL_JSON_VERSION: Final[int] = 1

#: Chaves que nunca atravessam a fronteira, em qualquer profundidade.
#: Espelha ``FORBIDDEN_JSON_KEYS`` em canonical-json.ts:51-55.
FORBIDDEN_JSON_KEYS: Final[frozenset[str]] = frozenset(
    {"__proto__", "constructor", "prototype"}
)

CanonicalJsonErrorCode = Literal[
    "non_finite", "unsupported_type", "cycle", "forbidden_key"
]

_MAX_SAFE_INTEGER: Final[int] = 2**53 - 1

_BACKSLASH: Final[str] = chr(92)

# ``JSON.stringify`` usa escapes curtos para estes e ``uXXXX`` minúsculo para o
# resto dos controles. DEL (0x7f) NÃO é escapado — nem lá, nem aqui.
_SHORT_ESCAPES: Final[dict[int, str]] = {
    0x08: r"\b",
    0x09: r"\t",
    0x0A: r"\n",
    0x0C: r"\f",
    0x0D: r"\r",
    0x22: r"\"",
    0x5C: r"\\",
}


class CanonicalJsonError(ValueError):
    """Erro tipado da canonicalização. ``code`` espelha ``CanonicalJsonErrorCode``.

    A mensagem carrega o CAMINHO, nunca o valor: este módulo é chamado sobre
    payload de conversa e sobre args vindos do modelo, e ``registry.dispatch``
    ecoa texto de exceção de volta ao modelo (tools/registry.py:857-866).
    """

    def __init__(self, code: CanonicalJsonErrorCode, path: str, message: str) -> None:
        super().__init__(message)
        self.code: CanonicalJsonErrorCode = code
        self.path = path


def _utf16_units(text: str) -> tuple[int, ...]:
    """Unidades de código UTF-16 de ``text`` — a ordem/contagem que o JS enxerga."""
    units: list[int] = []
    for char in text:
        code_point = ord(char)
        if code_point > 0xFFFF:
            offset = code_point - 0x10000
            units.append(0xD800 + (offset >> 10))
            units.append(0xDC00 + (offset & 0x3FF))
        else:
            units.append(code_point)
    return tuple(units)


def utf16_length(text: str) -> int:
    """``text.length`` como o JavaScript conta (par substituto = 2).

    O Zod aplica ``.min()``/``.max()`` de string sobre ``String.prototype.length``
    (node_modules/zod/v3/types.js, checks "min"/"max"), então o worker precisa
    contar igual ou aceitaria um nome de ferramenta que o supervisor recusa.
    """
    return len(_utf16_units(text))


def _js_number(value: int | float, path: str) -> str:
    """Número no formato ``Number::toString`` do ECMAScript (ES2023 §6.1.6.1.20)."""
    if isinstance(value, int) and not isinstance(value, bool):
        if -_MAX_SAFE_INTEGER <= value <= _MAX_SAFE_INTEGER:
            return str(value)
        # Acima de 2^53-1 o JS já perdeu precisão ao ler o JSON; perder aqui
        # também é o que faz os dois digests baterem.
        try:
            value = float(value)
        except OverflowError as exc:  # pragma: no cover - inteiro astronômico
            raise CanonicalJsonError(
                "non_finite", path, f"inteiro fora do alcance de double em {path}"
            ) from exc

    if not math.isfinite(value):
        raise CanonicalJsonError(
            "non_finite",
            path,
            f"valor numérico não finito em {path}: JSON não representa NaN/Infinity",
        )
    if value == 0:
        # `-0` e `0` são o mesmo valor lógico; `JSON.stringify(-0)` emite "0".
        return "0"

    sign = "-" if value < 0 else ""
    # `repr` de float no CPython já é a menor representação que faz round-trip,
    # a mesma propriedade que o JS usa; só o FORMATO abaixo é que difere.
    parts = Decimal(repr(abs(float(value)))).normalize().as_tuple()
    digits = "".join(str(digit) for digit in parts.digits)
    k = len(digits)
    n = int(parts.exponent) + k

    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    exponent = n - 1
    mantissa = digits if k == 1 else digits[0] + "." + digits[1:]
    suffix = f"e+{exponent}" if exponent >= 0 else f"e-{-exponent}"
    return sign + mantissa + suffix


def _js_string(text: str) -> str:
    """String no formato do ``JSON.stringify`` bem-formado (ES2019)."""
    out: list[str] = ['"']
    for char in text:
        code_point = ord(char)
        escape = _SHORT_ESCAPES.get(code_point)
        if escape is not None:
            out.append(escape)
        elif code_point < 0x20 or 0xD800 <= code_point <= 0xDFFF:
            # Surrogate solitário: em Python toda metade de par é um caractere
            # próprio, então qualquer um que apareça aqui é solitário de fato.
            out.append(_BACKSLASH + f"u{code_point:04x}")
        else:
            out.append(char)
    out.append('"')
    return "".join(out)


def _encode(
    value: Any, path: str, seen: set[int], out: list[str], *, sort_keys: bool
) -> None:
    if value is None:
        out.append("null")
        return
    if isinstance(value, bool):
        out.append("true" if value else "false")
        return
    if isinstance(value, (int, float)):
        out.append(_js_number(value, path))
        return
    if isinstance(value, str):
        out.append(_js_string(value))
        return

    if not isinstance(value, (list, dict)):
        raise CanonicalJsonError(
            "unsupported_type",
            path,
            f"tipo não serializável ({type(value).__name__}) em {path}",
        )

    marker = id(value)
    if marker in seen:
        raise CanonicalJsonError("cycle", path, f"referência cíclica em {path}")
    seen.add(marker)
    try:
        if isinstance(value, list):
            out.append("[")
            for index, item in enumerate(value):
                if index:
                    out.append(",")
                _encode(item, f"{path}[{index}]", seen, out, sort_keys=sort_keys)
            out.append("]")
            return

        keys = list(value.keys())
        for key in keys:
            if not isinstance(key, str):
                raise CanonicalJsonError(
                    "unsupported_type",
                    path,
                    f"chave não-string ({type(key).__name__}) em {path}",
                )
        if sort_keys:
            keys.sort(key=_utf16_units)
        out.append("{")
        first = True
        for key in keys:
            if key in FORBIDDEN_JSON_KEYS:
                raise CanonicalJsonError(
                    "forbidden_key", f"{path}.{key}", f'chave proibida "{key}" em {path}'
                )
            if not first:
                out.append(",")
            first = False
            out.append(_js_string(key))
            out.append(":")
            _encode(value[key], f"{path}.{key}", seen, out, sort_keys=sort_keys)
        out.append("}")
    finally:
        seen.discard(marker)


def canonical_json_stringify(value: Any) -> str:
    """Bytes canônicos do valor (chaves ordenadas). Espelha ``canonicalJsonStringify``."""
    out: list[str] = []
    _encode(value, "$", set(), out, sort_keys=True)
    return "".join(out)


def js_json_stringify(value: Any) -> str:
    """``JSON.stringify`` sem ordenar chaves — usado ao EMITIR um frame NDJSON.

    O TS emite o frame com ``JSON.stringify`` puro (protocol.ts:620); a forma
    canônica é só para digest. As diferenças em relação ao ``json.dumps`` da
    stdlib são as mesmas da forma canônica (números, surrogates), por isso o
    caminho de escrita reusa este encoder em vez do ``json``.
    """
    out: list[str] = []
    _encode(value, "$", set(), out, sort_keys=False)
    return "".join(out)


def canonical_digest(value: Any) -> str:
    """Digest de identidade, prefixado pela versão do algoritmo.

    Espelha ``canonicalDigest`` (canonical-json.ts:169-175): sha256 sobre
    ``maia.canonical-json/v<N>`` mais quebra de linha, seguido da forma canônica.
    """
    canonical = canonical_json_stringify(value)
    digest = hashlib.sha256()
    prefix = f"maia.canonical-json/v{CANONICAL_JSON_VERSION}" + chr(10)
    digest.update(prefix.encode("utf-8"))
    digest.update(canonical.encode("utf-8"))
    return digest.hexdigest()


def canonical_byte_length(value: Any) -> int:
    """Tamanho em bytes UTF-8 da forma canônica (para os tetos do §5.3.4)."""
    return len(canonical_json_stringify(value).encode("utf-8"))
