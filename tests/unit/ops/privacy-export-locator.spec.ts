import { describe, it, expect } from 'vitest';
import nodePath from 'node:path';
import {
  assertLocatorBoundToRequest,
  assertSafeExportLocator,
  exportArtifactFilename,
  isSafeExportLocator,
  proveExportArtifact,
  resolveExportArtifactPath,
  UnsafeExportLocatorError,
  type ExportPathProbe,
} from '../../../src/ops/privacy/export-locator.js';

/**
 * Issue #536 — o guarda destrutivo do `.enc`.
 *
 * A SONDA DE PATH É SOBRE O QUE NÃO ACONTECE. Este arquivo cobre o guarda
 * isoladamente; a prova de que ele está NO CAMINHO da remoção (e não apenas
 * disponível para quem lembrar de chamá-lo) está em
 * `privacy-export-sweeper.spec.ts`, que verifica que a porta `remove` NEM É
 * ALCANÇADA para um locator envenenado.
 */

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const ROOT = '/srv/backups/privacy-export';

function probe(opts: {
  files?: Record<string, { symlink?: boolean; dir?: boolean; nlink?: number }>;
  realpaths?: Record<string, string>;
  rootThrows?: boolean;
  lstatThrows?: string;
} = {}): ExportPathProbe {
  const files = opts.files ?? {};
  return {
    realpath: async (p) => {
      if (p === ROOT) {
        if (opts.rootThrows) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
        return opts.realpaths?.[p] ?? p;
      }
      if (opts.realpaths?.[p]) return opts.realpaths[p];
      if (files[p]) return p;
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    lstat: async (p) => {
      if (opts.lstatThrows) {
        throw Object.assign(new Error('boom'), { code: opts.lstatThrows });
      }
      const f = files[p];
      if (!f) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return {
        isSymbolicLink: () => f.symlink === true,
        isFile: () => f.dir !== true && f.symlink !== true,
        nlink: f.nlink ?? 1,
      };
    },
  };
}

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof UnsafeExportLocatorError) return err.reason;
    return `unexpected:${(err as Error).name}`;
  }
  return 'no-throw';
}

describe('assertSafeExportLocator — camada 1 (forma)', () => {
  it('aceita o UUID que sealExport emite', () => {
    expect(assertSafeExportLocator(UUID)).toBe(UUID);
    expect(isSafeExportLocator(UUID)).toBe(true);
    expect(exportArtifactFilename(UUID)).toBe(`${UUID}.enc`);
  });

  it.each([
    ['', 'empty_or_non_string'],
    [`  ${UUID}  `, 'surrounding_whitespace'],
    [`${UUID}\u0000.enc`, 'control_character'],
    ['../../etc/passwd', 'path_separator'],
    ['..\\..\\windows', 'path_separator'],
    ['..', 'parent_traversal'],
    ['C:evil', 'drive_letter'],
    ['/etc/passwd', 'path_separator'],
    ['not-a-uuid', 'not_an_export_locator'],
    [UUID.toUpperCase(), 'not_an_export_locator'],
  ])('recusa %j como %s', (locator, reason) => {
    expect(reasonOf(() => assertSafeExportLocator(locator))).toBe(reason);
  });

  it('recusa não-string sem lançar TypeError', () => {
    expect(reasonOf(() => assertSafeExportLocator(null))).toBe('empty_or_non_string');
    expect(reasonOf(() => assertSafeExportLocator(42))).toBe('empty_or_non_string');
    expect(isSafeExportLocator({ toString: () => UUID })).toBe(false);
  });

  /**
   * A ORDEM DAS CHECAGENS É CONTRATO — mesmo raciocínio de `assertDrillTarget`.
   * `../../etc/passwd` é ao mesmo tempo "tem separador" e "não é um UUID". O
   * código que aterrissa na auditoria tem que ser o que diz ao operador que
   * alguém tentou sair da árvore, não o que diz que a string está feia.
   */
  it('nomeia o PIOR fato verdadeiro, não o primeiro conveniente', () => {
    expect(reasonOf(() => assertSafeExportLocator('../../etc/passwd'))).toBe('path_separator');
    expect(reasonOf(() => assertSafeExportLocator('..'))).toBe('parent_traversal');
    expect(reasonOf(() => assertSafeExportLocator('C:evil'))).toBe('drive_letter');
  });

  it('nunca normaliza — devolve a string original ou lança', () => {
    // Um traversal "limpo" continua sendo um caminho escolhido por outra pessoa.
    expect(reasonOf(() => assertSafeExportLocator(`${UUID}/../../x`))).toBe('path_separator');
  });
});

describe('resolveExportArtifactPath — camada 2 (contenção)', () => {
  it('resolve para filho direto da raiz', () => {
    expect(resolveExportArtifactPath(ROOT, UUID)).toBe(nodePath.join(ROOT, `${UUID}.enc`));
  });

  it('recusa raiz vazia', () => {
    expect(reasonOf(() => resolveExportArtifactPath('   ', UUID))).toBe('empty_export_root');
  });

  /**
   * `startsWith(root + sep)` sozinho aceitaria `/exports-evil/x` para uma raiz
   * `/exports`. A prova é por IDENTIDADE de filho direto, e este caso fixa isso
   * com semântica win32 num host POSIX.
   */
  it('vale nas duas semânticas de path', () => {
    const win = resolveExportArtifactPath('C:\\backups\\privacy-export', UUID, nodePath.win32);
    expect(win).toBe(`C:\\backups\\privacy-export\\${UUID}.enc`);
  });
});

describe('proveExportArtifact — camada 3 (inode)', () => {
  const abs = nodePath.join(ROOT, `${UUID}.enc`);

  it('aprova um arquivo regular dentro da raiz', async () => {
    const p = await proveExportArtifact(ROOT, UUID, probe({ files: { [abs]: {} } }));
    expect(p).toEqual({ path: abs, present: true });
  });

  /**
   * AUSÊNCIA NÃO É FALHA. É o estado normal da segunda passagem do varredor
   * sobre o mesmo pedido, e é o que torna a idempotência possível sem tratar
   * "já não está lá" como erro.
   */
  it('devolve present:false quando o arquivo já não existe', async () => {
    const p = await proveExportArtifact(ROOT, UUID, probe({ files: {} }));
    expect(p).toEqual({ path: abs, present: false });
  });

  it('recusa symlink — lstat, nunca stat', async () => {
    await expect(
      proveExportArtifact(ROOT, UUID, probe({ files: { [abs]: { symlink: true } } })),
    ).rejects.toMatchObject({ code: 'unsafe_export_locator', reason: 'symlink' });
  });

  it('recusa o que não é arquivo regular', async () => {
    await expect(
      proveExportArtifact(ROOT, UUID, probe({ files: { [abs]: { dir: true } } })),
    ).rejects.toMatchObject({ reason: 'not_a_regular_file' });
  });

  /**
   * Hard link: existe outro nome para os MESMOS bytes. Remover o nosso destrói
   * o rastro e não o dado — e o pedido passaria a afirmar que o artefato foi
   * destruído. Evidência de conformidade sem a conformidade.
   */
  it('recusa artefato com outro hard link', async () => {
    await expect(
      proveExportArtifact(ROOT, UUID, probe({ files: { [abs]: { nlink: 2 } } })),
    ).rejects.toMatchObject({ reason: 'multiply_linked' });
  });

  it('recusa quando a raiz não pode ser resolvida — fail-closed', async () => {
    await expect(
      proveExportArtifact(ROOT, UUID, probe({ files: { [abs]: {} }, rootThrows: true })),
    ).rejects.toMatchObject({ reason: 'root_unresolvable' });
  });

  it('recusa quando lstat falha por outro motivo que não ausência', async () => {
    await expect(
      proveExportArtifact(ROOT, UUID, probe({ lstatThrows: 'EACCES' })),
    ).rejects.toMatchObject({ reason: 'stat_failed' });
  });

  /**
   * A prova final é contra a árvore REAL: se o caminho nominal existe mas seus
   * bytes moram fora da raiz física, é escape, mesmo sem symlink no folha.
   */
  it('recusa quando o caminho real cai fora da raiz real', async () => {
    await expect(
      proveExportArtifact(
        ROOT,
        UUID,
        probe({
          files: { [abs]: {} },
          realpaths: { [abs]: '/somewhere/else/x.enc' },
        }),
      ),
    ).rejects.toMatchObject({ reason: 'escapes_export_root' });
  });
});

describe('assertLocatorBoundToRequest — camada 4 (o locator é DESTE pedido?)', () => {
  const planned = {
    request_id: 'req-1',
    tenant_id: 'primary',
    agent_id: 'primary',
    locator: UUID,
  };

  it('aceita o binding idêntico', () => {
    expect(() => assertLocatorBoundToRequest(planned, { ...planned })).not.toThrow();
  });

  it('recusa quando a linha sumiu entre planejar e apagar', () => {
    expect(reasonOf(() => assertLocatorBoundToRequest(planned, null))).toBe('request_vanished');
  });

  it('recusa quando o locator mudou (export reemitido)', () => {
    expect(
      reasonOf(() =>
        assertLocatorBoundToRequest(planned, {
          ...planned,
          locator: '11111111-2222-3333-4444-555555555555',
        }),
      ),
    ).toBe('locator_not_bound_to_request');
  });

  it('recusa quando o escopo mudou — nunca apaga por conta de outro tenant', () => {
    expect(
      reasonOf(() => assertLocatorBoundToRequest(planned, { ...planned, tenant_id: 'outro' })),
    ).toBe('locator_not_bound_to_request');
  });

  it('recusa o sentinela `default` mesmo com tudo o resto batendo', () => {
    const legacy = { ...planned, tenant_id: 'default', agent_id: 'default' };
    expect(reasonOf(() => assertLocatorBoundToRequest(legacy, { ...legacy }))).toBe(
      'default_scope_sentinel',
    );
  });
});
