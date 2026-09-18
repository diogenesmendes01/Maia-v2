"""Classifica, com o classificador PINADO do Hermes, os corpos de erro do gateway.

Uso: python classify_gateway_errors.py <arquivo.json com [{status, body, headers?}]>
Chamado por tests/hermes-spike/hermes-inference-refusals-spike.spec.ts.
"""
import json
import sys

import httpx
import openai
from agent.error_classifier import classify_api_error

CLASSES = {
    400: openai.BadRequestError,
    401: openai.AuthenticationError,
    403: openai.PermissionDeniedError,
    404: openai.NotFoundError,
    409: openai.ConflictError,
    413: openai.APIStatusError,
    429: openai.RateLimitError,
    503: openai.InternalServerError,
}

cases = json.load(open(sys.argv[1], encoding="utf-8"))
out = []
for case in cases:
    status = case["status"]
    body = case["body"]
    req = httpx.Request("POST", "http://127.0.0.1/internal/hermes-inference/v1/chat/completions")
    resp = httpx.Response(status, json=body, headers=case.get("headers", {}), request=req)
    cls = CLASSES.get(status, openai.APIStatusError)
    msg = body.get("error", {}).get("message", "")
    err = cls(msg, response=resp, body=body)
    c = classify_api_error(err, provider="openai", model="m", base_url="http://127.0.0.1/internal/hermes-inference/v1")
    out.append({"code": body.get("error", {}).get("code"), "status": status,
                "reason": str(getattr(c.reason, "value", c.reason)), "retryable": c.retryable,
                "should_fallback": getattr(c, "should_fallback", None)})
print(json.dumps(out))
