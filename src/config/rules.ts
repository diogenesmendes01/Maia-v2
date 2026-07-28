/**
 * Cross-field configuration rules (issue #515).
 *
 * A single pure implementation shared by:
 *   - the boot loader (`src/config/env.ts` — `scope: 'boot'` rules only, so
 *     boot behaviour is byte-for-byte what it was before the contract landed);
 *   - the contract validator (`src/config/validate.ts` — every rule), used by
 *     `maia config check`, `maia doctor` (#517) and CI.
 *
 * PURE module: takes an environment snapshot as an argument, reads no globals,
 * touches no filesystem, and never interpolates a secret VALUE into a message.
 */
import { assertSafeAuthDir } from '@/setup/auth-dir-path.js';
import { CONTRACT_ENTRIES, isSyntheticFixtureValue } from '@/config/contract.js';
import {
  type EnvVarSpec,
  type MaiaProfile,
  describeRequiredWhen,
  evaluateRequiredWhen,
  isOperatorPlaceholder,
} from '@/config/metadata.js';

/** Where a rule is enforced. */
export type RuleScope = 'boot' | 'contract';

export interface CrossFieldFinding {
  readonly scope: RuleScope;
  readonly severity: 'error' | 'warning';
  /** Zod issue path / variable name. `null` keeps the legacy `<root>` shape. */
  readonly variable: string | null;
  readonly rule: string;
  readonly message: string;
  readonly remediation: string;
  /**
   * Variables whose `requiredWhen` this finding already enforces. Several
   * hand-written rules predate the executable `requiredWhen` and carry the
   * legacy boot message (some with `variable: null`, to preserve the historical
   * `<root>` Zod path), so the generic pass below uses this to avoid reporting
   * the same missing variable twice.
   */
  readonly covers?: readonly string[];
}

/**
 * What the rules see. `values` is the schema-parsed view (coerced numbers,
 * booleans, `ALERT_CHANNELS` already split); `raw` is the untouched env, needed
 * for the rules that must observe variables which are NOT schema fields
 * (tombstones) and for placeholder detection.
 */
export interface CrossFieldView {
  readonly values: Record<string, unknown>;
  readonly raw: Record<string, string | undefined>;
  readonly profile: MaiaProfile;
  /** Entries the generic `requiredWhen` pass covers. Defaults to the contract. */
  readonly entries?: readonly EnvVarSpec[];
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const bool = (v: unknown): boolean => v === true;
const list = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

/** Known embedding models → the dimension count they actually emit. */
const EMBEDDING_MODEL_DIMENSIONS: Record<string, number> = {
  'voyage-3': 1024,
  'voyage-3-lite': 512,
  'voyage-code-3': 1024,
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
  'embed-english-v3.0': 1024,
  'embed-multilingual-v3.0': 1024,
};

/** Expected model-name prefix per embedding provider. */
const EMBEDDING_PROVIDER_PREFIX: Record<string, string> = {
  voyage: 'voyage-',
  openai: 'text-embedding-',
  cohere: 'embed-',
};

/**
 * Evaluate every cross-field rule. Returns ALL findings — never short-circuits,
 * so one run tells the operator everything that is wrong.
 */
export function evaluateCrossFieldRules(view: CrossFieldView): CrossFieldFinding[] {
  const { values: c, raw, profile } = view;
  const out: CrossFieldFinding[] = [];
  const push = (f: CrossFieldFinding) => out.push(f);

  // -------------------------------------------------------------------
  // BOOT-SCOPE rules — messages preserved verbatim from the pre-contract
  // loader. Changing a message here changes a production boot error.
  // -------------------------------------------------------------------

  if (c.LLM_PROVIDER === 'anthropic' && !str(c.ANTHROPIC_API_KEY)) {
    push({
      scope: 'boot',
      severity: 'error',
      variable: null,
      rule: 'llm/provider-key',
      message: 'ANTHROPIC_API_KEY required when LLM_PROVIDER=anthropic',
      covers: ['ANTHROPIC_API_KEY'],
      remediation: 'Defina ANTHROPIC_API_KEY (prefixo sk-ant-) ou troque LLM_PROVIDER.',
    });
  }
  if (c.LLM_PROVIDER === 'openrouter' && !str(c.OPENROUTER_API_KEY)) {
    push({
      scope: 'boot',
      severity: 'error',
      variable: null,
      rule: 'llm/provider-key',
      message: 'OPENROUTER_API_KEY required when LLM_PROVIDER=openrouter',
      covers: ['OPENROUTER_API_KEY'],
      remediation: 'Defina OPENROUTER_API_KEY (prefixo sk-or-) ou troque LLM_PROVIDER.',
    });
  }
  if (c.EMBEDDING_PROVIDER === 'voyage' && !str(c.VOYAGE_API_KEY)) {
    push({
      scope: 'boot',
      severity: 'error',
      variable: null,
      rule: 'embeddings/provider-key',
      message: 'VOYAGE_API_KEY required when EMBEDDING_PROVIDER=voyage',
      covers: ['VOYAGE_API_KEY'],
      remediation: 'Defina VOYAGE_API_KEY ou troque EMBEDDING_PROVIDER.',
    });
  }
  if (c.EMBEDDING_PROVIDER === 'openai' && !str(c.OPENAI_API_KEY)) {
    push({
      scope: 'boot',
      severity: 'error',
      variable: null,
      rule: 'embeddings/provider-key',
      message: 'OPENAI_API_KEY required when EMBEDDING_PROVIDER=openai',
      covers: ['OPENAI_API_KEY'],
      remediation: 'Defina OPENAI_API_KEY ou troque EMBEDDING_PROVIDER.',
    });
  }
  if (c.EMBEDDING_PROVIDER === 'cohere' && !str(c.COHERE_API_KEY)) {
    push({
      scope: 'boot',
      severity: 'error',
      variable: null,
      rule: 'embeddings/provider-key',
      message: 'COHERE_API_KEY required when EMBEDDING_PROVIDER=cohere',
      covers: ['COHERE_API_KEY'],
      remediation: 'Defina COHERE_API_KEY ou troque EMBEDDING_PROVIDER.',
    });
  }

  const channels = list(c.ALERT_CHANNELS);
  if (channels.includes('telegram') && (!str(c.TELEGRAM_BOT_TOKEN) || !str(c.TELEGRAM_CHAT_ID))) {
    push({
      scope: 'boot',
      severity: 'error',
      variable: null,
      rule: 'alerts/telegram-credentials',
      message: 'Telegram alerts require TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID',
      covers: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
      remediation: 'Defina os dois, ou remova `telegram` de ALERT_CHANNELS.',
    });
  }
  if (channels.includes('email') && !str(c.ALERT_EMAIL_TO)) {
    push({
      scope: 'boot',
      severity: 'error',
      variable: null,
      rule: 'alerts/email-destination',
      message: 'Email alerts require ALERT_EMAIL_TO',
      covers: ['ALERT_EMAIL_TO'],
      remediation: 'Defina ALERT_EMAIL_TO, ou remova `email` de ALERT_CHANNELS.',
    });
  }

  if (
    str(c.OWNER_TELEFONE_WHATSAPP) &&
    c.OWNER_TELEFONE_WHATSAPP === c.WHATSAPP_NUMBER_MAIA
  ) {
    push({
      scope: 'boot',
      severity: 'error',
      variable: null,
      rule: 'whatsapp/owner-differs-from-agent',
      message: 'OWNER_TELEFONE_WHATSAPP must differ from WHATSAPP_NUMBER_MAIA',
      remediation: 'A linha do agente e o número do owner precisam ser distintos.',
    });
  }

  // Fase 0 cap. 5 (auditoria P0) — MCP permanece OFF em produção até o
  // enablement passar por issue própria + threat model + pentest (gate G4).
  if (c.NODE_ENV === 'production' && bool(c.FEATURE_MCP_TOOLS)) {
    push({
      scope: 'boot',
      severity: 'error',
      variable: 'FEATURE_MCP_TOOLS',
      rule: 'mcp/production-forbidden',
      message:
        'FEATURE_MCP_TOOLS não pode ser habilitada em produção: o enablement do MCP exige ' +
        'revisão de segurança dedicada (Fase 0 gate G4 — threat model + pentest) antes de sair do default OFF.',
      remediation: 'Deixe FEATURE_MCP_TOOLS=false em produção.',
    });
  }

  // Fase 0 cap. 1 — coerência dos thresholds financeiros. Fora de ordem, a
  // política vira contraditória: DUAL > DURO torna a aprovação dupla
  // inalcançável, e SEM_CONFIRMACAO > DUAL permitiria operação relevante sem
  // confirmação. Boot falha fechado.
  const semConf = num(c.VALOR_LIMITE_SEM_CONFIRMACAO);
  const dual = num(c.VALOR_DUAL_APPROVAL);
  const duro = num(c.VALOR_LIMITE_DURO);
  if (
    semConf !== undefined &&
    dual !== undefined &&
    duro !== undefined &&
    !(semConf <= dual && dual <= duro)
  ) {
    push({
      scope: 'boot',
      severity: 'error',
      variable: 'VALOR_DUAL_APPROVAL',
      rule: 'governance/threshold-order',
      message:
        `financial thresholds out of order: require VALOR_LIMITE_SEM_CONFIRMACAO (${semConf}) ` +
        `<= VALOR_DUAL_APPROVAL (${dual}) <= VALOR_LIMITE_DURO (${duro})`,
      remediation:
        'Ajuste os três limites para VALOR_LIMITE_SEM_CONFIRMACAO <= VALOR_DUAL_APPROVAL <= VALOR_LIMITE_DURO.',
    });
  }

  // P10b/P11 — runtime trace é always-on; em produção o segredo mestre é
  // obrigatório (sem ele os HMACs de auditoria seriam forjáveis).
  if (c.NODE_ENV === 'production' && !str(c.RUNTIME_TRACE_HMAC_MASTER_SECRET)) {
    push({
      scope: 'boot',
      severity: 'error',
      variable: 'RUNTIME_TRACE_HMAC_MASTER_SECRET',
      rule: 'runtime-trace/master-secret-required',
      message:
        'RUNTIME_TRACE_HMAC_MASTER_SECRET is required in production — audit HMACs would be forgeable without it',
      remediation: 'Injete o segredo mestre (KMS) antes de subir em produção.',
    });
  }

  // PR #406 — fail-closed na flag REMOVIDA do context packet. Lida do env CRU:
  // não é campo de schema, então não aparece em `values`.
  if (
    raw.FEATURE_CONTEXT_PACKET_V1 === 'true' ||
    raw.FEATURE_CONTEXT_PACKET_V1_KILL_SWITCH === 'true'
  ) {
    push({
      scope: 'boot',
      severity: 'error',
      variable: 'FEATURE_CONTEXT_PACKET_V1',
      rule: 'tombstone/context-packet-v1',
      message:
        'FEATURE_CONTEXT_PACKET_V1 (and its kill switch) was REMOVED in PR #406 — ' +
        'the context-packet path no longer exists. Unset FEATURE_CONTEXT_PACKET_V1 / ' +
        'FEATURE_CONTEXT_PACKET_V1_KILL_SWITCH in this environment.',
      remediation:
        'Remova FEATURE_CONTEXT_PACKET_V1 e FEATURE_CONTEXT_PACKET_V1_KILL_SWITCH do ambiente.',
    });
  }

  const authDir = str(c.BAILEYS_AUTH_DIR);
  if (authDir !== undefined) {
    try {
      assertSafeAuthDir(authDir);
    } catch (err) {
      push({
        scope: 'boot',
        severity: 'error',
        variable: 'BAILEYS_AUTH_DIR',
        rule: 'whatsapp/auth-dir-safe',
        message: (err as Error).message,
        remediation:
          'Aponte BAILEYS_AUTH_DIR para um diretório dedicado cujo path contenha um segmento "baileys".',
      });
    }
  }

  // -------------------------------------------------------------------
  // CONTRACT-SCOPE rules — enforced by `maia config check` / `maia doctor`.
  // Not wired into boot yet (rollout step 1: contract lands without changing
  // the loader's failure surface).
  // -------------------------------------------------------------------

  // Embeddings: model prefix and dimension count must match the provider.
  const embProvider = str(c.EMBEDDING_PROVIDER);
  const embModel = str(c.EMBEDDING_MODEL);
  const embDims = num(c.EMBEDDING_DIMENSIONS);
  if (embProvider && embModel) {
    const prefix = EMBEDDING_PROVIDER_PREFIX[embProvider];
    if (prefix && !embModel.startsWith(prefix)) {
      push({
        scope: 'contract',
        severity: 'warning',
        variable: 'EMBEDDING_MODEL',
        rule: 'embeddings/model-provider-prefix',
        message: `EMBEDDING_MODEL="${embModel}" não usa o prefixo esperado de EMBEDDING_PROVIDER=${embProvider} ("${prefix}").`,
        remediation: `Use um modelo ${prefix}* ou ajuste EMBEDDING_PROVIDER.`,
      });
    }
    const known = EMBEDDING_MODEL_DIMENSIONS[embModel];
    if (known !== undefined && embDims !== undefined && known !== embDims) {
      push({
        scope: 'contract',
        severity: 'error',
        variable: 'EMBEDDING_DIMENSIONS',
        rule: 'embeddings/dimension-mismatch',
        message: `EMBEDDING_DIMENSIONS=${embDims} não bate com ${embModel} (${known}).`,
        remediation:
          `Ajuste EMBEDDING_DIMENSIONS para ${known} — a coluna pgvector já migrada também precisa ` +
          'ter essa dimensão, então trocar de modelo exige migração + rebuild dos embeddings.',
      });
    }
  }

  // Alertas: canal desconhecido é erro (um typo silenciaria o alerta).
  for (const ch of channels) {
    if (!['log', 'email', 'telegram'].includes(ch)) {
      push({
        scope: 'contract',
        severity: 'error',
        variable: 'ALERT_CHANNELS',
        rule: 'alerts/unknown-channel',
        message: `Canal de alerta desconhecido: "${ch}".`,
        remediation: 'Canais suportados: log, email, telegram.',
      });
    }
  }
  // ALERT_CHANNELS tem default `email`, e `email` exige ALERT_EMAIL_TO — ou
  // seja, NÃO definir a variável já obriga a configurar SMTP. Deixar isso
  // implícito foi a origem do drift citado na #515 (o `.env.example` comentava
  // ALERT_CHANNELS e ALERT_EMAIL_TO ao mesmo tempo, e o boot falhava).
  if (raw.ALERT_CHANNELS === undefined || raw.ALERT_CHANNELS.trim() === '') {
    push({
      scope: 'contract',
      severity: 'warning',
      variable: 'ALERT_CHANNELS',
      rule: 'alerts/implicit-default',
      message:
        'ALERT_CHANNELS não está definida: o default é `email`, que por sua vez exige ALERT_EMAIL_TO (e SMTP_HOST).',
      remediation:
        'Declare ALERT_CHANNELS explicitamente (log, email, telegram — separados por vírgula) em vez de depender do default.',
    });
  }
  if (channels.includes('email') && !str(c.SMTP_HOST)) {
    push({
      scope: 'contract',
      severity: 'error',
      variable: 'SMTP_HOST',
      rule: 'alerts/email-transport',
      message: 'ALERT_CHANNELS inclui email mas SMTP_HOST não está definido.',
      covers: ['SMTP_HOST'],
      remediation: 'Defina SMTP_HOST (e SMTP_PORT/SMTP_USER/SMTP_PASS conforme o provedor).',
    });
  }

  // S3: bucket exige credenciais; endpoint custom exige região explícita.
  if (str(c.BACKUP_S3_BUCKET)) {
    if (!str(c.BACKUP_S3_ACCESS_KEY) || !str(c.BACKUP_S3_SECRET_KEY)) {
      push({
        scope: 'contract',
        severity: 'error',
        variable: 'BACKUP_S3_BUCKET',
        rule: 'backup/s3-credentials',
        message:
          'BACKUP_S3_BUCKET definido sem BACKUP_S3_ACCESS_KEY/BACKUP_S3_SECRET_KEY — o upload remoto falharia silenciosamente na primeira execução.',
        remediation:
          'Defina BACKUP_S3_ACCESS_KEY e BACKUP_S3_SECRET_KEY, ou remova BACKUP_S3_BUCKET para backup apenas local.',
      });
    }
  } else if (str(c.BACKUP_S3_ACCESS_KEY) || str(c.BACKUP_S3_SECRET_KEY)) {
    push({
      scope: 'contract',
      severity: 'warning',
      variable: 'BACKUP_S3_BUCKET',
      rule: 'backup/s3-credentials-without-bucket',
      message: 'Credenciais S3 configuradas sem BACKUP_S3_BUCKET — nada será enviado.',
      remediation: 'Defina BACKUP_S3_BUCKET ou remova as credenciais S3.',
    });
  }

  // Roteamento multi-linha ↔ modo compatível.
  const routingMode = str(c.MAIA_CHANNEL_ROUTING_MODE) ?? 'shadow';
  if (bool(c.MAIA_MULTI_LINE) && routingMode === 'shadow') {
    push({
      scope: 'contract',
      severity: 'error',
      variable: 'MAIA_CHANNEL_ROUTING_MODE',
      rule: 'routing/multi-line-mode',
      message:
        'MAIA_MULTI_LINE=true com MAIA_CHANNEL_ROUTING_MODE=shadow: o transporte por linha ficaria ligado enquanto o roteamento ainda cai no catch-all legado.',
      remediation: 'Use MAIA_CHANNEL_ROUTING_MODE=exact_first (ou strict) junto com MAIA_MULTI_LINE=true.',
    });
  }
  if (routingMode === 'strict') {
    if (!str(c.MAIA_STAGING_KEYRING) || !str(c.MAIA_STAGING_ACTIVE_KEY_ID)) {
      push({
        scope: 'contract',
        severity: 'error',
        variable: 'MAIA_STAGING_KEYRING',
        rule: 'routing/strict-requires-keyring',
        message:
          'MAIA_CHANNEL_ROUTING_MODE=strict exige MAIA_STAGING_KEYRING e MAIA_STAGING_ACTIVE_KEY_ID (staging cifrado do inbound não-roteado).',
        remediation: 'Defina o keyring e o id da chave ativa, ou volte para exact_first.',
      });
    }
  }
  if (bool(c.MAIA_SYNTHETIC_PROBE) && routingMode === 'shadow') {
    push({
      scope: 'contract',
      severity: 'warning',
      variable: 'MAIA_SYNTHETIC_PROBE',
      rule: 'probe/routing-prerequisite',
      message:
        'MAIA_SYNTHETIC_PROBE=true sob MAIA_CHANNEL_ROUTING_MODE=shadow: o worker falha fechado (no-op + audit synthetic_probe_prereq_unmet).',
      remediation: 'Suba MAIA_CHANNEL_ROUTING_MODE para exact_first ou strict antes de ligar a sonda.',
    });
  }

  // Janelas/limites que precisam estar em ordem.
  const orderPairs: readonly [string, string, string][] = [
    ['MESSAGE_DEBOUNCE_MS', 'MESSAGE_DEBOUNCE_MAX_MS', 'debounce'],
    ['MAIA_PROBE_SLO_WARN_MS', 'MAIA_PROBE_SLO_MS', 'probe-slo'],
    ['OUTBOX_RELAYER_BASE_BACKOFF_SEC', 'OUTBOX_RELAYER_MAX_BACKOFF_SEC', 'outbox-backoff'],
  ];
  for (const [lowName, highName, id] of orderPairs) {
    const low = num(c[lowName]);
    const high = num(c[highName]);
    if (low !== undefined && high !== undefined && low > high) {
      push({
        scope: 'contract',
        severity: 'error',
        variable: lowName,
        rule: `ordering/${id}`,
        message: `${lowName} (${low}) precisa ser <= ${highName} (${high}).`,
        remediation: `Reduza ${lowName} ou aumente ${highName}.`,
      });
    }
  }

  // Dev auth fora de development — fail-closed.
  if (profile !== 'development' && raw.ALLOW_DEV_AUTH === 'true') {
    push({
      scope: 'contract',
      severity: 'error',
      variable: 'ALLOW_DEV_AUTH',
      rule: 'admin-ui/dev-auth-forbidden',
      message: `ALLOW_DEV_AUTH=true é proibido no profile ${profile}: o login por token compartilhado ignora o IdP.`,
      remediation: 'Deixe ALLOW_DEV_AUTH=false e configure OIDC_* (issuer https, client id/secret, tenant slugs).',
    });
  }

  // URLs externas precisam de https fora de development.
  if (profile !== 'development') {
    for (const name of ['NEXTAUTH_URL', 'NEXT_PUBLIC_API_URL', 'OIDC_ISSUER']) {
      const value = str(raw[name]);
      if (value && !value.startsWith('https://')) {
        push({
          scope: 'contract',
          severity: 'error',
          variable: name,
          rule: 'url/https-required',
          message: `${name} precisa usar https no profile ${profile} (recebido: protocolo não-https).`,
          remediation: `Aponte ${name} para a URL https pública atrás do proxy reverso.`,
        });
      }
    }
  }

  // OIDC_TENANT_SLUGS nunca pode cair no literal `default` (invariante Maia §2/§8).
  const slugs = str(raw.OIDC_TENANT_SLUGS);
  if (slugs) {
    const parsed = slugs.split(',').map((s) => s.trim()).filter(Boolean);
    if (parsed.length === 0) {
      push({
        scope: 'contract',
        severity: 'error',
        variable: 'OIDC_TENANT_SLUGS',
        rule: 'admin-ui/tenant-slugs-empty',
        message: 'OIDC_TENANT_SLUGS está definido mas não contém nenhum slug.',
        remediation: 'Liste ao menos um app_users.tenant_id, separado por vírgula.',
      });
    }
    if (parsed.includes('default')) {
      push({
        scope: 'contract',
        severity: 'error',
        variable: 'OIDC_TENANT_SLUGS',
        rule: 'admin-ui/tenant-slugs-default-literal',
        message:
          "OIDC_TENANT_SLUGS contém o literal 'default' — o bucket legado é presumido-mal-roteado e não pode ser alvo de autenticação.",
        remediation: "Use o tenant real (ex.: 'primary').",
      });
    }
  }

  // Placeholders e secrets fracos são recusados fora de development.
  if (profile !== 'development') {
    for (const [name, value] of Object.entries(raw)) {
      if (!value) continue;
      if (isOperatorPlaceholder(value)) {
        push({
          scope: 'contract',
          severity: 'error',
          variable: name,
          rule: 'secret/placeholder',
          message: `${name} ainda está com um valor de placeholder no profile ${profile}.`,
          remediation: `Substitua ${name} por um valor real antes do deploy.`,
        });
      } else if (isSyntheticFixtureValue(name, value)) {
        // As fixtures de `src/config/generated/fixtures/` existem para o CI
        // provar que o contrato é satisfazível. Valores previsíveis como
        // `sk-ant-fixture-*` não autenticam em nada: um processo configurado
        // com eles fica INOPERANTE parecendo configurado. Achado [P1] da
        // rodada 1 da PR #522.
        //
        // A comparação é EXATA e restrita a segredos declarados
        // (`isSyntheticFixtureValue` em contract.ts). A versão anterior casava
        // qualquer valor contendo a palavra "fixture", o que — com o boot
        // fail-closed — derrubaria um `OWNER_NOME=Fixture Labs` legítimo.
        push({
          scope: 'contract',
          severity: 'error',
          variable: name,
          rule: 'secret/synthetic-fixture',
          message: `${name} está com o valor EXATO da fixture sintética de CI, no profile ${profile}.`,
          remediation:
            `As fixtures em src/config/generated/fixtures/ provam que o contrato é satisfazível; ` +
            `elas não autenticam em nada. Gere um ponto de partida operacional com ` +
            `\`npm run config:init -- --profile ${profile}\` e preencha ${name} com o valor real.`,
        });
      }
    }
  }

  // -------------------------------------------------------------------
  // requiredWhen — dependências condicionais declaradas no contrato,
  // EXECUTADAS. Antes disso `requiredWhen` era prosa: aparecia na mensagem de
  // uma variável já marcada `requiredIn`, mas a condição nunca rodava, então
  // FEATURE_OUTBOUND_VOICE=true sem OPENAI_API_KEY validava limpo (achado
  // [P2] da rodada 1 da PR #522). Roda por ÚLTIMO e pula o que uma regra
  // específica (com a mensagem de boot legada) já reportou.
  // -------------------------------------------------------------------
  const alreadyCovered = new Set(out.flatMap((f) => f.covers ?? []));
  for (const spec of view.entries ?? CONTRACT_ENTRIES) {
    if (!spec.requiredWhen || alreadyCovered.has(spec.name)) continue;
    const present = str(raw[spec.name]?.trim()) !== undefined;
    if (present) continue;
    if (!evaluateRequiredWhen(spec.requiredWhen, { values: c, raw })) continue;
    const condition = describeRequiredWhen(spec.requiredWhen);
    push({
      scope: 'contract',
      severity: 'error',
      variable: spec.name,
      rule: 'contract/required-when',
      message: `${spec.name} é obrigatória quando ${condition}, e não está definida.`,
      remediation: `Defina ${spec.name}, ou desfaça a condição (${condition}).`,
    });
  }

  return out;
}
