"""Passa input_schemas pelo sanitizador PINADO do Hermes, pelo mesmo caminho do worker.

Uso: python sanitize_tool_schemas.py <arquivo.json com [{name, model, input_schema}]>
Saída: [{name, model, is_moonshot, parameters}] com o `parameters` que o Hermes
envia ao gateway. O worker registra o schema depois de `json.loads` do JSON
canônico (chaves ordenadas), e é essa ordem que o sanitizador vê; para modelo
Kimi/Moonshot o transporte (`chat_completions._base_kwargs`) reescreve de novo.
Chamado por tests/hermes-spike/hermes-schema-normalizer-spike.spec.ts.
"""
import json
import sys

from agent.moonshot_schema import is_moonshot_model, sanitize_moonshot_tools
from services.hermes_worker.canonical_json import canonical_json_stringify
from tools.schema_sanitizer import sanitize_tool_schemas

entries = json.load(open(sys.argv[1], encoding="utf-8"))
out = []
for entry in entries:
    model = entry["model"]
    params = json.loads(canonical_json_stringify(entry["input_schema"]))
    tool = {"type": "function",
            "function": {"name": entry["name"], "description": "", "parameters": params}}
    tools = sanitize_tool_schemas([tool])
    if is_moonshot_model(model):
        tools = sanitize_moonshot_tools(tools)
    out.append({"name": entry["name"], "model": model, "is_moonshot": is_moonshot_model(model),
                "parameters": tools[0]["function"]["parameters"]})
print(json.dumps(out, ensure_ascii=False))
