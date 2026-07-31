/**
 * Issue #519 §9 — emissão da credencial de BOOTSTRAP GLOBAL.
 *
 * Substitui o `INSERT INTO app_users (...)` manual que
 * `docs/admin-ui-deploy.md` documentava. O operador roda isto UMA vez na
 * instalação, copia o segredo impresso e o cola no formulário de bootstrap do
 * console (que o envia no CORPO de um POST, nunca em query string).
 *
 * Propriedades deste comando:
 *   - o segredo é gerado com `crypto.randomBytes(48)` e mostrado UMA vez —
 *     não há como recuperá-lo depois, por construção;
 *   - o banco recebe apenas o SHA-256. Um dump não contém o segredo;
 *   - existe no máximo UMA credencial viva (índice parcial da migration 114):
 *     emitir outra exige revogar a anterior explicitamente;
 *   - a credencial expira; o default de 2 horas é curto de propósito, porque
 *     ela concede a criação do primeiro founder da instalação.
 *
 * Uso:
 *   npm run bootstrap:credential -- issue --label "deploy inicial" --ttl-hours 2
 *   npm run bootstrap:credential -- status
 *   npm run bootstrap:credential -- revoke --reason "credencial vazada"
 */
import { randomBytes } from 'node:crypto';
import { appUsersRepo, bootstrapCredentialsRepo, hashOpaque } from '@/db/repositories.js';
import { shutdownDb } from '@/db/client.js';

function flag(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function issue(): Promise<void> {
  // A porta do bootstrap só existe enquanto NÃO há identidade administrativa.
  // Emitir uma credencial numa instalação já provisionada seria emitir um
  // token que nunca poderá ser usado — e que, se vazasse, pareceria válido.
  if (await appUsersRepo.hasAnyUser()) {
    console.error(
      'Esta instalação já possui usuário administrativo. O bootstrap global está fechado\n' +
        'definitivamente; crie novos usuários pelo console (wizard de onboarding).',
    );
    process.exitCode = 1;
    return;
  }

  const ttlHours = Number(flag('ttl-hours') ?? '2');
  if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 72) {
    console.error('--ttl-hours deve ser um número entre 0 e 72.');
    process.exitCode = 1;
    return;
  }

  // 48 bytes = 384 bits. Muito acima do necessário, e barato: o custo de um
  // segredo curto aqui é a criação do primeiro founder por um terceiro.
  const secret = randomBytes(48).toString('base64url');
  const result = await bootstrapCredentialsRepo.issue({
    secret_hash: hashOpaque(secret),
    label: flag('label') ?? null,
    created_by: 'cli',
    expires_at: new Date(Date.now() + ttlHours * 3600_000),
  });

  if (!result.ok) {
    console.error(
      'Já existe uma credencial de bootstrap viva. Revogue-a antes de emitir outra:\n' +
        '  npm run bootstrap:credential -- revoke --reason "..."',
    );
    process.exitCode = 1;
    return;
  }

  // O segredo aparece AQUI e em nenhum outro lugar. Não vai para log
  // estruturado, para auditoria nem para o banco.
  console.log('\nCredencial de bootstrap emitida. Copie o segredo AGORA — ele não é recuperável.\n');
  console.log(`  segredo:  ${secret}`);
  console.log(`  id:       ${result.credential.id}`);
  console.log(`  expira:   ${result.credential.expires_at.toISOString()}`);
  console.log(
    '\nUse-o no formulário de bootstrap do console (/onboarding/bootstrap), com\n' +
      'MAIA_ONBOARDING_BOOTSTRAP=true. Ele é de uso único e é invalidado no sucesso.\n',
  );
}

async function status(): Promise<void> {
  const bootstrapped = await appUsersRepo.hasAnyUser();
  const live = await bootstrapCredentialsRepo.hasLiveCredential();
  console.log(`identidade administrativa existente: ${bootstrapped ? 'sim' : 'não'}`);
  console.log(`credencial de bootstrap viva:        ${live ? 'sim' : 'não'}`);
  console.log(
    `bootstrap global aceito agora:       ${!bootstrapped && live ? 'sim' : 'não'}`,
  );
}

async function revoke(): Promise<void> {
  const reason = flag('reason');
  if (!reason || reason.trim().length < 5) {
    console.error('--reason é obrigatório (mínimo 5 caracteres) e fica registrado na row.');
    process.exitCode = 1;
    return;
  }
  const n = await bootstrapCredentialsRepo.revokeLive({ reason: reason.trim() });
  console.log(`${n} credencial(is) revogada(s).`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'issue':
      await issue();
      break;
    case 'status':
      await status();
      break;
    case 'revoke':
      await revoke();
      break;
    default:
      console.log('uso: bootstrap-credential.ts <issue|status|revoke> [--label X] [--ttl-hours N] [--reason X]');
      process.exitCode = 1;
  }
}

await main();
await shutdownDb();
