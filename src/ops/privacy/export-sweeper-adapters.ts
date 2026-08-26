/**
 * Issue #536 — o IO por trás de `ExportSweepPorts`.
 *
 * Mesma divisão de `execution.ts`/`adapters.ts`: a decisão vive em
 * `export-sweeper.ts` e é 100% testada com fakes; este arquivo é só efeito
 * colateral — SQL, `lstat`, `realpath`, `rm`.
 *
 * A RAIZ VEM DE UM LUGAR SÓ. `privacyWorkspace()` é importada de `adapters.ts`,
 * que é onde `sealExport` GRAVA o `.enc`. Duas definições que divergissem
 * produziriam um varredor que não acha nada, e o TTL voltaria a ser um carimbo
 * sem execução — silenciosamente, que é a pior forma de voltar.
 *
 * `lstat` E NÃO `stat`. `stat` segue o link simbólico e devolve o inode do
 * ALVO: um `.enc` que fosse um symlink para fora da árvore de exports passaria
 * como arquivo regular e a remoção seguiria adiante. É exatamente o caso que o
 * guarda existe para recusar.
 */
import { lstat, realpath, rm, stat } from 'node:fs/promises';
import { privacyWorkspace, listHolds } from './adapters.js';
import {
  claimExportPurge,
  finalizeExportPurge,
  listExpiredExportArtifacts,
  readExportBinding,
  recordExportPurgeRefusal,
} from '@/db/repositories/ops-repos.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { logger } from '@/lib/logger.js';
import type { ExportSweepPorts } from './export-sweeper.js';

export function createExportSweepPorts(): ExportSweepPorts {
  return {
    now: () => new Date(),
    exportRoot: privacyWorkspace,
    listCandidates: (limit) => listExpiredExportArtifacts(new Date(), limit),
    listHolds,
    readBinding: readExportBinding,
    claim: claimExportPurge,
    probe: {
      realpath: (p) => realpath(p),
      lstat: (p) => lstat(p),
    },
    // `force: true` — ENOENT é sucesso. É metade do que torna a segunda
    // execução do varredor inofensiva: um passe que caiu depois de apagar e
    // antes de marcar reencontra o pedido, não acha o arquivo, e conclui.
    remove: async (path) => {
      await rm(path, { force: true });
    },
    // "a remoção não lançou" NÃO é evidência. Esta é a mesma prova que
    // `runArtifactRetention` exige desde o achado P1 da rodada 1 da #520, onde
    // um delete que mentia produzia um passe verde sobre um artefato vivo.
    confirmRemoved: async (path) => {
      try {
        await stat(path);
        return false;
      } catch (err) {
        return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
      }
    },
    // O PASSE é cross-tenant (roda sob `system`, é manutenção), mas cada
    // artefato pertence a um titular de um tenant — e a linha de auditoria da
    // remoção precisa ser dele (invariante nº 1). Por isso as DUAS escritas de
    // auditoria abrem o contexto do tenant da própria linha. Sem isso a
    // remoção do dado de um tenant apareceria no balde `system`, e o operador
    // daquele tenant nunca a veria na própria trilha.
    finalize: (record) =>
      runWithTenantContext(
        { tenant_id: record.tenant_id, agent_id: record.agent_id },
        () => finalizeExportPurge(record),
      ),
    recordRefusal: (record) =>
      runWithTenantContext(
        { tenant_id: record.tenant_id, agent_id: record.agent_id },
        () => recordExportPurgeRefusal(record),
      ),
    log: (event, detail) => logger.warn(detail, event),
  };
}
