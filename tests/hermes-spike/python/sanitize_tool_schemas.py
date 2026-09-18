"""Passa input_schemas pelo sanitizador PINADO do Hermes, pelo mesmo caminho do worker.

Uso: python sanitize_tool_schemas.py <arquivo.json com [{name, input_schema}]>
Saída: [{name, parameters}] com o `parameters` que o Hermes envia ao gateway.
O worker registra o schema depois de `json.loads` do JSON canônico (chaves
ordenadas), e é essa ordem que o sanitizador vê.
Chamado por tests/hermes-spike/hermes-schema-normalizer-spike.spec.ts.
"""
import json
import sys

from services.hermes_worker.canonical_json import canonical_json_stringify
from tools.schema_sanitizer import sanitize_tool_schemas

entries = json.load(open(sys.argv[1], encoding="utf-8"))
out = []
for entry in entries:
    params = json.loads(canonical_json_stringify(entry["input_schema"]))
    tool = {"type": "function",
            "function": {"name": entry["name"], "description": "", "parameters": params}}
    sanitized = sanitize_tool_schemas([tool])[0]["function"]["parameters"]
    out.append({"name": entry["name"], "parameters": sanitized})
print(json.dumps(out, ensure_ascii=False))
