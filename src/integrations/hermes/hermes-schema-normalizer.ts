/**
 * P06 (spec §9.1 validação 4) — o schema de tool que o cliente Hermes PINADO
 * realmente envia ao gateway.
 *
 * O Hermes (SHA `5d59366`) não repassa o `input_schema` do manifest: antes de
 * cada chamada, `model_tools._compute_tool_definitions` passa as tools por
 * `tools/schema_sanitizer.sanitize_tool_schemas`, que colapsa uniões anuláveis,
 * normaliza `type` em array, dá `properties: {}` a todo objeto, remove
 * combinadores do topo e `default` ao lado de `$ref`. O gateway confere o digest
 * do schema RECEBIDO; para conferir contra o manifest, a superfície do grant é
 * calculada sobre o mesmo resultado.
 *
 * Este módulo é o porte fiel de `_sanitize_single_tool` para o `parameters`,
 * com uma exceção FECHADA: chave de propriedade fora de `^[a-zA-Z0-9_.-]{1,64}$`
 * o Hermes renomeia (e desfaz na volta), o que mudaria o nome dos args que o
 * modelo devolve — aqui é recusa. `__proto__` em qualquer ponto também.
 *
 * A ordem de iteração é a do Python depois de `json.loads` do JSON canônico que
 * o worker registra (chaves ordenadas por unidade UTF-16, a mesma do `sort()`
 * do JS); ela decide a ordem do `required` herdado e quem vence entre `type` em
 * array e `anyOf`/`nullable` do mesmo nó.
 *
 * Para modelo Kimi/Moonshot o transporte do Hermes aplica ainda
 * `agent/moonshot_schema.sanitize_moonshot_tools`, também portado aqui: a
 * superfície depende do modelo do grant.
 *
 * Paridade provada contra o Python real em
 * `tests/hermes-spike/hermes-schema-normalizer-spike.spec.ts`.
 */

export class HermesSchemaUnsupportedError extends TypeError {
  constructor(motivo: string) {
    super(`schema de tool fora do que o gateway confere: ${motivo}`);
    this.name = 'HermesSchemaUnsupportedError';
  }
}

type Obj = Record<string, unknown>;

const PROP_KEY_RE = /^[a-zA-Z0-9_.-]{1,64}$/;
const UNION_KEYS = ['anyOf', 'oneOf'] as const;
const UNION_META_KEYS = ['title', 'description', 'default', 'examples'] as const;
const TOP_LEVEL_FORBIDDEN_KEYS = ['allOf', 'anyOf', 'oneOf', 'enum', 'not'] as const;
const BARE_TYPE_NAMES = new Set([
  'object',
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'null',
]);
const NON_SCHEMA_LIST_KEYS = new Set(['required', 'enum', 'examples', 'dependentRequired']);
const SCHEMA_MAP_KEYS = new Set([
  'properties',
  '$defs',
  'definitions',
  'patternProperties',
  'dependentSchemas',
]);
const SCHEMA_CHILD_KEYS = new Set([
  'items',
  'additionalItems',
  'additionalProperties',
  'unevaluatedItems',
  'unevaluatedProperties',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'anyOf',
  'oneOf',
  'allOf',
  'prefixItems',
]);

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Obj, k: string) => Object.hasOwn(o, k);
const keysOf = (o: Obj) => Object.keys(o).sort();
const emptyObject = (): Obj => ({ type: 'object', properties: {} });

function clone(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clone);
  if (isObj(v)) {
    const out: Obj = {};
    for (const k of keysOf(v)) out[k] = clone(v[k]);
    return out;
  }
  return v;
}

/** `__proto__` não vira chave de objeto em lugar nenhum. */
function assertSafeKeys(v: unknown): void {
  if (Array.isArray(v)) {
    for (const x of v) assertSafeKeys(x);
    return;
  }
  if (!isObj(v)) return;
  for (const k of Object.keys(v)) {
    if (k === '__proto__') throw new HermesSchemaUnsupportedError('chave __proto__');
    assertSafeKeys(v[k]);
  }
}

/** Mapa de baixo para cima: listas e objetos recursam, depois `fn` vê cada objeto. */
function rewrite(schema: unknown, fn: (o: Obj) => unknown): unknown {
  if (Array.isArray(schema)) return schema.map((x) => rewrite(x, fn));
  if (!isObj(schema)) return schema;
  const out: Obj = {};
  for (const k of keysOf(schema)) out[k] = rewrite(schema[k], fn);
  return fn(out);
}

function normalizeTypeArray(value: unknown[], out: Obj): void {
  const hasNull = value.includes('null');
  const nonNull = value.filter((t): t is string => typeof t === 'string' && t !== 'null');
  if (nonNull.length === 0) {
    out.type = hasNull ? 'null' : 'object';
    return;
  }
  if (nonNull.length === 1) out.type = nonNull[0];
  else out.anyOf = nonNull.map((t) => ({ type: t }));
  if (hasNull && !own(out, 'nullable')) out.nullable = true;
}

function sanitizeNode(node: unknown): unknown {
  if (typeof node === 'string') {
    if (!BARE_TYPE_NAMES.has(node) || node === 'object') return emptyObject();
    return { type: node };
  }
  if (Array.isArray(node)) return node.map(sanitizeNode);
  if (!isObj(node)) return node;

  const propsIn = isObj(node.properties) ? node.properties : undefined;
  if (propsIn) {
    for (const k of Object.keys(propsIn)) {
      if (!PROP_KEY_RE.test(k)) throw new HermesSchemaUnsupportedError('nome de propriedade');
    }
  }
  const out: Obj = {};
  for (const key of keysOf(node)) {
    const value = node[key];
    if (key === 'type' && Array.isArray(value)) {
      normalizeTypeArray(value, out);
    } else if (SCHEMA_MAP_KEYS.has(key) && isObj(value)) {
      const m: Obj = {};
      for (const k of keysOf(value)) m[k] = sanitizeNode(value[k]);
      out[key] = m;
    } else if (key === 'dependencies' && isObj(value)) {
      const m: Obj = {};
      for (const k of keysOf(value))
        m[k] = isObj(value[k]) ? sanitizeNode(value[k]) : clone(value[k]);
      out[key] = m;
    } else if (key === 'items' || key === 'additionalProperties') {
      out[key] = typeof value === 'boolean' ? value : sanitizeNode(value);
    } else if (NON_SCHEMA_LIST_KEYS.has(key)) {
      // `required: true` de propriedade é içado pelo pai, abaixo.
      if (key === 'required' && typeof value === 'boolean') continue;
      out[key] = clone(value);
    } else if (SCHEMA_CHILD_KEYS.has(key)) {
      out[key] = sanitizeNode(value);
    } else {
      out[key] = clone(value);
    }
  }
  if (propsIn) {
    const lifted = keysOf(propsIn).filter((k) => {
      const p = propsIn[k];
      return isObj(p) && p.required === true;
    });
    if (lifted.length > 0) {
      const required = Array.isArray(out.required) ? (out.required as unknown[]) : [];
      out.required = [...required, ...lifted.filter((k) => !required.includes(k))];
    }
  }
  if (out.type === 'object') {
    if (!isObj(out.properties)) out.properties = {};
    if (Array.isArray(out.required)) {
      const props = out.properties as Obj;
      const valid = (out.required as unknown[]).filter(
        (r) => typeof r === 'string' && own(props, r),
      );
      if (valid.length > 0) out.required = valid;
      else delete out.required;
    }
  }
  return out;
}

const isNullBranch = (item: unknown) => isObj(item) && item.type === 'null';

function carryUnionMeta(outer: Obj, replacement: Obj): void {
  for (const k of UNION_META_KEYS) {
    if (own(outer, k) && !own(replacement, k) && !(k === 'default' && own(replacement, '$ref'))) {
      replacement[k] = outer[k];
    }
  }
}

/** União anulável com um só ramo não nulo vira o ramo, com `nullable: true`. */
function stripNullableUnions(schema: unknown): unknown {
  const collapse = (stripped: Obj): unknown => {
    for (const key of UNION_KEYS) {
      const variants = stripped[key];
      if (!Array.isArray(variants)) continue;
      const nonNull = variants.filter((i) => !isNullBranch(i));
      if (nonNull.length === 1 && nonNull.length !== variants.length) {
        const first = nonNull[0];
        const replacement: Obj = isObj(first) ? { ...first } : {};
        if (!own(replacement, 'nullable')) replacement.nullable = true;
        carryUnionMeta(stripped, replacement);
        return rewrite(replacement, collapse);
      }
    }
    return stripped;
  };
  return rewrite(schema, collapse);
}

function stripRefSiblings(node: unknown): unknown {
  return rewrite(node, (o) => {
    if (own(o, '$ref')) delete o.default;
    return o;
  });
}

/** `_sanitize_single_tool` do `tools/schema_sanitizer.py`, para o `parameters`. */
function genericParameters(inputSchema: unknown): Obj {
  if (!isObj(inputSchema)) return emptyObject();
  const sanitized = sanitizeNode(inputSchema);
  let top: Obj = isObj(sanitized) ? sanitized : {};
  top.type = 'object';
  if (!isObj(top.properties)) top.properties = {};
  const collapsed = stripNullableUnions(top);
  top = isObj(collapsed) ? { ...collapsed } : {};
  for (const k of TOP_LEVEL_FORBIDDEN_KEYS) delete top[k];
  return stripRefSiblings(top) as Obj;
}

// ─── Moonshot (Kimi) ────────────────────────────────────────────────────────
// `agent/transports/chat_completions._base_kwargs` aplica, DEPOIS do genérico,
// `agent/moonshot_schema.sanitize_moonshot_tools` quando `is_moonshot_model`.

/** `agent/moonshot_schema.is_moonshot_model`. */
export function isMoonshotModel(model: string | null | undefined): boolean {
  if (!model) return false;
  const bare = model.trim().toLowerCase();
  const tail = bare.slice(bare.lastIndexOf('/') + 1);
  if (tail.startsWith('kimi-') || tail === 'kimi') return true;
  if (tail === 'k3' || tail.startsWith('k3.') || tail.startsWith('k3-')) return true;
  return bare.includes('moonshot') || bare.includes('/kimi') || bare.startsWith('kimi');
}

const MS_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);
const MS_LIST_KEYS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
const MS_NODE_KEYS = new Set(['items', 'contains', 'not', 'additionalProperties', 'propertyNames']);
const MS_SCALAR_TYPES = new Set(['string', 'integer', 'number', 'boolean']);

/** `type` que o Python não consegue comparar (dict) derruba o Hermes: recusa. */
function assertHashableType(node: Obj): void {
  if (isObj(node.type)) throw new HermesSchemaUnsupportedError('type objeto');
}

function ensureRequiredArray(node: Obj): Obj {
  const props = node.properties;
  const req = node.required;
  if (Array.isArray(req)) {
    if (isObj(props)) {
      if (req.some((r) => isObj(r) || Array.isArray(r))) {
        throw new HermesSchemaUnsupportedError('required com objeto');
      }
      node.required = req.filter((r) => typeof r === 'string' && own(props, r));
    }
  } else {
    node.required = [];
  }
  return node;
}

function enumSampleType(sample: unknown): string {
  if (typeof sample === 'boolean') return 'boolean';
  if (typeof sample === 'number') {
    // O JSON do JS escreve inteiro a partir de 1e21 em notação científica, que
    // o Python lê como float.
    return Number.isInteger(sample) && Math.abs(sample) < 1e21 ? 'integer' : 'number';
  }
  return 'string';
}

function fillMissingType(node: Obj): Obj {
  const t = node.type;
  if (Array.isArray(t)) {
    const concrete = t.find((x) => typeof x === 'string' && x !== '' && x !== 'null');
    return { ...node, type: concrete ?? 'string' };
  }
  if (own(node, 'type') && t !== null && t !== '') return node;
  let inferred: string;
  if (own(node, 'properties') || own(node, 'required') || own(node, 'additionalProperties')) {
    inferred = 'object';
  } else if (own(node, 'items') || own(node, 'prefixItems')) {
    inferred = 'array';
  } else if (Array.isArray(node.enum) && node.enum.length > 0) {
    inferred = enumSampleType(node.enum[0]);
  } else {
    inferred = 'string';
  }
  return { ...node, type: inferred };
}

function repairMoonshot(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(repairMoonshot);
  if (!isObj(node)) return node;
  let r: Obj = {};
  for (const key of keysOf(node)) {
    const value = node[key];
    if (MS_MAP_KEYS.has(key) && isObj(value)) {
      const m: Obj = {};
      for (const k of keysOf(value)) m[k] = repairMoonshot(value[k]);
      r[key] = m;
    } else if (
      (MS_LIST_KEYS.has(key) && Array.isArray(value)) ||
      (MS_NODE_KEYS.has(key) && isObj(value))
    ) {
      r[key] = repairMoonshot(value);
    } else {
      r[key] = value;
    }
  }
  assertHashableType(r);
  if (Array.isArray(r.anyOf)) {
    delete r.type;
    const variants = r.anyOf as unknown[];
    const nonNull = variants.filter((b) => isObj(b) && b.type !== 'null');
    if (nonNull.length === 0 || nonNull.length === variants.length) return r;
    if (nonNull.length > 1) {
      r.anyOf = nonNull;
      return r;
    }
    const rest: Obj = {};
    for (const k of Object.keys(r)) if (k !== 'anyOf') rest[k] = r[k];
    r = { ...rest, ...(nonNull[0] as Obj) };
    assertHashableType(r);
  }
  delete r.nullable;
  if (!own(r, '$ref')) r = fillMissingType(r);
  if (Array.isArray(r.enum) && Array.isArray(r.type)) {
    throw new HermesSchemaUnsupportedError('type lista com enum');
  }
  if (Array.isArray(r.enum) && typeof r.type === 'string' && MS_SCALAR_TYPES.has(r.type)) {
    const cleaned = (r.enum as unknown[]).filter((v) => v !== null && v !== '');
    if (cleaned.length > 0) r.enum = cleaned;
    else delete r.enum;
  }
  if (r.type === 'object') r = ensureRequiredArray(r);
  return r;
}

/** `sanitize_moonshot_tool_parameters`. */
function moonshotParameters(parameters: Obj): Obj {
  const repaired = repairMoonshot(parameters);
  if (!isObj(repaired)) return { type: 'object', properties: {}, required: [] };
  const top: Obj = { ...repaired, type: 'object' };
  if (!own(top, 'properties')) top.properties = {};
  return ensureRequiredArray(top);
}

/**
 * O `parameters` que o Hermes pinado envia, para um `input_schema` do manifest
 * e o modelo do grant. Lança `HermesSchemaUnsupportedError` no que o porte não
 * reproduz.
 */
export function hermesToolParameters(inputSchema: unknown, model: string): Obj {
  assertSafeKeys(inputSchema);
  const generic = genericParameters(inputSchema);
  return isMoonshotModel(model) ? moonshotParameters(generic) : generic;
}
