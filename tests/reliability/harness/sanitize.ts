/**
 * Issue #510 — sanitização de TUDO que sai do harness para o disco ou para o
 * log do CI.
 *
 * ─── O contrato ──────────────────────────────────────────────────────────────
 *
 * A issue lista o que NÃO pode aparecer num artefato: token, secret, telefone
 * ou JID bruto, prompt/resposta reais, payload de usuário, connection string
 * com credencial. Este módulo é o único lugar por onde texto passa antes de ser
 * gravado, e o `ArtifactCollector` não expõe nenhuma rota que o evite.
 *
 * ─── Por que negar por CHAVE, e não só por formato ───────────────────────────
 *
 * Reconhecer telefone e `sk-...` por regex pega o caso conhecido. O que ele não
 * pega é o conteúdo de usuário: uma mensagem em português não tem forma
 * nenhuma. Por isso a redação de objetos é por NOME DE CAMPO e é fail-closed —
 * um campo chamado `content`, `text`, `prompt`, `body` ou `payload` some
 * inteiro, independentemente do que carregue. O preço é perder contexto útil no
 * artefato; a alternativa é vazar mensagem de cliente num log público de CI.
 *
 * O que sobrevive é o que o oracle precisa: IDs, contagens, estados, hashes.
 */

/** Marcador único — o teste procura por ele, e ele não colide com texto real. */
export const REDACTED = '[REDACTED]';

/**
 * Nomes de campo cujo VALOR nunca é gravado. Comparação é
 * case-insensitive e por SUBSTRING, de propósito: `messageContent`,
 * `user_prompt` e `apiKey` caem todos aqui sem precisar de entrada própria.
 */
const CHAVES_PROIBIDAS = [
  'secret',
  'token',
  'password',
  'passwd',
  'apikey',
  'api_key',
  'authorization',
  'credential',
  'content',
  'text',
  'prompt',
  'body',
  'payload',
  'message',
  'telefone',
  'phone',
  'jid',
  'msisdn',
  'connectionstring',
  'connection_string',
  'dsn',
];

/**
 * A exceção EXPLÍCITA à negação por substring, e o motivo de cada entrada.
 *
 * A negação acima é por substring de propósito (`messageContent` cai sem
 * precisar de entrada própria), e o efeito colateral é que ela morde campos
 * que o oracle PRECISA ler e que não carregam conteúdo por construção:
 *
 *  - `payload_hash` / `content_hash` — são digests. O provider compara hash,
 *    justamente para que o ledger nunca guarde mensagem de usuário. Redigi-los
 *    apagaria a prova de "chave igual com payload diferente" (FI-20);
 *  - `idempotency_key` — identificador OPACO que o próprio harness fabrica; é
 *    a chave primária da invariante de idempotência outbound;
 *  - `claim_token` — o token de fencing da #504. É o discriminador de "quem é
 *    o dono do turno"; sem ele no artefato, a prova de stale-write some;
 *  - `fencing_token` / `session_fencing_token` — o MESMO argumento, para a
 *    posse de linha da #513: é o contador monotônico que separa o dono atual do
 *    dono que voltou de uma partição. Além de apagar a prova no artefato, a
 *    redação tem aqui um efeito pior: um probe de `estavelDurante` com esse
 *    campo compararia `[REDACTED]` com `[REDACTED]` e passaria SEMPRE. É
 *    contagem, não segredo;
 *  - `input_tokens` / `output_tokens` / `token_count` — contagens numéricas de
 *    telemetria, sem nenhum texto dentro.
 *
 * A lista é de nomes EXATOS (não substring), curta, e cada linha acima é o
 * argumento para ela existir. Crescer esta lista é enfraquecer a regra —
 * qualquer entrada nova precisa do mesmo tipo de justificativa.
 */
const CHAVES_LIBERADAS = new Set([
  'payload_hash',
  'payloadhash',
  'content_hash',
  'contenthash',
  'idempotency_key',
  'idempotencykey',
  'claim_token',
  'claimtoken',
  'fencing_token',
  'fencingtoken',
  'session_fencing_token',
  'sessionfencingtoken',
  'input_tokens',
  'inputtokens',
  'output_tokens',
  'outputtokens',
  'token_count',
  'tokencount',
]);

export function chaveSensivel(chave: string): boolean {
  const k = chave.toLowerCase().replace(/[-\s]/g, '');
  if (CHAVES_LIBERADAS.has(k)) return false;
  return CHAVES_PROIBIDAS.some((proibida) => k.includes(proibida.replace(/[-_]/g, '')));
}

/**
 * Regras de texto livre. Cada uma existe por um item da lista da issue.
 *
 * A ORDEM importa: connection string primeiro (senão o `//user:pass@` seria
 * mordido pela regra de `key=value`), depois JID, depois telefone, depois
 * segredos por atribuição.
 */
const REGRAS: Array<{ nome: string; re: RegExp; troca: string }> = [
  {
    // `postgres://user:senha@host:5432/db` → mantém o esqueleto, mata a credencial.
    nome: 'connection-string',
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+)(:[^\s@]*)?@/gi,
    troca: `$1${REDACTED}@`,
  },
  {
    // JID do WhatsApp em qualquer das formas que o Baileys produz.
    nome: 'jid',
    re: /\b\d{6,15}(?::\d+)?@(?:s\.whatsapp\.net|c\.us|g\.us|lid|broadcast)\b/gi,
    troca: REDACTED,
  },
  {
    // Telefone E.164 e as variações brasileiras com separadores.
    nome: 'telefone',
    re: /\+?\d{1,3}[\s.-]?\(?\d{2,3}\)?[\s.-]?\d{4,5}[\s.-]?\d{4}\b/g,
    troca: REDACTED,
  },
  {
    // Chaves de provider com prefixo conhecido.
    nome: 'chave-de-provider',
    re: /\b(?:sk|pk|rk)-[a-z0-9]*-?[A-Za-z0-9_-]{8,}/g,
    troca: REDACTED,
  },
  {
    // `Authorization: Bearer <algo>`.
    nome: 'bearer',
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,
    troca: `Bearer ${REDACTED}`,
  },
  {
    // `SECRET=algo`, `"token": "algo"`, `api-key: algo`.
    //
    // O prefixo é `[A-Za-z0-9_-]*` (podendo ser VAZIO), não
    // `[A-Za-z_][A-Za-z0-9_-]*`: com o prefixo obrigatório, a palavra NUA
    // (`token=...`) escapava, porque o primeiro `t` era consumido pelo prefixo
    // e sobrava `oken` para casar com `token`. O self-test pegou isso.
    nome: 'atribuicao-sensivel',
    re: /([A-Za-z0-9_-]*(?:secret|token|password|passwd|api[_-]?key|credential)[A-Za-z0-9_-]*\s*["']?\s*[:=]\s*["']?)([^\s"',;}]+)/gi,
    troca: `$1${REDACTED}`,
  },
];

/**
 * Sanitiza texto livre — stdout/stderr de um filho, mensagem de erro, linha de
 * timeline. Idempotente: rodar duas vezes dá o mesmo resultado.
 */
export function sanitizarTexto(bruto: string): string {
  let saida = bruto;
  for (const regra of REGRAS) saida = saida.replace(regra.re, regra.troca);
  return saida;
}

/**
 * Sanitiza uma estrutura arbitrária, recursivamente.
 *
 * - campo com nome sensível → valor vira `REDACTED`, seja ele o que for;
 * - string → passa pelas regras de texto;
 * - number/boolean/null → intocados (são contagens e estados, o que o oracle lê);
 * - ciclo → `[Circular]`, porque um artefato precisa serializar.
 *
 * `profundidadeMaxima` existe porque o snapshot de uma linha de banco pode
 * arrastar um grafo inteiro por engano; 8 níveis cobrem tudo que o harness
 * grava hoje e transformam um acidente em `[Profundo]` em vez de num heap dump.
 */
export function sanitizarValor(valor: unknown, profundidadeMaxima = 8): unknown {
  return sanitizarInterno(valor, profundidadeMaxima, new WeakSet<object>());
}

function sanitizarInterno(valor: unknown, restante: number, vistos: WeakSet<object>): unknown {
  if (valor === null || valor === undefined) return valor;
  if (typeof valor === 'string') return sanitizarTexto(valor);
  if (typeof valor === 'number' || typeof valor === 'boolean') return valor;
  if (typeof valor === 'bigint') return `${valor.toString()}n`;
  if (typeof valor === 'function' || typeof valor === 'symbol') return REDACTED;

  if (restante <= 0) return '[Profundo]';

  if (valor instanceof Error) {
    return {
      name: valor.name,
      message: sanitizarTexto(valor.message),
      stack: valor.stack ? sanitizarTexto(valor.stack) : undefined,
    };
  }
  if (valor instanceof Date) return valor.toISOString();

  const obj = valor as object;
  if (vistos.has(obj)) return '[Circular]';
  vistos.add(obj);

  if (Array.isArray(valor)) {
    return valor.map((v) => sanitizarInterno(v, restante - 1, vistos));
  }

  const saida: Record<string, unknown> = {};
  for (const [chave, v] of Object.entries(valor as Record<string, unknown>)) {
    saida[chave] = chaveSensivel(chave) ? REDACTED : sanitizarInterno(v, restante - 1, vistos);
  }
  return saida;
}

/**
 * Serializa já sanitizado. É o que o `ArtifactCollector` grava — nunca
 * `JSON.stringify` cru.
 */
export function jsonSanitizado(valor: unknown, espacos = 2): string {
  return JSON.stringify(sanitizarValor(valor), null, espacos);
}
