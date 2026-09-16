"""P00.2 (spec §4.1, §5.3.4, §6.4.2) — ESPELHO PYTHON DE ``protocol.ts``.

Os nove frames do contrato ``maia.hermes.worker.v1``, o leitor NDJSON
incremental com limites, e o escritor serializado por lock.

**Este arquivo tem uma gêmea.** ``src/integrations/hermes/protocol.ts`` é a
implementação do supervisor; esta é a do filho. As duas leem o MESMO arquivo de
casos (``tests/fixtures/hermes-wire/frames.json``) e precisam concordar caso a
caso — mesmo frame aceito, mesmo frame recusado, mesmo código de recusa. Um
schema mais frouxo de um lado é exatamente o buraco que o contrato existe para
fechar, e um teste que só exercita um dos lados não o detecta.

Por isso três coisas aqui parecem exageradas e não são:

- **A ORDEM das checagens é parte do contrato.** bytes → linha vazia → JSON
  (chave proibida) → profundidade → protocolo → tipo → direção → payload →
  schema. A fixture afirma o CÓDIGO devolvido, não só a recusa; trocar duas
  etapas de lugar muda o código de um frame que erra em duas coisas ao mesmo
  tempo. Espelha ``parseFrame`` em protocol.ts:489-569.
- **Comprimento de string conta unidade UTF-16.** O Zod mede
  ``String.prototype.length`` (zod/v3/types.js, check "max"), então um nome com
  emoji conta 2 lá e contaria 1 num ``len()`` ingênuo aqui.
- **Nenhum campo desconhecido é ignorado.** Todo objeto é fechado. Um campo
  ignorado hoje é um campo lido amanhã, e é assim que ``tenant_id``/``approved``
  vindos do modelo viram autoridade por acidente (§5.3.3).

O que este módulo NÃO é: autorização. A autenticação do canal é a POSSE do pipe
criado pelo supervisor (§4.1, §6.3). Os ``run_id`` repetidos nos frames são
CORRELAÇÃO — comparados e recusados em divergência, jamais usados para escolher
tenant, pessoa ou execução.
"""

from __future__ import annotations

import io
import json
import re
import threading
from dataclasses import dataclass
from typing import Any, Callable, Final, Literal, Mapping

from .canonical_json import (
    FORBIDDEN_JSON_KEYS,
    CanonicalJsonError,
    canonical_byte_length,
    js_json_stringify,
    utf16_length,
)

__all__ = [
    "HERMES_WORKER_PROTOCOL_VERSION",
    "WIRE_LIMITS",
    "FrameWriter",
    "NdjsonFrameReader",
    "ParsedFrame",
    "WireLimitError",
    "WireSerializeError",
    "derive_call_id",
    "parse_maia_frame",
    "parse_worker_frame",
    "serialize_frame",
]

HERMES_WORKER_PROTOCOL_VERSION: Final[str] = "maia.hermes.worker.v1"


@dataclass(frozen=True, slots=True)
class _WireLimits:
    """Tetos do transporte (§5.3.4). Espelha ``WIRE_LIMITS`` em protocol.ts:47-62.

    São decisões desta V1 e valem como RECUSA determinística — nunca
    truncamento. Truncar um frame é transformar um payload recusável num payload
    plausível.
    """

    #: Linha NDJSON inteira, em bytes UTF-8. Cobre o `start` com contexto.
    max_frame_bytes: int = 1_048_576
    #: `args` de uma tool e `result` devolvido a ela.
    max_tool_payload_bytes: int = 262_144
    #: Profundidade de aninhamento aceita antes de olhar o schema.
    max_json_depth: int = 32
    #: Teto de `call_seq` por run — o piloto é sequencial e curto.
    max_call_seq: int = 10_000
    #: Mensagens de histórico projetadas no `start`.
    max_history_messages: int = 400
    #: Texto candidato e textos de contexto.
    max_text_chars: int = 262_144
    #: Código de erro fechado (§5.3.4).
    max_error_code_chars: int = 64


WIRE_LIMITS: Final[_WireLimits] = _WireLimits()

WireErrorCode = Literal[
    "not_json",
    "forbidden_key",
    "too_large",
    "too_deep",
    "protocol_mismatch",
    "unknown_type",
    "wrong_direction",
    "schema",
]

Direction = Literal["worker_to_maia", "maia_to_worker"]


@dataclass(frozen=True, slots=True)
class ParsedFrame:
    """Resultado de uma leitura. ``kind`` é ``"ok"`` ou ``"invalid"``."""

    kind: Literal["ok", "invalid"]
    frame: Mapping[str, Any] | None = None
    code: WireErrorCode | None = None
    detail: str = ""


class WireLimitError(Exception):
    """Frame recusado por exceder um teto. Nunca truncamos para caber."""

    def __init__(self, what: str, size: int, limit: int) -> None:
        super().__init__(
            f"frame recusado: {what} com {size} bytes acima do limite de {limit} bytes"
        )
        self.what = what
        self.size = size
        self.limit = limit


class WireSerializeError(Exception):
    """Frame que a própria Maia/worker tentou emitir e não satisfaz o schema."""


# ─── validação de schema ────────────────────────────────────────────────────

_UUID_RE: Final = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)
_SHA256_RE: Final = re.compile(r"^[0-9a-f]{64}$")
_SHA1_RE: Final = re.compile(r"^[0-9a-f]{40}$")
#: Inteiro decimal não negativo como STRING — dinheiro nunca em float (§5.3.1).
_DECIMAL_UINT_RE: Final = re.compile(r"^(0|[1-9][0-9]*)$")

# Recomposto a partir de zod/v3/types.js (`dateRegexSource` + `timeRegexSource` +
# `datetimeRegex`) para `z.string().datetime({ offset: false })`, que é o que o
# TS usa. Segundos são OPCIONAIS nesse regex e o sufixo `Z` é obrigatório —
# copiado como está, não "melhorado": o objetivo é aceitar exatamente o mesmo
# conjunto de instantes que o supervisor aceita.
_ZOD_DATE_SRC: Final = (
    r"((\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)"
    r"-02-29|\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\d|3[01])|(0[469]|11)-"
    r"(0[1-9]|[12]\d|30)|(02)-(0[1-9]|1\d|2[0-8])))"
)
_ZOD_TIME_SRC: Final = r"([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?"
_ISO_INSTANT_RE: Final = re.compile(rf"^{_ZOD_DATE_SRC}T{_ZOD_TIME_SRC}(Z)$")

_HTTP_URL_RE: Final = re.compile(r"^https?://[^/?#\s]+")

Validator = Callable[[Any, str], None]


class _SchemaError(Exception):
    def __init__(self, path: str, code: str) -> None:
        super().__init__(f"{path or 'frame'}: {code}")
        self.path = path
        self.code = code


def _is_js_integer(value: Any) -> bool:
    """``Number.isInteger`` do JS sobre um valor já lido do JSON.

    O JS lê ``1.0`` como o inteiro ``1``; o Python lê como ``float``. Sem esta
    equivalência, um ``call_seq: 1.0`` seria aceito lá e recusado aqui.
    """
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and value.is_integer()


def _literal(expected: Any) -> Validator:
    def check(value: Any, path: str) -> None:
        if value != expected or type(value) is not type(expected):
            raise _SchemaError(path, "invalid_literal")

    return check


def _enum(*allowed: str) -> Validator:
    options = frozenset(allowed)

    def check(value: Any, path: str) -> None:
        if not isinstance(value, str) or value not in options:
            raise _SchemaError(path, "invalid_enum_value")

    return check


def _boolean() -> Validator:
    def check(value: Any, path: str) -> None:
        if not isinstance(value, bool):
            raise _SchemaError(path, "invalid_type")

    return check


def _string(
    *,
    min_len: int | None = None,
    max_len: int | None = None,
    pattern: re.Pattern[str] | None = None,
    refine: Callable[[str], bool] | None = None,
) -> Validator:
    def check(value: Any, path: str) -> None:
        if not isinstance(value, str):
            raise _SchemaError(path, "invalid_type")
        length = utf16_length(value)
        if min_len is not None and length < min_len:
            raise _SchemaError(path, "too_small")
        if max_len is not None and length > max_len:
            raise _SchemaError(path, "too_big")
        if pattern is not None and not pattern.match(value):
            raise _SchemaError(path, "invalid_string")
        if refine is not None and not refine(value):
            raise _SchemaError(path, "custom")

    return check


def _integer(*, minimum: int | None = None, maximum: int | None = None) -> Validator:
    def check(value: Any, path: str) -> None:
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise _SchemaError(path, "invalid_type")
        if not _is_js_integer(value):
            raise _SchemaError(path, "not_finite" if value != value else "invalid_type")
        number = int(value)
        if minimum is not None and number < minimum:
            raise _SchemaError(path, "too_small")
        if maximum is not None and number > maximum:
            raise _SchemaError(path, "too_big")

    return check


def _nullable(inner: Validator) -> Validator:
    def check(value: Any, path: str) -> None:
        if value is None:
            return
        inner(value, path)

    return check


def _array(item: Validator, *, max_items: int | None = None) -> Validator:
    def check(value: Any, path: str) -> None:
        if not isinstance(value, list):
            raise _SchemaError(path, "invalid_type")
        if max_items is not None and len(value) > max_items:
            raise _SchemaError(path, "too_big")
        for index, entry in enumerate(value):
            item(entry, f"{path}.{index}" if path else str(index))

    return check


def _object(fields: Mapping[str, Validator]) -> Validator:
    """Objeto FECHADO: chave desconhecida recusa o frame, nunca é ignorada."""

    def check(value: Any, path: str) -> None:
        if not isinstance(value, dict):
            raise _SchemaError(path, "invalid_type")
        for key in value:
            if key not in fields:
                raise _SchemaError(f"{path}.{key}" if path else key, "unrecognized_keys")
        for key, validator in fields.items():
            if key not in value:
                raise _SchemaError(f"{path}.{key}" if path else key, "invalid_type")
            validator(value[key], f"{path}.{key}" if path else key)

    return check


def _discriminated_union(
    discriminator: str, variants: Mapping[str, Validator]
) -> Validator:
    def check(value: Any, path: str) -> None:
        if not isinstance(value, dict):
            raise _SchemaError(path, "invalid_type")
        tag = value.get(discriminator)
        validator = variants.get(tag) if isinstance(tag, str) else None
        if validator is None:
            raise _SchemaError(path, "invalid_union_discriminator")
        validator(value, path)

    return check


def _json_value(value: Any, path: str) -> None:
    if value is None or isinstance(value, (bool, str)):
        return
    if isinstance(value, (int, float)):
        # `z.number().finite()`: NaN/Infinity não são JSON e não passam.
        if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
            raise _SchemaError(path, "not_finite")
        return
    if isinstance(value, list):
        for index, entry in enumerate(value):
            _json_value(entry, f"{path}.{index}")
        return
    if isinstance(value, dict):
        for key, entry in value.items():
            if not isinstance(key, str):
                raise _SchemaError(path, "invalid_type")
            _json_value(entry, f"{path}.{key}")
        return
    raise _SchemaError(path, "invalid_type")


def _json_object(value: Any, path: str) -> None:
    if not isinstance(value, dict):
        raise _SchemaError(path, "invalid_type")
    _json_value(value, path)


_uuid = _string(pattern=_UUID_RE)
_sha256 = _string(pattern=_SHA256_RE)
_sha1 = _string(pattern=_SHA1_RE)
_iso_instant = _string(pattern=_ISO_INSTANT_RE)
_call_seq = _integer(minimum=0, maximum=WIRE_LIMITS.max_call_seq)


def _short_text(max_len: int) -> Validator:
    return _string(min_len=1, max_len=max_len)


# ─── worker → Maia ──────────────────────────────────────────────────────────

_READY = _object(
    {
        "protocol": _literal(HERMES_WORKER_PROTOCOL_VERSION),
        "type": _literal("ready"),
        "run_id": _uuid,
        "worker": _object(
            {
                "bridge_revision": _short_text(128),
                "hermes_sha": _sha1,
                "python_version": _short_text(64),
            }
        ),
        # Superfície EFETIVA observada no agente construído (§6.6 invariante 2).
        "effective_tool_names": _array(_short_text(256), max_items=128),
        "tool_schema_digest": _sha256,
    }
)

_TOOL_REQUEST = _object(
    {
        "protocol": _literal(HERMES_WORKER_PROTOCOL_VERSION),
        "type": _literal("tool.request"),
        "run_id": _uuid,
        "call_seq": _call_seq,
        "name": _short_text(256),
        "args": _json_object,
        # Diagnóstico apenas: a sessão Hermes pode rotacionar por compressão.
        "observed_session_id": _nullable(_string(max_len=256)),
    }
)

_PROGRESS = _object(
    {
        "protocol": _literal(HERMES_WORKER_PROTOCOL_VERSION),
        "type": _literal("progress"),
        "run_id": _uuid,
        "seq": _integer(minimum=0, maximum=100_000),
        "event": _enum("tool_start", "tool_complete", "iteration_started"),
        "call_seq": _nullable(_call_seq),
        "tool_name": _nullable(_string(max_len=256)),
    }
)

_CANCEL_ACK = _object(
    {
        "protocol": _literal(HERMES_WORKER_PROTOCOL_VERSION),
        "type": _literal("cancel_ack"),
        "run_id": _uuid,
        "received_at": _iso_instant,
    }
)

#: Desfecho deliberativo (§5.3.1 ``EngineStopV1``). `reply` exige texto não vazio
#: DEPOIS de `trim`: vazio é `no_reply/empty_final_text`, nunca "anúncio
#: sozinho" (§5.3.4).
_STOP = _discriminated_union(
    "kind",
    {
        "reply": _object(
            {
                "kind": _literal("reply"),
                "raw_text": _string(
                    min_len=1,
                    max_len=WIRE_LIMITS.max_text_chars,
                    refine=lambda text: len(text.strip()) > 0,
                ),
            }
        ),
        "no_reply": _object(
            {
                "kind": _literal("no_reply"),
                "reason": _enum("empty_final_text", "iteration_cap"),
            }
        ),
        "failed": _object(
            {
                "kind": _literal("failed"),
                "code": _enum("reasoner_failed", "deadline_exceeded", "protocol_error"),
            }
        ),
        "cancelled": _object(
            {
                "kind": _literal("cancelled"),
                "reason": _enum("ownership_lost", "operator", "shutdown"),
            }
        ),
    },
)

_RESULT = _object(
    {
        "protocol": _literal(HERMES_WORKER_PROTOCOL_VERSION),
        "type": _literal("result"),
        "run_id": _uuid,
        "request_key": _uuid,
        "stop": _STOP,
        "iterations": _integer(minimum=0, maximum=1_000),
        # O que o worker AFIRMA ter chamado. Não é evidência: o assembler compara
        # com o journal da Maia e recusa divergência (§5.3.4).
        "observed_tool_call_seqs": _array(_call_seq, max_items=256),
        "usage": _object(
            {
                "input_tokens": _nullable(_integer(minimum=0)),
                "output_tokens": _nullable(_integer(minimum=0)),
                "cost_microusd": _nullable(_string(pattern=_DECIMAL_UINT_RE)),
                "source": _enum("provider_accounted", "engine_reported", "unavailable"),
            }
        ),
        # Rota/telemetria observada; confrontada com a seleção autorizada (§6.8).
        "observed": _object(
            {
                "model": _nullable(_string(max_len=256)),
                "provider": _nullable(_string(max_len=64)),
                "final_session_id": _nullable(_string(max_len=256)),
                "turn_exit_reason": _nullable(
                    _string(max_len=WIRE_LIMITS.max_error_code_chars)
                ),
                "failure_code": _nullable(
                    _string(max_len=WIRE_LIMITS.max_error_code_chars)
                ),
            }
        ),
    }
)

# ─── Maia → worker ──────────────────────────────────────────────────────────

#: Projeção do manifest para o FILHO: só o necessário para registrar as tools.
#: O manifest completo do §4.2 (classes de efeito, alvos de autorização, limites
#: monetários, refs de política) é dado interno da Maia e NÃO desce ao worker.
_MANIFEST_PROJECTION = _object(
    {
        "schema": _literal("maia-hermes-runtime-manifest/v1"),
        "tools": _array(
            _object(
                {
                    "name": _short_text(256),
                    "input_schema": _json_object,
                    "result_limit_chars": _integer(minimum=1, maximum=1_000_000),
                }
            ),
            max_items=64,
        ),
        "result_limit_chars": _integer(minimum=1, maximum=1_000_000),
    }
)

_START = _object(
    {
        "protocol": _literal(HERMES_WORKER_PROTOCOL_VERSION),
        "type": _literal("start"),
        "run_id": _uuid,
        "request_key": _uuid,
        "binding": _object(
            {
                # `execution_id` é o MESMO uuid do run (§4.1).
                "execution_id": _uuid,
                "task_id": _short_text(128),
                "initial_session_id": _short_text(128),
                "manifest_digest": _sha256,
                "mode": _enum("live", "shadow"),
            }
        ),
        "manifest": _MANIFEST_PROJECTION,
        "context": _object(
            {
                "system": _string(min_len=1, max_len=WIRE_LIMITS.max_text_chars),
                "user_message": _string(min_len=1, max_len=WIRE_LIMITS.max_text_chars),
                # Histórico TEXTUAL canônico (§4.1): na primeira coorte não viajam
                # blocos de tool_use/tool_result antigos — pares sem id válido no
                # motor de destino seriam reconstruídos adivinhando correlação.
                "history": _array(
                    _object(
                        {
                            "role": _enum("user", "assistant"),
                            "text": _string(max_len=WIRE_LIMITS.max_text_chars),
                        }
                    ),
                    max_items=WIRE_LIMITS.max_history_messages,
                ),
            }
        ),
        "limits": _object(
            {
                "max_iterations": _integer(minimum=1, maximum=50),
                "max_output_tokens_per_call": _integer(minimum=1, maximum=200_000),
                "max_tool_calls": _integer(
                    minimum=1, maximum=WIRE_LIMITS.max_call_seq
                ),
                "max_inference_calls": _integer(minimum=1, maximum=1_000),
                "run_budget_seconds": _integer(minimum=1, maximum=3_600),
                "deadline_at": _iso_instant,
            }
        ),
        # A credencial curta de inferência (§9.1) chega ao filho por variável de
        # ambiente allowlisted no spawn, nunca por frame: o objeto é FECHADO para
        # que `api_key`/`token`/`authorization` façam um teste falhar em vez de
        # vazarem em produção.
        "inference": _object(
            {
                "base_url": _string(
                    pattern=_HTTP_URL_RE, refine=lambda url: "@" not in url
                ),
                "model": _short_text(256),
                "provider": _short_text(64),
                "api_mode": _literal("chat_completions"),
            }
        ),
    }
)

_TOOL_RESULT = _object(
    {
        "protocol": _literal(HERMES_WORKER_PROTOCOL_VERSION),
        "type": _literal("tool.result"),
        "run_id": _uuid,
        "call_seq": _call_seq,
        "outcome": _discriminated_union(
            "kind",
            {
                "result": _object(
                    {
                        "kind": _literal("result"),
                        "result": _json_value,
                        "is_error": _boolean(),
                    }
                ),
                "in_progress": _object(
                    {
                        "kind": _literal("in_progress"),
                        "retry_after_ms": _integer(minimum=1, maximum=60_000),
                    }
                ),
                "refused": _object(
                    {
                        "kind": _literal("refused"),
                        "code": _enum(
                            "run_not_authorized",
                            "tool_not_allowed",
                            "payload_conflict",
                            "budget_exhausted",
                            "effect_unknown",
                            "protocol_error",
                        ),
                    }
                ),
            },
        ),
    }
)

_CANCEL = _object(
    {
        "protocol": _literal(HERMES_WORKER_PROTOCOL_VERSION),
        "type": _literal("cancel"),
        "run_id": _uuid,
        # Categoria fechada. Texto do cliente NUNCA vira instrução de controle.
        "reason": _enum("ownership_lost", "operator", "deadline", "shutdown", "policy"),
        "grace_deadline_at": _iso_instant,
    }
)

_RESULT_ACK = _object(
    {
        "protocol": _literal(HERMES_WORKER_PROTOCOL_VERSION),
        "type": _literal("result_ack"),
        "run_id": _uuid,
        "terminal_digest": _sha256,
    }
)

WORKER_TO_MAIA_SCHEMAS: Final[Mapping[str, Validator]] = {
    "ready": _READY,
    "tool.request": _TOOL_REQUEST,
    "progress": _PROGRESS,
    "cancel_ack": _CANCEL_ACK,
    "result": _RESULT,
}

MAIA_TO_WORKER_SCHEMAS: Final[Mapping[str, Validator]] = {
    "start": _START,
    "tool.result": _TOOL_RESULT,
    "cancel": _CANCEL,
    "result_ack": _RESULT_ACK,
}

WORKER_TO_MAIA_TYPES: Final[tuple[str, ...]] = tuple(WORKER_TO_MAIA_SCHEMAS)
MAIA_TO_WORKER_TYPES: Final[tuple[str, ...]] = tuple(MAIA_TO_WORKER_SCHEMAS)


# ─── leitura ────────────────────────────────────────────────────────────────


class _ForbiddenKey(Exception):
    def __init__(self, key: str) -> None:
        super().__init__(key)
        self.key = key


class _NotJson(Exception):
    pass


def _object_pairs_hook(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in FORBIDDEN_JSON_KEYS:
            raise _ForbiddenKey(key)
        result[key] = value
    return result


def _reject_constant(name: str) -> Any:
    # `JSON.parse` do JS recusa NaN/Infinity com SyntaxError; o `json` do Python
    # os aceita por default. Sem isto, um `NaN` viraria frame válido de um lado
    # e lixo do outro.
    raise _NotJson(name)


def _parse_json_line(line: str) -> ParsedFrame:
    try:
        value = json.loads(
            line, object_pairs_hook=_object_pairs_hook, parse_constant=_reject_constant
        )
    except _ForbiddenKey as exc:
        return ParsedFrame("invalid", code="forbidden_key", detail=exc.key)
    except (_NotJson, ValueError):
        return ParsedFrame(
            "invalid", code="not_json", detail="linha não é JSON válido"
        )
    except RecursionError:
        # Aninhamento absurdo: o V8 também estoura e cai em SyntaxError.
        return ParsedFrame("invalid", code="not_json", detail="aninhamento não parseável")
    if not isinstance(value, dict):
        return ParsedFrame(
            "invalid", code="not_json", detail="frame precisa ser objeto JSON"
        )
    return ParsedFrame("ok", frame=value)


def _exceeds_depth(value: Any, max_depth: int, depth: int = 0) -> bool:
    if depth > max_depth:
        return True
    if isinstance(value, list):
        return any(_exceeds_depth(item, max_depth, depth + 1) for item in value)
    if isinstance(value, dict):
        return any(_exceeds_depth(item, max_depth, depth + 1) for item in value.values())
    return False


def _payload_too_large(frame: Mapping[str, Any]) -> str | None:
    frame_type = frame.get("type")
    try:
        if frame_type == "tool.request" and "args" in frame:
            if canonical_byte_length(frame["args"]) > WIRE_LIMITS.max_tool_payload_bytes:
                return "args"
        if frame_type == "tool.result":
            outcome = frame.get("outcome")
            if (
                isinstance(outcome, dict)
                and outcome.get("kind") == "result"
                and "result" in outcome
            ):
                if (
                    canonical_byte_length(outcome["result"])
                    > WIRE_LIMITS.max_tool_payload_bytes
                ):
                    return "outcome.result"
    except CanonicalJsonError:
        # Conteúdo fora do domínio JSON canônico: o schema recusa adiante com
        # detalhe melhor do que "too_large".
        return None
    return None


_TRAILING_NEWLINE_RE: Final = re.compile(r"\r?\n$")


def _parse_frame(raw: str | bytes, direction: Direction) -> ParsedFrame:
    if isinstance(raw, bytes):
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            return ParsedFrame("invalid", code="not_json", detail="bytes não são UTF-8")
    else:
        text = raw
    line = _TRAILING_NEWLINE_RE.sub("", text)

    size = len(line.encode("utf-8", "surrogatepass"))
    if size > WIRE_LIMITS.max_frame_bytes:
        return ParsedFrame(
            "invalid",
            code="too_large",
            detail=f"frame com {size} bytes acima do teto {WIRE_LIMITS.max_frame_bytes}",
        )
    if not line.strip():
        return ParsedFrame("invalid", code="not_json", detail="linha vazia")

    parsed = _parse_json_line(line)
    if parsed.kind == "invalid":
        return parsed
    frame = parsed.frame
    assert frame is not None  # o ramo "ok" sempre traz o objeto

    if _exceeds_depth(frame, WIRE_LIMITS.max_json_depth):
        return ParsedFrame(
            "invalid", code="too_deep", detail="aninhamento acima do limite"
        )

    if frame.get("protocol") != HERMES_WORKER_PROTOCOL_VERSION:
        return ParsedFrame(
            "invalid",
            code="protocol_mismatch",
            detail=f"protocolo não é {HERMES_WORKER_PROTOCOL_VERSION}",
        )

    frame_type = frame.get("type")
    if not isinstance(frame_type, str):
        return ParsedFrame("invalid", code="unknown_type", detail="type ausente")

    own = (
        WORKER_TO_MAIA_SCHEMAS
        if direction == "worker_to_maia"
        else MAIA_TO_WORKER_SCHEMAS
    )
    other = (
        MAIA_TO_WORKER_SCHEMAS
        if direction == "worker_to_maia"
        else WORKER_TO_MAIA_SCHEMAS
    )

    if frame_type not in own:
        if frame_type in other:
            return ParsedFrame(
                "invalid",
                code="wrong_direction",
                detail=f'frame "{frame_type}" não trafega nesse sentido',
            )
        return ParsedFrame(
            "invalid", code="unknown_type", detail=f"tipo desconhecido: {frame_type}"
        )

    oversized = _payload_too_large(frame)
    if oversized:
        return ParsedFrame(
            "invalid",
            code="too_large",
            detail=f"{oversized} acima do teto {WIRE_LIMITS.max_tool_payload_bytes} bytes",
        )

    try:
        own[frame_type](frame, "")
    except _SchemaError as exc:
        # Só o CAMINHO e o código do problema: a mensagem não pode ecoar o valor
        # recebido, que aqui é conteúdo de conversa.
        return ParsedFrame(
            "invalid", code="schema", detail=f"{exc.path or 'frame'}: {exc.code}"
        )
    return ParsedFrame("ok", frame=frame)


def parse_worker_frame(raw: str | bytes) -> ParsedFrame:
    """Lê um frame emitido pelo worker (o que a Maia recebe pelo pipe)."""
    return _parse_frame(raw, "worker_to_maia")


def parse_maia_frame(raw: str | bytes) -> ParsedFrame:
    """Lê um frame emitido pela Maia (o que o worker recebe)."""
    return _parse_frame(raw, "maia_to_worker")


class NdjsonFrameReader:
    """Leitor NDJSON incremental com teto de linha — recusa sem truncar.

    A diferença entre "recusar" e "truncar" é a razão de esta classe existir em
    vez de um ``for line in stream``: uma linha acima do teto é DESCARTADA
    inteira e o leitor ressincroniza no próximo ``\\n``. Entregar os primeiros
    1 MiB de uma linha de 2 MiB ao schema é oferecer um payload plausível
    fabricado pelo próprio transporte.
    """

    def __init__(
        self,
        direction: Direction,
        *,
        max_frame_bytes: int = WIRE_LIMITS.max_frame_bytes,
    ) -> None:
        self._direction: Direction = direction
        self._max_frame_bytes = max_frame_bytes
        self._buffer = bytearray()
        self._skipping = False

    def feed(self, chunk: bytes) -> list[ParsedFrame]:
        """Consome bytes do pipe e devolve os frames completos que saíram deles."""
        out: list[ParsedFrame] = []
        position = 0
        while position < len(chunk):
            newline = chunk.find(b"\n", position)
            if newline == -1:
                segment = chunk[position:]
                position = len(chunk)
                if self._skipping:
                    continue
                self._buffer.extend(segment)
                if len(self._buffer) > self._max_frame_bytes:
                    out.append(self._overflow())
                continue

            segment = chunk[position:newline]
            position = newline + 1
            if self._skipping:
                # Fim da linha gigante: volta a ler normalmente na próxima.
                self._skipping = False
                self._buffer.clear()
                continue
            self._buffer.extend(segment)
            if len(self._buffer) > self._max_frame_bytes:
                out.append(self._overflow())
                self._skipping = False
                self._buffer.clear()
                continue
            line = bytes(self._buffer)
            self._buffer.clear()
            out.append(_parse_frame(line, self._direction))
        return out

    def close(self) -> list[ParsedFrame]:
        """Fecha o fluxo: uma última linha sem ``\\n`` ainda é um frame."""
        if self._skipping:
            self._skipping = False
            self._buffer.clear()
            return []
        if not self._buffer:
            return []
        line = bytes(self._buffer)
        self._buffer.clear()
        return [_parse_frame(line, self._direction)]

    def _overflow(self) -> ParsedFrame:
        size = len(self._buffer)
        self._buffer.clear()
        self._skipping = True
        return ParsedFrame(
            "invalid",
            code="too_large",
            detail=f"linha com ao menos {size} bytes acima do teto {self._max_frame_bytes}",
        )


# ─── serialização ───────────────────────────────────────────────────────────


def serialize_frame(frame: Mapping[str, Any]) -> str:
    """Emite UMA linha NDJSON. Recusa (lança) em vez de truncar.

    Truncar um frame é transformar um payload recusável num payload plausível.
    Espelha ``serializeFrame`` (protocol.ts:594-626).
    """
    frame_type = frame.get("type") if isinstance(frame, Mapping) else None
    validator = None
    if isinstance(frame_type, str):
        validator = MAIA_TO_WORKER_SCHEMAS.get(frame_type) or WORKER_TO_MAIA_SCHEMAS.get(
            frame_type
        )
    if validator is None:
        raise WireSerializeError(
            f"serialize_frame: tipo de frame desconhecido ({frame_type!r})"
        )

    try:
        validator(frame, "")
    except _SchemaError as exc:
        raise WireSerializeError(
            f"serialize_frame: frame inválido em {exc.path or 'frame'} ({exc.code})"
        ) from None

    oversized = _payload_too_large(frame)
    if oversized:
        root = oversized.split(".")[0]
        raise WireLimitError(
            oversized,
            canonical_byte_length(frame[root]),
            WIRE_LIMITS.max_tool_payload_bytes,
        )

    line = js_json_stringify(frame)
    size = len(line.encode("utf-8"))
    if size > WIRE_LIMITS.max_frame_bytes:
        raise WireLimitError("frame", size, WIRE_LIMITS.max_frame_bytes)
    return line + "\n"


class FrameWriter:
    """Escritor serializado por lock sobre o FD privado do protocolo.

    O lock protege a ATOMICIDADE da linha: duas threads escrevendo frames
    intercalados produziriam NDJSON corrompido. Ele nunca é segurado enquanto se
    espera resultado de tool (§6.4.2) — o único trabalho feito sob o lock é
    serializar e escrever bytes já prontos.
    """

    def __init__(self, stream: io.RawIOBase | io.BufferedIOBase) -> None:
        self._stream = stream
        self._lock = threading.Lock()
        self._closed = False

    def send(self, frame: Mapping[str, Any]) -> None:
        payload = serialize_frame(frame).encode("utf-8")
        with self._lock:
            if self._closed:
                raise WireSerializeError("canal do protocolo já fechado")
            self._stream.write(payload)
            flush = getattr(self._stream, "flush", None)
            if flush is not None:
                flush()

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            try:
                self._stream.close()
            except OSError:
                pass


def derive_call_id(run_id: str, call_seq: int) -> str:
    """``call_id`` do journal (§4.1): derivado, nunca recebido.

    Falha ALTO em entrada malformada — um call_id inválido quebraria a unicidade
    que o journal usa para reconhecer redelivery.
    """
    if not isinstance(run_id, str) or not _UUID_RE.match(run_id):
        raise ValueError("derive_call_id: run_id precisa ser UUID")
    if (
        isinstance(call_seq, bool)
        or not isinstance(call_seq, int)
        or call_seq < 0
        or call_seq > WIRE_LIMITS.max_call_seq
    ):
        raise ValueError("derive_call_id: call_seq precisa ser inteiro em [0, max]")
    return f"{run_id.lower()}:{call_seq}"
