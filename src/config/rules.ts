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
// Pure, leaf-level helpers: the drill SCHEDULE owns the arithmetic of what it
// can honour, so the boot gate asks it instead of restating the formula (which
// is how the two would drift). Same direction as the `@/setup` import above —
// this module stays pure, it just does not re-implement other modules' rules.
import {
  DRILL_TICK_HOURS,
  minHonourableDrillIntervalHours,
} from '@/ops/backup/drill-schedule.js';
// Mesma direção dos imports acima: a regra de lease PERGUNTA ao contrato de
// claim qual relação é segura, em vez de reescrever a fórmula (que é como as
// duas divergiriam).
import { checkLeaseTiming, MAX_HEARTBEAT_TO_TTL_RATIO } from '@/runtime/turns/claim.js';
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
  // BACKUP FAIL-CLOSED (issue #520 §1, "Em produção").
  //
  // BOOT scope on purpose. These are the gates that stop a production host
  // from running with a backup configuration that can only ever produce an
  // unrecoverable or plaintext artifact — the issue is explicit that
  // "configuração inválida não pode ser reduzida a warning silencioso".
  // Boot scope also means they still apply under the
  // MAIA_CONFIG_STRICT_BOOT=false rollback lever: that lever exists to unblock
  // an environment blocked by contract bookkeeping, not to let production boot
  // without an off-site destination or an encryption key.
  //
  // The single source of truth for these rules is HERE. `src/ops/backup/
  // profile.ts` only RESOLVES the profile (what is required, what is
  // configured); it does not re-implement the verdicts.
  // -------------------------------------------------------------------

  const isProdProfile = profile === 'production';
  const backupEnabled = c.BACKUP_ENABLED !== false;
  // Ausente = o profile decide (production exige). Ver BACKUP_OFFSITE_REQUIRED.
  const offsiteRequired =
    c.BACKUP_OFFSITE_REQUIRED === undefined ? isProdProfile : c.BACKUP_OFFSITE_REQUIRED === true;
  const encryptionMode = str(c.BACKUP_ENCRYPTION_MODE) ?? 'none';

  if (isProdProfile && c.BACKUP_ENABLED === false) {
    push({
      scope: 'boot',
      severity: 'error',
      variable: 'BACKUP_ENABLED',
      rule: 'backup/production-enabled',
      message:
        'BACKUP_ENABLED=false is not allowed in the production profile — a production deployment without backups has no recovery path.',
      remediation:
        'Defina BACKUP_ENABLED=true, ou rode este host sob MAIA_ENV=development/staging.',
    });
  }

  if (backupEnabled) {
    if (isProdProfile && c.BACKUP_OFFSITE_REQUIRED === false) {
      push({
        scope: 'boot',
        severity: 'error',
        variable: 'BACKUP_OFFSITE_REQUIRED',
        rule: 'backup/production-offsite-required',
        message:
          'BACKUP_OFFSITE_REQUIRED=false is not allowed in the production profile — losing the host would take the only artifact with it.',
        remediation:
          'Remova BACKUP_OFFSITE_REQUIRED (o profile já exige) ou defina true, e configure BACKUP_S3_BUCKET.',
      });
    }

    // Off-site exigido sem destino é a falha silenciosa que a #520 fecha: o
    // job "terminava com sucesso" gravando só em disco local.
    if (offsiteRequired && !str(c.BACKUP_S3_BUCKET)) {
      push({
        scope: 'boot',
        severity: 'error',
        variable: 'BACKUP_S3_BUCKET',
        rule: 'backup/offsite-destination',
        message:
          'off-site backup is required by this profile but no destination is configured. Set BACKUP_S3_BUCKET (and credentials) or switch to a profile that does not require off-site.',
        covers: ['BACKUP_S3_BUCKET'],
        remediation:
          'Defina BACKUP_S3_BUCKET + credenciais, ou desligue a exigência fora de production (BACKUP_OFFSITE_REQUIRED=false).',
      });
    }

    if (isProdProfile && encryptionMode === 'none') {
      push({
        scope: 'boot',
        severity: 'error',
        variable: 'BACKUP_ENCRYPTION_MODE',
        rule: 'backup/production-encryption',
        message:
          "BACKUP_ENCRYPTION_MODE=none is not allowed in the production profile — a dump contains every tenant's personal data in the clear.",
        remediation: 'Defina BACKUP_ENCRYPTION_MODE=envelope_aes256_gcm e configure o keyring.',
      });
    }

    // Chave ausente com cifra exigida: a run falha fechado em vez de gravar
    // um dump em claro, então o boot avisa antes de o operador descobrir às 3h.
    if (
      encryptionMode !== 'none' &&
      (!str(c.BACKUP_ENCRYPTION_KEYRING) || !str(c.BACKUP_ENCRYPTION_ACTIVE_KEY_ID))
    ) {
      push({
        scope: 'boot',
        severity: 'error',
        variable: 'BACKUP_ENCRYPTION_KEYRING',
        rule: 'backup/encryption-key',
        message:
          'encryption is required but the keyring is incomplete. Set BACKUP_ENCRYPTION_KEYRING (JSON {key_id: base64(32 bytes)}) and BACKUP_ENCRYPTION_ACTIVE_KEY_ID. The run fails closed rather than writing a plaintext dump.',
        covers: ['BACKUP_ENCRYPTION_KEYRING', 'BACKUP_ENCRYPTION_ACTIVE_KEY_ID'],
        remediation:
          'Defina BACKUP_ENCRYPTION_KEYRING e BACKUP_ENCRYPTION_ACTIVE_KEY_ID, ou volte para BACKUP_ENCRYPTION_MODE=none fora de production.',
      });
    }

    // Não anunciar um RPO que a arquitetura não cumpre (§8).
    const rpoHours = num(c.BACKUP_RPO_TARGET_HOURS);
    if (rpoHours !== undefined && rpoHours < 24) {
      push({
        scope: 'boot',
        severity: 'error',
        variable: 'BACKUP_RPO_TARGET_HOURS',
        rule: 'backup/rpo-feasible',
        message:
          'BACKUP_RPO_TARGET_HOURS below 24 cannot be met by nightly logical dumps alone. Either raise the target or land PITR/WAL archiving first — the platform must not advertise an RPO it cannot honour.',
        remediation: 'Use BACKUP_RPO_TARGET_HOURS >= 24 enquanto não houver PITR/WAL archiving.',
      });
    }

    // O intervalo do drill precisa ser HONRÁVEL pelo agendador (issue #536).
    //
    // `BACKUP_RESTORE_DRILL_INTERVAL_HOURS` é a idade máxima aceitável da
    // evidência, e quem a renova é o worker `restore_drill`: ele acorda a cada
    // hora e dispara o drill a 75% do intervalo, deixando os 25% restantes para
    // o drill acontecer. Se esses 25% não cobrirem "um tick de latência + a
    // duração do drill", a evidência vence antes de ser renovada e o gate fica
    // piscando vermelho para sempre — a plataforma prometeria uma idade máxima
    // que a própria arquitetura não cumpre.
    //
    // Mesma família de raciocínio do `backup/rpo-feasible` acima, e por isso
    // também `error` no boot: não se anuncia um objetivo inalcançável. O piso é
    // DERIVADO dos outros parâmetros (tick, upload, restore) por
    // `minHonourableDrillIntervalHours` — nos defaults, 10h — em vez de ser um
    // número solto que envelhece quando alguém mexe num timeout.
    const drillIntervalHours = num(c.BACKUP_RESTORE_DRILL_INTERVAL_HOURS);
    const drillUploadMs = num(c.BACKUP_UPLOAD_TIMEOUT_MS);
    const drillRestoreMs = num(c.BACKUP_RESTORE_TIMEOUT_MS);
    if (
      drillIntervalHours !== undefined &&
      drillUploadMs !== undefined &&
      drillRestoreMs !== undefined
    ) {
      const floorHours = minHonourableDrillIntervalHours({
        tickHours: DRILL_TICK_HOURS,
        uploadMs: drillUploadMs,
        restoreMs: drillRestoreMs,
      });
      if (drillIntervalHours < floorHours) {
        push({
          scope: 'boot',
          severity: 'error',
          variable: 'BACKUP_RESTORE_DRILL_INTERVAL_HOURS',
          rule: 'backup/drill-interval-feasible',
          message:
            `BACKUP_RESTORE_DRILL_INTERVAL_HOURS=${drillIntervalHours} cannot be honoured by the restore-drill scheduler, which needs at least ${floorHours}h here: it wakes every ${DRILL_TICK_HOURS}h and starts the drill at 75% of the interval, leaving 25% for a drill bounded by BACKUP_UPLOAD_TIMEOUT_MS (${Math.round(drillUploadMs / 60_000)}min) + BACKUP_RESTORE_TIMEOUT_MS (${Math.round(drillRestoreMs / 60_000)}min). The evidence would expire before it could be refreshed — do not advertise a maximum evidence age the architecture cannot meet.`,
          remediation:
            `Use BACKUP_RESTORE_DRILL_INTERVAL_HOURS >= ${floorHours}, ou reduza BACKUP_UPLOAD_TIMEOUT_MS/BACKUP_RESTORE_TIMEOUT_MS (o piso é derivado deles e da cadência do tick).`,
        });
      }
    }

    // A cópia autoritativa não pode expirar antes da secundária.
    const localDays = num(c.BACKUP_RETENTION_LOCAL_DAYS);
    const cloudDays = num(c.BACKUP_RETENTION_CLOUD_DAYS);
    if (
      offsiteRequired &&
      localDays !== undefined &&
      cloudDays !== undefined &&
      localDays > cloudDays
    ) {
      push({
        scope: 'boot',
        severity: 'error',
        variable: 'BACKUP_RETENTION_CLOUD_DAYS',
        rule: 'backup/retention-ordering',
        message:
          'cloud retention is shorter than local retention while off-site is required — the authoritative copy would expire before the local one.',
        remediation:
          'Aumente BACKUP_RETENTION_CLOUD_DAYS para >= BACKUP_RETENTION_LOCAL_DAYS.',
      });
    }
  }

  // Exclusão é IRREVERSÍVEL: desligar o dry-run é uma decisão consciente por
  // ambiente, não um default herdado. Warning (não erro) porque o operador
  // PODE legitimamente querer executar retenção — mas nunca por acidente.
  if (c.RETENTION_DRY_RUN === false) {
    push({
      scope: 'contract',
      severity: 'warning',
      variable: 'RETENTION_DRY_RUN',
      rule: 'retention/dry-run-disabled',
      message:
        'RETENTION_DRY_RUN=false: o executor de retenção pode APAGAR dados neste ambiente.',
      remediation:
        'Confirme que a política de retenção foi aprovada pelo jurídico/DPO e que as contagens do dry-run foram conferidas — ver docs/architecture/concerns/data-retention-matrix.md.',
    });
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

  // Cache de contexto do turno (#511): o TTL NEGATIVO existe justamente para
  // ser mais curto que o positivo. Uma entrada negativa é "este agente não tem
  // perfil operacional ativo" — resposta que muda no instante em que o operador
  // ativa um perfil. Invertida a ordem, um perfil recém-ativado demoraria MAIS
  // para aparecer do que um perfil alterado, que é o oposto da intenção.
  //
  // Warning, não error: nada quebra, é afinação sem sentido. Abortar o boot por
  // causa de um botão de tuning seria desproporcional.
  const turnCtxTtl = num(c.TURN_CONTEXT_CACHE_TTL_MS);
  const turnCtxNegTtl = num(c.TURN_CONTEXT_CACHE_NEGATIVE_TTL_MS);
  if (turnCtxTtl !== undefined && turnCtxNegTtl !== undefined && turnCtxNegTtl > turnCtxTtl) {
    push({
      scope: 'contract',
      severity: 'warning',
      variable: 'TURN_CONTEXT_CACHE_NEGATIVE_TTL_MS',
      rule: 'turn-context-cache/negative-ttl-order',
      message:
        `TURN_CONTEXT_CACHE_NEGATIVE_TTL_MS=${turnCtxNegTtl} é maior que ` +
        `TURN_CONTEXT_CACHE_TTL_MS=${turnCtxTtl}.`,
      remediation:
        'Deixe o TTL negativo menor ou igual ao positivo — ele cobre "sem perfil ativo", ' +
        'que deve expirar rápido para uma ativação recente aparecer.',
    });
  }

  // Lease do claim de turno (#504): o heartbeat tem de caber ao menos 3x no TTL.
  //
  // ERROR de escopo BOOT, e não warning de contrato, por uma razão que separa
  // esta regra da anterior: aqui a consequência não é "afinação sem sentido", é
  // TAKEOVER FALSO — um segundo worker reivindica um turno cujo dono está vivo e
  // processando, e o usuário recebe a resposta duas vezes (ou uma tool com
  // efeito externo roda duas vezes). Subir com essa relação é subir com a
  // garantia central da issue desligada, então o boot para.
  //
  // A aritmética vive em `checkLeaseTiming` (src/runtime/turns/claim.ts), não
  // aqui: o controlador de lease valida a mesma relação em runtime e duas
  // cópias da fórmula divergiriam.
  const leaseTtl = num(c.TURN_LEASE_TTL_MS);
  const leaseHeartbeat = num(c.TURN_LEASE_HEARTBEAT_MS);
  if (leaseTtl !== undefined && leaseHeartbeat !== undefined) {
    const leaseCheck = checkLeaseTiming(leaseTtl, leaseHeartbeat);
    if (!leaseCheck.ok) {
      push({
        scope: 'boot',
        severity: 'error',
        variable: 'TURN_LEASE_HEARTBEAT_MS',
        rule: 'turn-lease/heartbeat-ratio',
        message:
          `TURN_LEASE_HEARTBEAT_MS=${leaseHeartbeat} é inseguro para ` +
          `TURN_LEASE_TTL_MS=${leaseTtl} (${leaseCheck.reason}): o heartbeat precisa caber ao ` +
          `menos 3x no TTL, senão uma única renovação perdida deixa a lease vencer com o dono ` +
          `ainda processando — e lease vencida com dono vivo é execução dupla do turno.`,
        remediation:
          `Use TURN_LEASE_HEARTBEAT_MS <= ${Math.floor(leaseTtl * MAX_HEARTBEAT_TO_TTL_RATIO)} ` +
          `(um terço de TURN_LEASE_TTL_MS), ou aumente TURN_LEASE_TTL_MS.`,
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

  // Issue #503 — a leitura autoritativa da máquina de estados do turno depende
  // do dual-write. Com MACHINE=false não existe turno para o recovery eleger, e
  // `turnStateAuthoritative()` (src/runtime/turns/lifecycle.ts) devolve false —
  // ou seja, a combinação é INERTE. Silêncio aqui é pior que erro: o operador
  // acredita ter feito o flip do passo 8 do rollout e o recovery continua
  // decidindo pelo campo legado. Fail-closed no contrato.
  if (bool(c.FEATURE_TURN_STATE_AUTHORITATIVE) && !bool(c.FEATURE_TURN_STATE_MACHINE)) {
    push({
      scope: 'contract',
      severity: 'error',
      variable: 'FEATURE_TURN_STATE_AUTHORITATIVE',
      rule: 'turn-state/authoritative-requires-dual-write',
      message:
        'FEATURE_TURN_STATE_AUTHORITATIVE=true com FEATURE_TURN_STATE_MACHINE=false é inerte: sem dual-write não há agent_turns para o recovery eleger, e a decisão continua saindo de mensagens.processada_em.',
      remediation:
        'Ligue FEATURE_TURN_STATE_MACHINE (e, numa base COM histórico, conclua o backfill com `npm run backfill:turns`), ou desligue FEATURE_TURN_STATE_AUTHORITATIVE. ATENÇÃO: desde #504 as três flags de turno vêm ON por default, então um rollback emergencial que desliga só FEATURE_TURN_STATE_MACHINE cai aqui — desligue as TRÊS juntas (FEATURE_TURN_STATE_MACHINE, FEATURE_TURN_STATE_AUTHORITATIVE e FEATURE_TURN_CLAIM). Ver docs/runbooks/turn-state-machine.md §2.',
    });
  }

  // Issue #504 — o claim atômico depende da máquina de estados. Sem
  // `agent_turns` não existe row a reivindicar, e `turnClaimEnabled()`
  // (src/runtime/turns/lease.ts) devolve false: a combinação é INERTE. Mesmo
  // raciocínio da regra acima, e a mesma razão para ser erro e não warning — um
  // operador que acredita ter ligado a exclusão mútua e não ligou vai atribuir
  // as execuções duplicadas a outra causa.
  if (bool(c.FEATURE_TURN_CLAIM) && !bool(c.FEATURE_TURN_STATE_MACHINE)) {
    push({
      scope: 'contract',
      severity: 'error',
      variable: 'FEATURE_TURN_CLAIM',
      rule: 'turn-claim/requires-state-machine',
      message:
        'FEATURE_TURN_CLAIM=true com FEATURE_TURN_STATE_MACHINE=false é inerte: sem a máquina de estados não há turno durável para reivindicar, e duas réplicas continuam podendo processar o mesmo turno.',
      remediation:
        'Ligue FEATURE_TURN_STATE_MACHINE (migrations 096/097/114 aplicadas), ou desligue FEATURE_TURN_CLAIM. ATENÇÃO: desde #504 as duas vêm ON por default, então um rollback emergencial que desliga só FEATURE_TURN_STATE_MACHINE cai aqui — desligue as TRÊS flags de turno juntas. Ver docs/runbooks/turn-state-machine.md §6.',
    });
  }

  // Issue #504 §Contrato do job — o PRODUTOR V2 depende da máquina de estados
  // pela mesma razão que o claim: sem `agent_turns` não existe `turn_id`
  // durável, e `enqueueAgent` cairia de volta no V1 em todo enfileiramento. A
  // flag ligada seria uma promessa que o código não cumpre — e o operador
  // acreditaria ter migrado o produtor sem ter migrado.
  if (bool(c.FEATURE_TURN_JOB_V2) && !bool(c.FEATURE_TURN_STATE_MACHINE)) {
    push({
      scope: 'contract',
      severity: 'error',
      variable: 'FEATURE_TURN_JOB_V2',
      rule: 'turn-job-v2/requires-state-machine',
      message:
        'FEATURE_TURN_JOB_V2=true com FEATURE_TURN_STATE_MACHINE=false é inerte: sem a máquina de estados não existe turn_id durável, e todo enfileiramento continua armando o payload V1.',
      remediation:
        'Ligue FEATURE_TURN_STATE_MACHINE (migrations 096/097/114 aplicadas) antes de migrar o produtor, ou desligue FEATURE_TURN_JOB_V2. Ver docs/runbooks/turn-state-machine.md §7.',
    });
  }

  // Issue #631 (fatia B da #506) §Escopo de flag — "uma garantia de durabilidade
  // não pode ficar desligada em produção sem falha explícita".
  //
  // As duas regras abaixo são de naturezas DIFERENTES e nenhuma substitui a
  // outra:
  //
  //  (a) INERTE — a flag ligada sem `FEATURE_TURN_STATE_MACHINE` não commita
  //      nada: sem `agent_turns` não existe `turn_id`, e a FK composta da
  //      migração 121 torna a row durável inexprimível. Mesmo raciocínio (e
  //      mesmo formato) das regras de #503/#504 logo acima: silêncio aqui faria
  //      o operador acreditar que ligou a durabilidade sem ter ligado.
  //
  //  (b) FAIL-OPEN EM PRODUÇÃO — a flag DESLIGADA restaura o caminho que a
  //      auditoria da #506 descreveu: `src/agent/output-dispatch.ts` volta a
  //      enviar ao canal com o registro durável tratado como opcional. Isso é
  //      escopo `boot` e severidade `error`, e o escopo é deliberado: a regra
  //      tem de valer TAMBÉM no caminho de rollback `MAIA_CONFIG_STRICT_BOOT=false`,
  //      senão a alavanca de emergência do contrato viraria, sem querer, a
  //      alavanca para desligar a durabilidade do outbound. É o mesmo desenho
  //      de `lifecycle/schema-check-disabled` (#516/ADR 0004).
  //
  //      Fora de produção continua permitido — é a alavanca de rollback
  //      declarada, e em dev/staging existem fluxos legítimos (bisect,
  //      reprodução de bug do caminho legado) que precisam dela. Em staging
  //      AVISA, para que o valor não atravesse a promoção despercebido.
  if (bool(c.FEATURE_OUTBOUND_DURABLE_COMMIT) && !bool(c.FEATURE_TURN_STATE_MACHINE)) {
    push({
      scope: 'contract',
      severity: 'error',
      variable: 'FEATURE_OUTBOUND_DURABLE_COMMIT',
      rule: 'outbound-commit/requires-state-machine',
      message:
        'FEATURE_OUTBOUND_DURABLE_COMMIT=true com FEATURE_TURN_STATE_MACHINE=false é inerte: sem a máquina de estados não existe turn_id durável, a FK composta da migração 121 torna a row do outbox inexprimível, e todo envio volta a ocorrer sem commit transacional.',
      remediation:
        'Ligue FEATURE_TURN_STATE_MACHINE (migrations 096/097/114/121 aplicadas), ou desligue FEATURE_OUTBOUND_DURABLE_COMMIT — ciente de que em production desligá-la é recusado no boot. Ver docs/runbooks/turn-state-machine.md.',
    });
  }
  if (c.FEATURE_OUTBOUND_DURABLE_COMMIT === false) {
    if (profile === 'production') {
      push({
        scope: 'boot',
        severity: 'error',
        variable: 'FEATURE_OUTBOUND_DURABLE_COMMIT',
        rule: 'outbound-commit/production-required',
        message:
          'FEATURE_OUTBOUND_DURABLE_COMMIT=false não é permitido no profile production: a intenção de resposta deixaria de ser commitada antes da chamada ao canal, e o registro durável do outbound voltaria a ser opcional/fail-open — ou seja, uma mensagem pode chegar ao usuário sem que o PostgreSQL saiba que ela existiria (issue #506).',
        remediation:
          'Remova FEATURE_OUTBOUND_DURABLE_COMMIT=false (o default é true) e garanta a migration 121 aplicada. Se o objetivo é reproduzir o caminho legado, faça isso em staging/development — em production a durabilidade do outbound é obrigatória.',
      });
    } else if (profile !== 'development') {
      push({
        scope: 'contract',
        severity: 'warning',
        variable: 'FEATURE_OUTBOUND_DURABLE_COMMIT',
        rule: 'outbound-commit/production-required',
        message:
          'FEATURE_OUTBOUND_DURABLE_COMMIT=false: o envio volta a ocorrer sem commit transacional prévio, e uma falha do ledger deixa de impedir a entrega. Em production este valor é recusado no boot.',
        remediation:
          'Deixe FEATURE_OUTBOUND_DURABLE_COMMIT=true, a menos que este ambiente exista de propósito para exercitar o caminho legado.',
      });
    }
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
  // -------------------------------------------------------------------
  // Lifecycle do processo (issue #512): readiness role-aware e drain real.
  // -------------------------------------------------------------------

  const graceMs = num(c.SHUTDOWN_GRACE_MS);
  const stepMs = num(c.SHUTDOWN_STEP_TIMEOUT_MS);
  if (graceMs !== undefined && stepMs !== undefined && stepMs > graceMs) {
    push({
      scope: 'contract',
      severity: 'error',
      variable: 'SHUTDOWN_STEP_TIMEOUT_MS',
      rule: 'lifecycle/step-timeout-exceeds-grace',
      message:
        `SHUTDOWN_STEP_TIMEOUT_MS=${stepMs} é maior que SHUTDOWN_GRACE_MS=${graceMs}: o teto por passo nunca dispara, ` +
        'então um único componente travado consome o orçamento inteiro do drain e os passos seguintes (fechar sockets, filas e pools) são pulados por deadline.',
      remediation:
        'Deixe SHUTDOWN_STEP_TIMEOUT_MS <= SHUTDOWN_GRACE_MS — na prática uma fração dele, para sobrar orçamento para os demais passos.',
    });
  }

  const cacheMs = num(c.READINESS_CACHE_MS);
  const probeMs = num(c.READINESS_PROBE_TIMEOUT_MS);
  if (cacheMs !== undefined && probeMs !== undefined && cacheMs > 0 && probeMs > cacheMs) {
    push({
      scope: 'contract',
      severity: 'warning',
      variable: 'READINESS_PROBE_TIMEOUT_MS',
      rule: 'lifecycle/probe-timeout-exceeds-cache',
      message:
        `READINESS_PROBE_TIMEOUT_MS=${probeMs} é maior que READINESS_CACHE_MS=${cacheMs}: com uma dependência lenta cada requisição do load balancer volta a fazer I/O real, ` +
        'e o cache deixa de proteger DB/Redis exatamente durante o incidente em que ele mais importa.',
      remediation:
        'Mantenha READINESS_PROBE_TIMEOUT_MS <= READINESS_CACHE_MS, ou aumente a janela de cache.',
    });
  }

  // A checagem de schema é um gate fail-closed. Desde a #516 o /readyz consome
  // o veredito canônico (`getSchemaReadiness()`): dirty state, checksum
  // divergente, arquivo de migration ausente e schema incompatível derrubam a
  // instância para 503 — e, desde a ADR 0004, as MESMAS condições recusam o
  // BOOT com exit code próprio. Desligar isso é desligar a ÚNICA coisa que
  // impede a plataforma de servir tráfego contra um schema que ela não
  // consegue verificar.
  //
  // Em production isso é INVÁLIDO — o boot é recusado, não avisado (decisão do
  // owner na #516). Escopo `boot` de propósito: a regra vale também no caminho
  // de rollback `MAIA_CONFIG_STRICT_BOOT=false`, senão a alavanca de emergência
  // do contrato viraria, sem querer, a alavanca para desligar o gate de schema.
  //
  // Fora de production continua permitido: publicar código e schema fora de
  // banda é um fluxo legítimo em dev/staging. Em staging avisa; em development
  // é silencioso (fluxo normal de dev).
  if (c.READINESS_SCHEMA_CHECK === false) {
    if (profile === 'production') {
      push({
        scope: 'boot',
        severity: 'error',
        variable: 'READINESS_SCHEMA_CHECK',
        rule: 'lifecycle/schema-check-disabled',
        message:
          'READINESS_SCHEMA_CHECK=false não é permitido no profile production: o boot deixaria de consultar o veredito de schema (#516/ADR 0004) e o /readyz também, e a instância subiria e anunciaria readiness com migration pendente, ledger dirty, checksum divergente ou arquivo de migration ausente.',
        remediation:
          'Remova READINESS_SCHEMA_CHECK=false (o default é true). Se código e schema são publicados fora de banda, faça isso em staging/development — em production o gate é obrigatório.',
      });
    } else if (profile !== 'development') {
      push({
        scope: 'contract',
        severity: 'warning',
        variable: 'READINESS_SCHEMA_CHECK',
        rule: 'lifecycle/schema-check-disabled',
        message:
          'READINESS_SCHEMA_CHECK=false: o boot não vai recusar e a instância vai anunciar readiness mesmo com migration pendente, ledger dirty ou checksum divergente — e falhará na primeira query que tocar uma coluna nova.',
        remediation:
          'Deixe READINESS_SCHEMA_CHECK=true, a menos que código e schema sejam publicados fora de banda de propósito neste ambiente — é a alavanca declarada para manter dev/staging vivos contra um banco desalinhado. Em production o valor `false` é recusado no boot.',
      });
    }
  }

  // A separação de topologia (#513) ainda não foi entregue: o contrato de
  // papéis existe e o boot já ramifica por `roleOwns`, mas só `all` roda em
  // produção hoje. Avisar é honesto — bloquear impediria o rollout da #513.
  const processRole = str(c.MAIA_PROCESS_ROLE);
  if (processRole !== undefined && processRole !== 'all') {
    push({
      scope: 'contract',
      severity: 'warning',
      variable: 'MAIA_PROCESS_ROLE',
      rule: 'lifecycle/process-role-not-default',
      message:
        `MAIA_PROCESS_ROLE=${processRole}: este processo vai iniciar APENAS os componentes desse papel, e o /readyz vai exigir apenas os que ele requer. ` +
        'A separação de topologia (issue #513) ainda não foi entregue — garanta que os demais papéis estão rodando em outros processos, ou a plataforma fica sem worker/scheduler/sessão.',
      remediation:
        'Use MAIA_PROCESS_ROLE=all (modo de processo único) até a topologia estar separada, ou confirme o conjunto completo de papéis no deployment.',
    });
  }

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
