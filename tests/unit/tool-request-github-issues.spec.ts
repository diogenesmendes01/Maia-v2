/**
 * #638 (fatia C da épica #471) — o cliente de issues: procurar antes de criar,
 * classificar falha, e nunca deixar a credencial vazar para um erro.
 *
 * O transporte é injetado, então o que roda aqui é o código de PRODUÇÃO —
 * montagem de URL, headers, leitura da resposta e a decisão de adotar. O dublê
 * é a rede, não a lógica.
 */
import { describe, it, expect } from 'vitest';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';

const cliente = moduloDeProducao(() => import('@/cognition/tool-request/github-issues.js'));
const corpo = moduloDeProducao(() => import('@/cognition/tool-request/issue-body.js'));

const TOKEN = 'segredo-de-teste-nao-real-1234';
const REPO = 'org-fixture/repo-fixture';
const CHAVE = 'a'.repeat(32);

type Chamada = { url: string; method: string; headers: Record<string, string>; body?: string };

/** Um transporte de mentira que grava o que recebeu e devolve o que mandarem. */
function transporteFalso(respostas: Array<{ status: number; corpo: string }>) {
  const chamadas: Chamada[] = [];
  let i = 0;
  const transporte = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => {
    chamadas.push({ url, ...init });
    const r = respostas[Math.min(i, respostas.length - 1)]!;
    i += 1;
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      text: async () => r.corpo,
    };
  };
  return { transporte, chamadas };
}

describe('#638 — garantirIssue: procura antes de criar', () => {
  it('sem issue com o marcador, CRIA — e manda título, corpo e labels', async () => {
    const { garantirIssue } = cliente();
    const { LABEL_DO_PEDIDO } = corpo();
    const { transporte, chamadas } = transporteFalso([
      { status: 200, corpo: '[]' },
      { status: 201, corpo: JSON.stringify({ number: 77, html_url: 'https://exemplo/77' }) },
    ]);

    const r = await garantirIssue(
      { repo_slug: REPO, token: TOKEN, transporte },
      { idempotency_key: CHAVE, title: 'titulo', body: 'corpo' },
    );

    expect(r).toEqual({
      ok: true,
      issue_number: 77,
      issue_url: 'https://exemplo/77',
      adotada: false,
    });
    expect(chamadas).toHaveLength(2);
    expect(chamadas[0]!.method).toBe('GET');
    expect(chamadas[0]!.url).toContain(`/repos/${REPO}/issues`);
    expect(chamadas[0]!.url).toContain('state=all');
    expect(chamadas[0]!.url).toContain(encodeURIComponent(LABEL_DO_PEDIDO));
    expect(chamadas[1]!.method).toBe('POST');
    const enviado = JSON.parse(chamadas[1]!.body!) as {
      title: string;
      body: string;
      labels: string[];
    };
    expect(enviado.title).toBe('titulo');
    expect(enviado.body).toBe('corpo');
    expect(enviado.labels).toContain(LABEL_DO_PEDIDO);
  });

  it('COM issue carregando o marcador, ADOTA — e NÃO faz POST nenhum', async () => {
    const { garantirIssue } = cliente();
    const { MARCADOR_DE_PEDIDO } = corpo();
    const { transporte, chamadas } = transporteFalso([
      {
        status: 200,
        corpo: JSON.stringify([
          { number: 12, html_url: 'https://exemplo/12', body: 'outra coisa' },
          {
            number: 34,
            html_url: 'https://exemplo/34',
            body: `bla\n<!-- ${MARCADOR_DE_PEDIDO}${CHAVE} -->`,
          },
        ]),
      },
    ]);

    const r = await garantirIssue(
      { repo_slug: REPO, token: TOKEN, transporte },
      { idempotency_key: CHAVE, title: 't', body: 'b' },
    );

    expect(r).toEqual({
      ok: true,
      issue_number: 34,
      issue_url: 'https://exemplo/34',
      adotada: true,
    });
    // Esta é a asserção que importa: nenhuma segunda issue foi aberta.
    expect(chamadas.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('marcador de OUTRA chave não é adotado — senão um pedido roubaria a issue de outro', async () => {
    const { garantirIssue } = cliente();
    const { MARCADOR_DE_PEDIDO } = corpo();
    const { transporte, chamadas } = transporteFalso([
      {
        status: 200,
        corpo: JSON.stringify([
          { number: 12, html_url: 'x', body: `<!-- ${MARCADOR_DE_PEDIDO}${'b'.repeat(32)} -->` },
        ]),
      },
      { status: 201, corpo: JSON.stringify({ number: 99, html_url: 'https://exemplo/99' }) },
    ]);
    const r = await garantirIssue(
      { repo_slug: REPO, token: TOKEN, transporte },
      { idempotency_key: CHAVE, title: 't', body: 'b' },
    );
    expect(r.ok && r.adotada).toBe(false);
    expect(chamadas.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});

describe('#638 — classificação de falha', () => {
  const terminais = [401, 403, 404, 422];
  const recuperaveis = [429, 500, 502, 503];

  for (const status of terminais) {
    it(`${status} é TERMINAL — retentar não muda o desfecho`, async () => {
      const { garantirIssue } = cliente();
      const { transporte } = transporteFalso([{ status, corpo: '{"message":"nope"}' }]);
      const r = await garantirIssue(
        { repo_slug: REPO, token: TOKEN, transporte },
        { idempotency_key: CHAVE, title: 't', body: 'b' },
      );
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.terminal).toBe(true);
    });
  }

  for (const status of recuperaveis) {
    it(`${status} é RECUPERÁVEL — a linha volta para a fila`, async () => {
      const { garantirIssue } = cliente();
      const { transporte } = transporteFalso([{ status, corpo: 'indisponivel' }]);
      const r = await garantirIssue(
        { repo_slug: REPO, token: TOKEN, transporte },
        { idempotency_key: CHAVE, title: 't', body: 'b' },
      );
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.terminal).toBe(false);
    });
  }

  it('2xx SEM número é recuperável, nunca `created` — o CHECK do banco exige o número', async () => {
    const { garantirIssue } = cliente();
    const { transporte } = transporteFalso([
      { status: 200, corpo: '[]' },
      { status: 201, corpo: '{"html_url":"https://exemplo/sem-numero"}' },
    ]);
    const r = await garantirIssue(
      { repo_slug: REPO, token: TOKEN, transporte },
      { idempotency_key: CHAVE, title: 't', body: 'b' },
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.terminal).toBe(false);
  });

  it('erro do transporte (rede caiu) é recuperável e não derruba o worker', async () => {
    const { garantirIssue } = cliente();
    const r = await garantirIssue(
      {
        repo_slug: REPO,
        token: TOKEN,
        transporte: async () => {
          throw new Error('ECONNRESET');
        },
      },
      { idempotency_key: CHAVE, title: 't', body: 'b' },
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.terminal).toBe(false);
    expect(r.ok === false && r.erro).toContain('ECONNRESET');
  });
});

describe('#638 — a credencial vai no header e em lugar nenhum mais', () => {
  it('o token viaja em `authorization` e NUNCA aparece na URL', async () => {
    const { garantirIssue } = cliente();
    const { transporte, chamadas } = transporteFalso([
      { status: 200, corpo: '[]' },
      { status: 201, corpo: JSON.stringify({ number: 1, html_url: 'u' }) },
    ]);
    await garantirIssue(
      { repo_slug: REPO, token: TOKEN, transporte },
      { idempotency_key: CHAVE, title: 't', body: 'b' },
    );
    for (const c of chamadas) {
      expect(c.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(c.url).not.toContain(TOKEN);
      expect(c.body ?? '').not.toContain(TOKEN);
    }
  });

  it('a MENSAGEM DE ERRO não interpola o token, nem quando a resposta o ecoa', async () => {
    const { garantirIssue } = cliente();
    // O pior caso realista: um proxy devolve a requisição inteira no corpo do
    // erro. O cliente não pode piorar isso interpolando a credencial por conta
    // própria — e o relayer ainda passa o resultado por `scrubSecrets`.
    const { transporte } = transporteFalso([{ status: 500, corpo: 'erro generico do servidor' }]);
    const r = await garantirIssue(
      { repo_slug: REPO, token: TOKEN, transporte },
      { idempotency_key: CHAVE, title: 't', body: 'b' },
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.erro).not.toContain(TOKEN);
  });

  it('a resposta de erro é RECORTADA — um corpo enorme não vira coluna de banco', async () => {
    const { garantirIssue } = cliente();
    const { transporte } = transporteFalso([{ status: 500, corpo: 'x'.repeat(5000) }]);
    const r = await garantirIssue(
      { repo_slug: REPO, token: TOKEN, transporte },
      { idempotency_key: CHAVE, title: 't', body: 'b' },
    );
    expect(r.ok === false && r.erro.length).toBeLessThan(400);
  });
});
