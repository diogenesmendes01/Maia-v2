/**
 * Issue #571, revisão da PR #597 — o bring-up de infra tem UM modelo, e ele
 * está escrito.
 *
 * ## O achado
 *
 * A #571 mandou cada worktree rodar `npm run test:integration:setup`, mas o
 * `docker-compose.yml` fixa `container_name` globais (`maia-postgres`,
 * `maia-redis`) e as portas 5432/6379 do host. Como o Compose deriva o nome do
 * projeto do DIRETÓRIO, cada árvore pedia uma pilha PRÓPRIA com nomes e portas
 * GLOBAIS: a segunda worktree não conseguia subir enquanto a primeira
 * estivesse de pé.
 *
 * ## O modelo escolhido
 *
 * **(a) infra física COMPARTILHADA, um coordenador só.** Um Postgres e um
 * Redis para o host; o isolamento entre árvores é o banco por worktree e o db
 * lógico do Redis por worktree. A alternativa (b) — projeto/containers/portas
 * derivados por worktree — foi recusada com motivo registrado em
 * `scripts/test-infra.ts`.
 *
 * ## O que este arquivo garante
 *
 * Que a escolha continue verdadeira no repositório: nome de projeto fixo no
 * Compose, `up` e `down` passando pelo coordenador, e `down` exigindo
 * consentimento — porque `docker compose down -v` apaga a infra de TODAS as
 * árvores, inclusive das que estão rodando agora. Ele lê os bytes commitados;
 * não roda Docker.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { asMap, asString, parseComposeFile } from '../migrations/_compose-yaml.js';
import {
  CONSENTIMENTO_TEARDOWN,
  NOME_DO_PROJETO,
  SERVICOS,
  motivoParaRecusarTeardown,
} from '../../../scripts/test-infra.js';

const RAIZ = resolve(__dirname, '../../..');
const COMPOSE = resolve(RAIZ, 'docker-compose.yml');

describe('#571 — infra de teste compartilhada, um coordenador só', () => {
  it('o compose de dev fixa o nome do projeto — sem isso cada worktree pede uma pilha', () => {
    const raiz = asMap(parseComposeFile(COMPOSE), 'docker-compose.yml');
    expect(
      asString(raiz.name, 'docker-compose.yml: name'),
      'sem `name:` o Compose usa o nome do DIRETÓRIO, que é diferente em cada worktree',
    ).toBe(NOME_DO_PROJETO);
  });

  it('os serviços de dados continuam com nome e porta GLOBAIS — é o que (a) significa', () => {
    // Não é descuido: é a consequência declarada da escolha. Se um dia alguém
    // quiser o modelo (b), estas asserções são o lugar onde a decisão muda.
    const servicos = asMap(asMap(parseComposeFile(COMPOSE), 'compose').services, 'services');
    for (const nome of SERVICOS) {
      const s = asMap(servicos[nome], `services.${nome}`);
      expect(asString(s.container_name, `services.${nome}.container_name`)).toBe(`maia-${nome}`);
    }
  });

  it('o teardown é recusado sem consentimento explícito, e diz por quê', () => {
    const motivo = motivoParaRecusarTeardown({});
    expect(motivo, 'derrubar a infra compartilhada não pode ser o default').not.toBeNull();
    expect(motivo).toContain('HOST INTEIRO');
    expect(motivo).toContain(CONSENTIMENTO_TEARDOWN);
  });

  it('com consentimento, o teardown segue', () => {
    expect(motivoParaRecusarTeardown({ [CONSENTIMENTO_TEARDOWN]: 'yes' })).toBeNull();
    // Qualquer outro valor NÃO vale: `TEST_INFRA_TEARDOWN=0` não pode passar.
    expect(motivoParaRecusarTeardown({ [CONSENTIMENTO_TEARDOWN]: '0' })).not.toBeNull();
    expect(motivoParaRecusarTeardown({ [CONSENTIMENTO_TEARDOWN]: 'true' })).not.toBeNull();
  });

  it('os scripts do package.json passam pelo coordenador, não pelo compose cru', () => {
    const pkg = JSON.parse(readFileSync(resolve(RAIZ, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['test:integration:setup']).toContain('scripts/test-infra.ts');
    expect(pkg.scripts['test:integration:teardown']).toContain('scripts/test-infra.ts');
    // Um `docker compose down -v` solto no script é justamente o que a decisão
    // remove — ele não pergunta de quem é a infra que está apagando.
    expect(pkg.scripts['test:integration:teardown']).not.toContain('docker compose');
  });

  it('a escolha está DOCUMENTADA no README, não só no código', () => {
    // "Escolher e documentar um modelo único" foi o pedido da revisão. Um
    // modelo que só existe no código é um modelo que a próxima worktree
    // descobre batendo nele.
    const readme = readFileSync(resolve(RAIZ, 'README.md'), 'utf8');
    expect(readme).toContain(CONSENTIMENTO_TEARDOWN);
    expect(readme).toContain(NOME_DO_PROJETO);
  });
});
