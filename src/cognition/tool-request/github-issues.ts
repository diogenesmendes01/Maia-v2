/**
 * #638 (fatia C da épica #471) — o ÚNICO ponto do projeto que fala com o
 * GitHub, e o único que toca no token.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROCURAR ANTES DE CRIAR — o que fecha a janela de crash
 * ─────────────────────────────────────────────────────────────────────────────
 * A reserva em `tool_request_issues` (UNIQUE por agregado) já garante que dois
 * cliques do dono produzam UMA issue: o segundo perde a corrida no banco. O que
 * ela NÃO cobre é a janela entre a chamada externa ter sucedido e o resultado
 * ter sido gravado — se o processo morre no meio, a linha continua `pending` e
 * a próxima passada do relayer tentaria de novo.
 *
 * Por isso a criação é precedida de uma BUSCA pelo marcador determinístico que
 * viaja no corpo (`MARCADOR_DE_PEDIDO` + `idempotency_key`). Se a issue já
 * existe, ela é ADOTADA — o relayer grava o número que encontrou e marca
 * `adopted`, para que "criada agora" e "readotada depois de um crash" continuem
 * sendo fatos distinguíveis.
 *
 * A LIMITAÇÃO, dita em vez de escondida: a busca lista as issues com o label da
 * triagem, com paginação LIMITADA (`MAX_PAGINAS`). Um repositório com mais
 * páginas de pedidos abertos do que esse limite pode não encontrar uma issue
 * antiga — e aí a retentativa pós-crash duplicaria. O caminho normal (sem
 * crash) não depende disso em momento nenhum: ele é servido pela UNIQUE do
 * banco, que não tem limite de paginação. O que a busca cobre é só a janela de
 * crash, e cobre-a para as issues recentes, que são exatamente as que estariam
 * nessa janela.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O TOKEN
 * ─────────────────────────────────────────────────────────────────────────────
 * Ele entra por parâmetro, é usado no header `Authorization` e NUNCA aparece em
 * retorno, em erro ou em log deste módulo: as mensagens de erro que ele produz
 * são montadas a partir de status e de corpo de resposta, jamais interpolando a
 * credencial. O chamador ainda passa tudo por `scrubSecrets` antes de persistir
 * — defesa em profundidade, porque um erro de terceiro pode ecoar a requisição.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUE O TRANSPORTE É INJETADO
 * ─────────────────────────────────────────────────────────────────────────────
 * `transporte` tem `fetch` global como default, então PRODUÇÃO usa a rede de
 * verdade sem cerimônia. A injeção existe para que o teste exercite ESTE
 * código — a montagem da URL, os headers, a leitura da resposta, a decisão de
 * adotar — em vez de um dublê que espelharia as mesmas decisões noutro arquivo.
 */
import { LABEL_DO_PEDIDO, LABELS_DA_ISSUE, corpoTemMarcador } from './issue-body.js';

/** A base da API. Constante: não há razão legítima de negócio para variá-la. */
export const GITHUB_API_BASE = 'https://api.github.com';

/** Quantas páginas de 100 issues a busca pelo marcador percorre. Ver o cabeçalho. */
export const MAX_PAGINAS = 5;

/** A resposta que este módulo precisa. Subconjunto deliberado de `Response`. */
export interface RespostaHttp {
  readonly status: number;
  readonly ok: boolean;
  text(): Promise<string>;
}

/** O transporte. `fetch` global satisfaz esta forma. */
export type TransporteHttp = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<RespostaHttp>;

export interface ClienteDeIssues {
  readonly repo_slug: string;
  readonly token: string;
  readonly transporte?: TransporteHttp;
}

export type ResultadoDaIssue =
  | { ok: true; issue_number: number; issue_url: string; adotada: boolean }
  /** Falha RECUPERÁVEL: rede, 5xx, limite de taxa. A linha continua na fila. */
  | { ok: false; terminal: false; erro: string }
  /** Falha TERMINAL: 401/403/404/422 — retentar não muda o desfecho. */
  | { ok: false; terminal: true; erro: string };

function cabecalhos(token: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'user-agent': 'maia-tool-request-triage',
    'x-github-api-version': '2022-11-28',
  };
}

/**
 * Um status é TERMINAL quando repetir a mesma chamada com a mesma credencial
 * dá o mesmo resultado: credencial inválida (401), sem permissão ou issues
 * desligadas no repo (403), repositório inexistente (404), corpo recusado
 * (422). Tudo o mais — rede, 5xx, 429 — é recuperável e volta para a fila.
 *
 * A distinção não é cosmética: marcar `failed` num 500 transitório enterraria
 * um aceite legítimo do dono, e retentar para sempre um 404 gastaria a cota de
 * API contra um destino que não existe.
 */
function eTerminal(status: number): boolean {
  return status === 401 || status === 403 || status === 404 || status === 422;
}

/** Corta o corpo do erro: uma resposta de erro do GitHub pode vir enorme. */
function recorte(texto: string): string {
  const limpo = texto.replace(/\s+/g, ' ').trim();
  return limpo.length > 300 ? `${limpo.slice(0, 300)}…` : limpo;
}

/**
 * Procura, entre as issues abertas por esta triagem, a que carrega ESTA chave.
 *
 * `state=all` de propósito: uma issue já fechada pelo time continua sendo a
 * issue deste pedido, e recriá-la seria pior do que não encontrá-la.
 */
export async function procurarIssuePorMarcador(
  cliente: ClienteDeIssues,
  idempotency_key: string,
): Promise<
  | { ok: true; encontrada: { issue_number: number; issue_url: string } | null }
  | { ok: false; terminal: boolean; erro: string }
> {
  const transporte = cliente.transporte ?? (globalThis.fetch as unknown as TransporteHttp);
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina += 1) {
    const url =
      `${GITHUB_API_BASE}/repos/${cliente.repo_slug}/issues` +
      `?state=all&labels=${encodeURIComponent(LABEL_DO_PEDIDO)}&per_page=100&page=${pagina}`;
    let resposta: RespostaHttp;
    try {
      resposta = await transporte(url, { method: 'GET', headers: cabecalhos(cliente.token) });
    } catch (e) {
      return {
        ok: false,
        terminal: false,
        erro: `busca falhou no transporte: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const corpo = await resposta.text();
    if (!resposta.ok) {
      return {
        ok: false,
        terminal: eTerminal(resposta.status),
        erro: `busca respondeu ${resposta.status}: ${recorte(corpo)}`,
      };
    }
    let lista: unknown;
    try {
      lista = JSON.parse(corpo);
    } catch {
      return { ok: false, terminal: false, erro: 'busca devolveu JSON ilegível' };
    }
    if (!Array.isArray(lista)) {
      return { ok: false, terminal: false, erro: 'busca devolveu formato inesperado' };
    }
    for (const item of lista) {
      const issue = item as { number?: unknown; html_url?: unknown; body?: unknown };
      if (corpoTemMarcador(typeof issue.body === 'string' ? issue.body : null, idempotency_key)) {
        return {
          ok: true,
          encontrada: {
            issue_number: Number(issue.number),
            issue_url: typeof issue.html_url === 'string' ? issue.html_url : '',
          },
        };
      }
    }
    // Página incompleta ⇒ acabou a lista; não há por que pedir a próxima.
    if (lista.length < 100) return { ok: true, encontrada: null };
  }
  return { ok: true, encontrada: null };
}

/**
 * Garante que a issue deste pedido EXISTE — procurando primeiro, criando
 * depois. Devolve `adotada: true` quando a encontrou em vez de criá-la.
 */
export async function garantirIssue(
  cliente: ClienteDeIssues,
  pedido: { idempotency_key: string; title: string; body: string },
): Promise<ResultadoDaIssue> {
  const busca = await procurarIssuePorMarcador(cliente, pedido.idempotency_key);
  if (!busca.ok) return { ok: false, terminal: busca.terminal, erro: busca.erro };
  if (busca.encontrada) {
    return {
      ok: true,
      issue_number: busca.encontrada.issue_number,
      issue_url: busca.encontrada.issue_url,
      adotada: true,
    };
  }

  const transporte = cliente.transporte ?? (globalThis.fetch as unknown as TransporteHttp);
  const url = `${GITHUB_API_BASE}/repos/${cliente.repo_slug}/issues`;
  let resposta: RespostaHttp;
  try {
    resposta = await transporte(url, {
      method: 'POST',
      headers: cabecalhos(cliente.token),
      body: JSON.stringify({
        title: pedido.title,
        body: pedido.body,
        labels: [...LABELS_DA_ISSUE],
      }),
    });
  } catch (e) {
    return {
      ok: false,
      terminal: false,
      erro: `criação falhou no transporte: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const corpo = await resposta.text();
  if (!resposta.ok) {
    return {
      ok: false,
      terminal: eTerminal(resposta.status),
      erro: `criação respondeu ${resposta.status}: ${recorte(corpo)}`,
    };
  }
  let criada: unknown;
  try {
    criada = JSON.parse(corpo);
  } catch {
    return { ok: false, terminal: false, erro: 'criação devolveu JSON ilegível' };
  }
  const issue = criada as { number?: unknown; html_url?: unknown };
  const numero = Number(issue.number);
  if (!Number.isInteger(numero) || numero <= 0) {
    // 2xx sem número é resposta que não podemos registrar: `status='created'`
    // exige `issue_number` (CHECK da migração 132). Recuperável — a busca da
    // próxima passada acha a issue pelo marcador e a adota.
    return { ok: false, terminal: false, erro: 'criação respondeu 2xx sem número de issue' };
  }
  return {
    ok: true,
    issue_number: numero,
    issue_url: typeof issue.html_url === 'string' ? issue.html_url : '',
    adotada: false,
  };
}
