import { rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@/config/env.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import { setupState } from './state.js';
import { rotateToken } from './token.js';
import { sendAlert } from '@/lib/alerts.js';
import {
  assertIsDirectChildOfAuthRoot,
  assertSafeAuthDir,
  isReservedRootEntry,
  resolveLineAuthDir,
  resolvePrimaryAuthDir,
} from './auth-dir.js';

/**
 * Recovery por-alvo (auditoria P0 cap. 7).
 *
 * O layout multi-linha do auth dir compartilha UMA raiz entre a sessão
 * primária (`primary/`), as linhas adicionais (`lines/<id>`), os pareamentos
 * (`pairing/<id>`) e o setup token (`control/`). O recovery antigo fazia
 * `rm` da RAIZ inteira no LoggedOut da primária — destruindo as credenciais
 * de TODAS as linhas, os pareamentos em curso e o token. Agora:
 *
 *  - o recovery da PRIMÁRIA remove apenas `primary/` (mais as entradas de
 *    sessão legadas soltas na raiz, entrada a entrada) e rotaciona o token;
 *  - o recovery de uma LINHA adicional desativa o canal no DB (fail-closed:
 *    roteamento e boot param de usar a linha) e remove apenas `lines/<id>`;
 *  - TODO `rm` passa por `assertIsDirectChildOfAuthRoot` — remover a raiz é
 *    impossível por construção;
 *  - single-flight é POR ALVO (`Map<targetKey, Promise>`): dois LoggedOut do
 *    mesmo alvo convergem para uma execução; alvos distintos correm em
 *    paralelo sem se bloquear.
 */

/** Canal (triplete completo + linha) da recovery de uma linha ADICIONAL. */
export type LineRecoveryChannel = {
  id: string;
  tenant_id: string;
  agent_id: string;
  external_id: string;
};

export type RecoveryRequest =
  | {
      target: 'primary';
      /** Linha (E.164) da sessão primária, quando conhecida — só para nomear
       * o alvo no alerta ao operador. */
      line?: string | null;
      shutdownBaileys: () => Promise<void>;
      startBaileys: () => Promise<void>;
    }
  | { target: 'line'; channel: LineRecoveryChannel };

/** Mutable container — avoids Vitest live-binding getter wrapping of bare `let`. */
const _state = { recoveries: new Map<string, Promise<void>>() };

function targetKey(req: RecoveryRequest): string {
  return req.target === 'primary' ? 'primary' : `line:${req.channel.id}`;
}

function buildPrimaryRecoveryAlertBody(line: string | null): string {
  return `A sessão WhatsApp PRIMÁRIA da Maia (linha ${line ?? 'desconhecida'}) foi
derrubada (LoggedOut). Limpamos APENAS a sessão primária e geramos um novo
bootstrap token automaticamente. As linhas adicionais (lines/), os
pareamentos em curso (pairing/) e o diretório de controle NÃO foram tocados.

Para re-parear:
  1. SSH na VPS e leia o token novo:
     cat ${config.BAILEYS_AUTH_DIR}/control/setup-token.txt
  2. Abra no browser: <SUA_URL>/setup
  3. Cole o token na URL: ?token=<TOKEN>
  4. Escolha QR ou código de 8 dígitos.

Status atual: aguardando re-pareamento.
Token anterior está revogado.`;
}

function buildLineRecoveryAlertBody(channel: LineRecoveryChannel): string {
  return `A sessão da linha ADICIONAL ${channel.external_id} (canal ${channel.id})
foi derrubada (LoggedOut). O canal foi DESATIVADO (fail-closed: o roteamento
para de usar esta linha) e apenas o auth dir dela (lines/${channel.id}) foi
removido. A sessão primária, as demais linhas e o setup token NÃO foram
tocados; o token NÃO foi rotacionado.

Para reativar: re-pareie o canal pelo fluxo de pareamento declarado→verificado
(superfície /setup).`;
}

/**
 * Dispara o recovery do ALVO informado. Idempotente por alvo via promise
 * in-flight: triggers concorrentes do MESMO alvo juntam-se à mesma execução;
 * alvos diferentes (primária vs. linha X vs. linha Y) correm independentes.
 *
 * `target: 'primary'` — passos (na ordem; phase=unpaired ANTES do alerta
 * para o corpo "aguardando re-pareamento" casar o que o /setup mostra):
 *  1. setRecovering
 *  2. audit pairing_recovery_started { target: 'primary' }
 *  3. shutdownBaileys (injetado pelo caller)
 *  4. rm APENAS de primary/ (+ sweep das entradas legadas da raiz, uma a
 *     uma, cada rm guardado — NUNCA a raiz)
 *  5. rotateToken
 *  6. setUnpaired
 *  7. sendAlert (best-effort)
 *  8. audit pairing_recovery_completed { target: 'primary' }
 *  9. startBaileys (injetado pelo caller)
 *
 * `target: 'line'` — desativa o canal (DB, sob o ALS do dono — review #498
 * alto 2), remove APENAS `lines/<id>`, alerta best-effort e audita
 * started/completed com `{ target: <channelId> }`. NÃO rotaciona token nem
 * toca no setupState (fases do /setup são da primária).
 */
export function triggerRecovery(req: RecoveryRequest): Promise<void> {
  const key = targetKey(req);
  const inFlight = _state.recoveries.get(key);
  if (inFlight) return inFlight;
  const run = (req.target === 'primary' ? doPrimaryRecovery(req) : doLineRecovery(req)).finally(
    () => {
      _state.recoveries.delete(key);
    },
  );
  _state.recoveries.set(key, run);
  return run;
}

/**
 * Remove o estado de sessão da PRIMÁRIA e NADA além dele:
 *  - `primary/` (layout novo) — filho direto da raiz, rm guardado;
 *  - entradas de sessão LEGADAS soltas na raiz (boot cuja migração de layout
 *    falhou ainda roda na raiz) — entrada a entrada, pulando as reservadas
 *    (`lines/`, `pairing/`, `control/`, `media/`, `setup-token.txt`), cada
 *    rm guardado por `assertIsDirectChildOfAuthRoot`.
 * A raiz em si NUNCA é alvo de rm.
 */
async function removePrimaryAuthState(): Promise<void> {
  // Defense-in-depth: re-valida a raiz mesmo com a validação do env já feita.
  // Um valor podre aqui apagaria o diretório errado automaticamente em todo
  // LoggedOut, sem humano no loop.
  const root = assertSafeAuthDir(config.BAILEYS_AUTH_DIR);
  const primaryDir = assertIsDirectChildOfAuthRoot(resolvePrimaryAuthDir());
  logger.info({ dir: primaryDir }, 'setup.recovery_rm_auth_dir');
  await rm(primaryDir, { recursive: true, force: true });

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const name of entries) {
    if (isReservedRootEntry(name)) continue;
    if (name === 'primary') continue; // já removido acima
    await rm(assertIsDirectChildOfAuthRoot(join(root, name)), {
      recursive: true,
      force: true,
    });
  }
}

async function doPrimaryRecovery(req: Extract<RecoveryRequest, { target: 'primary' }>): Promise<void> {
  setupState.setRecovering();
  await audit({ acao: 'pairing_recovery_started', metadata: { target: 'primary' } });
  try {
    await req.shutdownBaileys();
    await removePrimaryAuthState();
    await rotateToken();
    setupState.setUnpaired();
    await sendAlert({
      subject: 'Maia desconectada — re-pareamento necessário',
      body: buildPrimaryRecoveryAlertBody(req.line ?? null),
    }).catch((err) => logger.warn({ err }, 'setup.recovery_alert_failed'));
    await audit({ acao: 'pairing_recovery_completed', metadata: { target: 'primary' } });
    await req.startBaileys();
  } catch (err) {
    logger.error({ err }, 'setup.recovery_failed_state_stays_recovering');
    // Don't reset phase — operator must SSH to investigate.
    throw err;
  }
}

async function doLineRecovery(req: Extract<RecoveryRequest, { target: 'line' }>): Promise<void> {
  const { channel } = req;
  // Imports dinâmicos: o caminho da PRIMÁRIA (e quem só importa este módulo,
  // ex.: admin-ui via baileys) não precisa carregar o cliente Postgres.
  const { runWithTenantContext } = await import('@/db/tenant-context.js');
  const { channelsRepo } = await import('@/db/repositories/channel-repos.js');

  // Audita sob o ALS do (tenant, agent) DONO do canal (review #498 alto 2):
  // sem o wrap, audit() cai no bucket `system` — metadata não corrige
  // colunas nem labels de métricas.
  const auditScoped = (input: Parameters<typeof audit>[0]): Promise<void> =>
    runWithTenantContext(
      { tenant_id: channel.tenant_id, agent_id: channel.agent_id },
      () => audit(input),
    );

  await auditScoped({
    acao: 'pairing_recovery_started',
    metadata: {
      target: channel.id,
      channel_id: channel.id,
      line_external_id: channel.external_id,
      is_primary: false,
    },
  });
  try {
    // 0. Resolve e valida o alvo ANTES de qualquer efeito: um channelId com
    //    traversal ('../evil', 'a/b') rejeita aqui — nem o DB é tocado.
    const dir = assertIsDirectChildOfAuthRoot(resolveLineAuthDir(channel.id));
    // 1. Persiste PRIMEIRO (fail-closed): canal inativo sai de
    //    listActiveWhatsappLinesCrossTenant (boot) e do exact-match do
    //    resolver — o roteamento para de usar a linha mesmo se o rm abaixo
    //    falhar. O canal volta ao estado "declarado": re-parear (§2.5,
    //    exige canal inativo) restaura a posse.
    const { rowCount } = await runWithTenantContext(
      { tenant_id: channel.tenant_id, agent_id: channel.agent_id },
      () => channelsRepo.deactivate(channel.id),
    );
    if (rowCount === 0) {
      logger.warn(
        { channel_id: channel.id },
        'setup.line_recovery_channel_row_missing',
      );
    }
    // 2. Remove APENAS o auth desta linha (guard de raiz aplicado acima).
    logger.info({ channel_id: channel.id, dir }, 'setup.line_recovery_rm_auth_dir');
    await rm(dir, { recursive: true, force: true });
    // 3. Alerta best-effort — nomeia a linha afetada; token NÃO rotacionado.
    await sendAlert({
      subject: `Maia — linha adicional ${channel.external_id} desconectada`,
      body: buildLineRecoveryAlertBody(channel),
    }).catch((err) => logger.warn({ err }, 'setup.line_recovery_alert_failed'));
    await auditScoped({
      acao: 'pairing_recovery_completed',
      metadata: {
        target: channel.id,
        channel_id: channel.id,
        line_external_id: channel.external_id,
        is_primary: false,
      },
    });
  } catch (err) {
    logger.error(
      { channel_id: channel.id, err },
      'setup.line_recovery_failed',
    );
    throw err;
  }
}

/**
 * Test-only export so we can verify and reset the per-target locks from unit
 * tests. `isRecovering()` sem argumento pergunta "há QUALQUER recovery em
 * curso?" (compatível com os testes pré-cap. 7); com uma key
 * (`'primary'` | `'line:<id>'`) pergunta pelo alvo específico.
 */
export const _internal = {
  isRecovering: (key?: string) =>
    key ? _state.recoveries.has(key) : _state.recoveries.size > 0,
  reset: () => {
    _state.recoveries.clear();
  },
};
