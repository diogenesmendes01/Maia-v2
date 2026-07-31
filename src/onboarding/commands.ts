/**
 * Issue #519 §4 — o contrato dos COMANDOS da saga, em Zod.
 *
 * Mora aqui, e não no router, por dois motivos:
 *   - o serviço valida o payload ANTES de reivindicar o passo, então router e
 *     serviço não podem discordar sobre o que é um comando válido;
 *   - o hash de idempotência é calculado sobre o payload JÁ VALIDADO. Se cada
 *     camada normalizasse por conta própria, o mesmo pedido produziria hashes
 *     diferentes e o "mesma chave, payload diferente" dispararia sozinho.
 *
 * `comment` (mín. 10 caracteres) é o motivo AUDITADO, no mesmo padrão que a
 * #518 já impõe em toda mutação de linha.
 */
import { z } from 'zod';
import { ONBOARDING_STEPS } from './state-machine.js';

/** Slug de tenant/agente — mesma gramática dos routers `tenants` e `agents`. */
const SlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'apenas minúsculas, dígitos, _ e -, começando por alfanumérico');

const CommentSchema = z.string().min(10).max(1000);

export const StepSchema = z.enum(ONBOARDING_STEPS);

/**
 * `create` provisiona um tenant novo (só founder); `attach` continua o
 * onboarding de um tenant que já existe. Separar os dois é o que impede a
 * "adoção" acidental de um tenant alheio: `create` recusa duplicata, `attach`
 * exige autorização explícita sobre aquele tenant.
 */
export const TenantStepSchema = z.object({
  mode: z.enum(['create', 'attach']),
  tenant_id: SlugSchema,
  nome: z.string().min(1).max(200).optional(),
  comment: CommentSchema,
});

/**
 * O administrador inicial do TENANT. `role` é fechado em `owner` de propósito:
 * "onboarding de tenants seguintes não cria novo founder global" é requisito da
 * issue. O founder só nasce no `global_bootstrap`, e lá o papel é imposto pelo
 * serviço, não escolhido pelo cliente.
 */
export const AdminStepSchema = z.object({
  email: z.string().email().max(320),
  name: z.string().min(1).max(200),
  comment: CommentSchema,
});

export const AgentStepSchema = z.object({
  agent_id: SlugSchema,
  nome: z.string().min(1).max(200),
  /** Arquétipo → packs extras. `null` = só o piso `BASE_AGENT_PACKS`. */
  archetype: z.string().min(1).max(64).nullable().optional(),
  role_descriptor: z.string().min(1).max(500),
  comment: CommentSchema,
});

export const ProfileStepSchema = z.object({
  /** Omitido ⇒ o serviço resolve a única versão `proposed` do agente. */
  profile_version_id: z.string().uuid().optional(),
  comment: CommentSchema,
});

export const CapabilitiesStepSchema = z.object({
  /** Packs EXTRAS. O piso (`BASE_AGENT_PACKS`) é sempre aplicado pelo backend. */
  extra_packs: z.array(z.string().min(1).max(64)).max(32).default([]),
  comment: CommentSchema,
});

export const RoleStepSchema = z.object({
  role_key: SlugSchema,
  display_name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  prompt_addendum: z.string().max(4000).optional(),
  comment: CommentSchema,
});

export const ChannelStepSchema = z.object({
  /** Linha E.164 com `+`. O repo normaliza e recusa o que não for linha. */
  external_id: z.string().min(1).max(200),
  display_name: z.string().min(1).max(200).optional(),
  switch_behavior: z
    .enum(['locked', 'prefer_handoff', 'free_with_trigger', 'by_context'])
    .default('locked'),
  comment: CommentSchema,
});

/**
 * O pareamento em si é executado pelo router da #518 (`channelLines.*`), que já
 * tem rate limit, checagem de keyring e fila durável de comandos. Este passo só
 * declara que a run está ESPERANDO — a conclusão é observada em `readiness`,
 * nunca declarada pela UI.
 */
export const PairingStepSchema = z.object({
  comment: CommentSchema,
});

export const ReadinessStepSchema = z.object({});

export const ActivationStepSchema = z.object({
  /**
   * Confirmação explícita do par que o operador está vendo na tela. O backend
   * compara com o escopo da run: se divergir, recusa. É o "operador vê
   * tenant/agente exatos antes de ativar" transformado em precondição de
   * servidor, em vez de um texto na tela.
   */
  confirm_tenant_id: SlugSchema,
  confirm_agent_id: SlugSchema,
  comment: CommentSchema,
});

export const STEP_PAYLOAD_SCHEMAS = {
  tenant: TenantStepSchema,
  admin: AdminStepSchema,
  agent: AgentStepSchema,
  profile: ProfileStepSchema,
  capabilities: CapabilitiesStepSchema,
  role: RoleStepSchema,
  channel: ChannelStepSchema,
  pairing: PairingStepSchema,
  readiness: ReadinessStepSchema,
  activation: ActivationStepSchema,
} as const;

export type TenantStepInput = z.infer<typeof TenantStepSchema>;
export type AdminStepInput = z.infer<typeof AdminStepSchema>;
export type AgentStepInput = z.infer<typeof AgentStepSchema>;
export type ProfileStepInput = z.infer<typeof ProfileStepSchema>;
export type CapabilitiesStepInput = z.infer<typeof CapabilitiesStepSchema>;
export type RoleStepInput = z.infer<typeof RoleStepSchema>;
export type ChannelStepInput = z.infer<typeof ChannelStepSchema>;
export type PairingStepInput = z.infer<typeof PairingStepSchema>;
export type ActivationStepInput = z.infer<typeof ActivationStepSchema>;

/**
 * Envelope de qualquer comando mutável. `idempotency_key` é opaca para o
 * backend: só o SHA-256 é persistido, e o cliente DEVE conservar a mesma chave
 * até obter um resultado conclusivo (é isso que faz o retry devolver o
 * resultado anterior em vez de duplicar recurso).
 */
export const StepCommandSchema = z.object({
  run_id: z.string().uuid(),
  step: StepSchema,
  /** Versão da run que o cliente leu. CAS: divergiu ⇒ conflito tipado. */
  expected_version: z.number().int().min(0),
  idempotency_key: z.string().min(8).max(200),
  payload: z.unknown(),
});
export type StepCommand = z.infer<typeof StepCommandSchema>;

/**
 * Bootstrap global. O segredo viaja NO CORPO — nunca em query string, nunca em
 * header customizado logado por proxy.
 */
export const BootstrapCommandSchema = z.object({
  secret: z.string().min(32).max(512),
  tenant_id: SlugSchema,
  tenant_nome: z.string().min(1).max(200),
  admin_email: z.string().email().max(320),
  admin_name: z.string().min(1).max(200),
});
export type BootstrapCommand = z.infer<typeof BootstrapCommandSchema>;
