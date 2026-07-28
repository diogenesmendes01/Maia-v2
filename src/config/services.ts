/**
 * Minimum configuration per service (issue #515).
 *
 * Answers "which variables does THIS container actually need?" — which is what
 * bounds the blast radius of a secret. The migration runner does not need the
 * WhatsApp session or the LLM keys; the Admin UI does not need the S3 backup
 * credentials.
 *
 * PURE module.
 */
import { CONTRACT_VERSION, entriesForService } from '@/config/contract.js';
import {
  type EnvVarSpec,
  type MaiaProfile,
  MAIA_SERVICES,
  type MaiaService,
  describeRequiredWhen,
} from '@/config/metadata.js';

export interface ServiceManifestEntry {
  readonly name: string;
  readonly secret: boolean;
  readonly required: boolean;
  readonly group: string;
  readonly restartRequired: boolean;
  readonly requiredWhen?: string;
}

export interface ServiceManifest {
  readonly service: MaiaService;
  readonly profile: MaiaProfile;
  readonly variables: readonly ServiceManifestEntry[];
  readonly secrets: readonly string[];
}

/** A variable is "required" when the profile demands it or it has no default. */
function isRequired(spec: EnvVarSpec, profile: MaiaProfile): boolean {
  if (spec.requiredIn?.includes(profile)) return true;
  // No default and not optional ⇒ the schema itself rejects an absent value.
  return spec.schema.safeParse(undefined).success === false;
}

/** Manifest for one service in one profile. */
export function manifestForService(
  service: MaiaService,
  profile: MaiaProfile,
): ServiceManifest {
  const variables = entriesForService(service).map((spec) => ({
    name: spec.name,
    secret: spec.secret,
    required: isRequired(spec, profile),
    group: spec.group,
    restartRequired: spec.restartRequired,
    ...(spec.requiredWhen ? { requiredWhen: describeRequiredWhen(spec.requiredWhen) } : {}),
  }));
  return {
    service,
    profile,
    variables,
    secrets: variables.filter((v) => v.secret).map((v) => v.name),
  };
}

/** Full manifest (every service × every profile) — the generated artifact. */
export function buildServiceManifest(profiles: readonly MaiaProfile[]): {
  contract_version: string;
  services: Record<string, unknown>;
} {
  const services: Record<string, unknown> = {};
  for (const service of MAIA_SERVICES) {
    const perProfile: Record<string, unknown> = {};
    for (const profile of profiles) {
      const m = manifestForService(service, profile);
      perProfile[profile] = {
        required: m.variables.filter((v) => v.required).map((v) => v.name),
        optional: m.variables.filter((v) => !v.required).map((v) => v.name),
      };
    }
    services[service] = {
      variables: manifestForService(service, 'production').variables,
      secrets: manifestForService(service, 'production').secrets,
      by_profile: perProfile,
    };
  }
  return { contract_version: CONTRACT_VERSION, services };
}

/**
 * Guard for the "a module must not read another service's configuration"
 * rule. Throws a typed, actionable error instead of silently returning
 * `undefined` (which is how a secret ends up mis-scoped).
 */
export function assertServiceMayRead(service: MaiaService, name: string): void {
  const allowed = entriesForService(service).some((s) => s.name === name);
  if (!allowed) {
    throw new Error(
      `config: o serviço "${service}" não declara a variável "${name}". ` +
        'Declare o serviço em src/config/contract.ts (campo `services`) ou leia a ' +
        'configuração pelo loader do serviço correto.',
    );
  }
}
