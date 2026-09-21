/**
 * P08 / G3 (spec §7.6.2) — VARREDURA DETERMINÍSTICA DO PAYLOAD INTEIRO.
 *
 * ─── O buraco que isto fecha ────────────────────────────────────────────────
 *
 * A classificação de risco de um item de conhecimento nunca olhou o conteúdo.
 * A heurística de `scoreKnowledgeRisk` decide por `knowledge_type`, `topic` e
 * `derived_confidence` — sinais sobre a FORMA do item, não sobre o que ele
 * carrega. O texto só chegava ao gate de LLM, e chegava assim:
 *
 *     contextText: input.content_text.slice(0, 200)
 *
 * Duzentos caracteres. Um payload com um CPF no caractere 400 passava sem que
 * nada determinístico o tivesse visto, e o gate — que só é consultado quando a
 * heurística está ambígua e abaixo de `high` — recebia um prefixo que não
 * continha o problema. A spec é literal sobre isso: "prefixo de 200 caracteres
 * não é prova de classificação integral".
 *
 * ─── O que esta varredura é, e o que ela não é ──────────────────────────────
 *
 * Ela é determinística e só ELEVA. Nenhum resultado aqui pode baixar o risco de
 * nada — um scanner que pudesse dizer "não achei, pode liberar" seria uma
 * segunda forma de fail-open, e a ausência de achado não é prova de ausência.
 *
 * Ela também não é um detector de PII completo, e não se apresenta como um. O
 * que ela garante é COBERTURA: todo o payload permitido é percorrido, e o que
 * não puder ser percorrido vira `incomplete` — que o chamador trata como
 * quarentena, nunca como "limpo".
 *
 * ─── Por que CPF e CNPJ usam o validador da casa ────────────────────────────
 *
 * `isValidCPF`/`isValidCNPJ` (`@/lib/brazilian.js`) checam dígito verificador.
 * Uma regex de onze dígitos marcaria todo número de protocolo e todo id
 * numérico longo, e um scanner que grita em tudo é um scanner que alguém
 * desliga. O dígito verificador é o que separa "onze dígitos" de "um CPF".
 */
import { isValidCPF, isValidCNPJ } from '@/lib/brazilian.js';

/** Um achado da varredura. `path` localiza sem repetir o valor encontrado. */
export type PayloadFindingV1 = {
  signal: 'cpf' | 'cnpj' | 'secret_like' | 'card_like' | 'email' | 'phone_br';
  /** Caminho JSON do campo, ex.: `valor.documentos[0]`. Nunca o valor. */
  path: string;
};

export type PayloadScanV1 =
  | { coverage: 'complete'; findings: PayloadFindingV1[] }
  /**
   * A varredura NÃO cobriu tudo. O motivo importa para o operador, e o efeito
   * é o mesmo em todos: o item não pode nascer ativo.
   */
  | {
      coverage: 'incomplete';
      reason: 'too_large' | 'too_deep' | 'cyclic' | 'unsupported_value';
      findings: PayloadFindingV1[];
    };

/**
 * Tetos da varredura.
 *
 * Eles existem para que a varredura não seja um vetor de CPU, e são baixos de
 * propósito: estourar um teto não descarta o item, faz dele um item que um
 * humano olha. O custo de errar para o lado da revisão é uma fila; o de errar
 * para o outro é um dado sensível ativo sem ninguém ter visto.
 */
export const MAX_SCAN_NODES = 5_000;
export const MAX_SCAN_DEPTH = 32;
export const MAX_SCAN_CHARS = 512_000;

/** Sequências de 11 dígitos, com ou sem pontuação de CPF. */
const RE_CPF = /\b\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}\b/g;
/** 14 dígitos, com ou sem pontuação de CNPJ. */
const RE_CNPJ = /\b\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2}\b/g;
/** 13–19 dígitos contíguos: a faixa de um PAN de cartão. */
const RE_CARTAO = /\b\d{13,19}\b/g;
const RE_EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
/** Telefone BR com DDD, com ou sem +55. */
const RE_TELEFONE = /\b(?:\+?55\s?)?\(?\d{2}\)?[\s-]?9?\d{4}[\s-]?\d{4}\b/g;

/**
 * Marcadores de segredo por CONTEXTO, não por formato.
 *
 * Um token de API não tem forma reconhecível — o que o denuncia é a palavra ao
 * lado dele. Procurar `sk-` ou 32 hexadecimais pegaria menos e erraria mais.
 */
const RE_SEGREDO =
  /\b(senha|password|passwd|secret|token|api[_-]?key|chave[_-]?(?:api|privada)|authorization|bearer|private[_-]?key)\b\s*[:=]/gi;

/**
 * UUID em qualquer das formas que a casa usa (com ou sem hífen).
 *
 * Ele é mascarado ANTES de qualquer heurística numérica, e a razão é concreta:
 * um UUID é uma corrida de dígitos hexadecimais separados por hífen, e as
 * heurísticas de telefone e de cartão são heurísticas sobre corridas de
 * dígitos separados por hífen. `11111111-2222-3333-4444-555555555555` casava
 * como telefone brasileiro — foi o que reprovou o CI da primeira versão desta
 * varredura, marcando `subject_id` de um fato comum como dado pessoal.
 *
 * Mascarar é melhor que excluir o campo: o mesmo texto pode ter um id E um
 * telefone, e pular o campo inteiro perderia o segundo.
 */
const RE_UUID = /\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/gi;

/** Substitui UUIDs por um marcador do mesmo tamanho, sem dígitos. */
function mascararIdentificadores(texto: string): string {
  return texto.replace(RE_UUID, (m) => '#'.repeat(m.length));
}

function varrerTexto(textoBruto: string, path: string, out: PayloadFindingV1[]): void {
  const texto = mascararIdentificadores(textoBruto);
  // CPF e CNPJ passam pelo validador de dígito: candidato que não valida não
  // vira achado, e é isso que mantém o sinal legível.
  for (const m of texto.matchAll(RE_CPF)) {
    if (isValidCPF(m[0])) out.push({ signal: 'cpf', path });
  }
  for (const m of texto.matchAll(RE_CNPJ)) {
    if (isValidCNPJ(m[0])) out.push({ signal: 'cnpj', path });
  }
  // O TELEFONE vem antes do cartão, e o que ele casa sai do texto.
  //
  // `+5511987654321` são treze dígitos contíguos, que é também a faixa de um
  // PAN. Sem mascarar, o mesmo telefone saía com DOIS achados — `phone_br` e
  // `card_like` — e o segundo é informação errada no motivo que vai para a
  // auditoria. O risco final mal mudaria; o que mudaria é o operador lendo
  // "cartão" onde havia um telefone.
  let restante = texto;
  if (RE_TELEFONE.test(texto)) {
    out.push({ signal: 'phone_br', path });
    RE_TELEFONE.lastIndex = 0;
    restante = texto.replace(RE_TELEFONE, (m) => '#'.repeat(m.length));
  }
  RE_TELEFONE.lastIndex = 0;

  // Cartão não tem validador na casa; o comprimento é o sinal, e ele erra para
  // o lado de marcar demais — que aqui é o lado certo.
  if (RE_CARTAO.test(restante)) out.push({ signal: 'card_like', path });
  RE_CARTAO.lastIndex = 0;
  if (RE_SEGREDO.test(texto)) out.push({ signal: 'secret_like', path });
  RE_SEGREDO.lastIndex = 0;
  if (RE_EMAIL.test(texto)) out.push({ signal: 'email', path });
  RE_EMAIL.lastIndex = 0;
}

/**
 * Percorre o payload inteiro — todo valor, em toda profundidade.
 *
 * As CHAVES também entram na varredura de segredo: `{"api_key": "..."}` tem o
 * marcador no nome do campo, não no valor, e um scanner que só olhasse valores
 * passaria direto por ele.
 */
export function scanPayload(raiz: unknown): PayloadScanV1 {
  const findings: PayloadFindingV1[] = [];
  const vistos = new WeakSet<object>();
  let nos = 0;
  let chars = 0;
  let incompleto: Extract<PayloadScanV1, { coverage: 'incomplete' }>['reason'] | null = null;

  function visitar(v: unknown, path: string, depth: number): void {
    if (incompleto !== null) return;
    if (depth > MAX_SCAN_DEPTH) {
      incompleto = 'too_deep';
      return;
    }
    if (++nos > MAX_SCAN_NODES) {
      incompleto = 'too_large';
      return;
    }

    if (v === null || v === undefined) return;

    switch (typeof v) {
      case 'string': {
        chars += v.length;
        if (chars > MAX_SCAN_CHARS) {
          incompleto = 'too_large';
          return;
        }
        varrerTexto(v, path, findings);
        return;
      }
      case 'number':
      case 'boolean':
        return;
      case 'bigint':
        // Cabe em texto sem perda e pode carregar um documento inteiro.
        varrerTexto(v.toString(), path, findings);
        return;
      case 'object':
        break;
      default:
        // `function`, `symbol`: não deveriam existir num payload JSON. Não
        // sabemos varrer, então não afirmamos cobertura.
        incompleto = 'unsupported_value';
        return;
    }

    const obj = v as object;
    if (vistos.has(obj)) {
      incompleto = 'cyclic';
      return;
    }
    vistos.add(obj);

    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        if (incompleto !== null) break;
        visitar(obj[i], `${path}[${i}]`, depth + 1);
      }
      return;
    }

    const entries = Object.entries(obj as Record<string, unknown>);
    for (const [k, valor] of entries) {
      if (incompleto !== null) break;

      // Contabiliza o comprimento da chave no orçamento de caracteres.
      chars += k.length;
      if (chars > MAX_SCAN_CHARS) {
        incompleto = 'too_large';
        break;
      }

      // A chave entra na varredura de segredo: o marcador costuma estar no
      // NOME do campo.
      if (RE_SEGREDO.test(`${k}:`)) findings.push({ signal: 'secret_like', path: `${path}.${k}` });
      RE_SEGREDO.lastIndex = 0;
      visitar(valor, path === '' ? k : `${path}.${k}`, depth + 1);
    }
  }

  visitar(raiz, '', 0);

  if (incompleto !== null) return { coverage: 'incomplete', reason: incompleto, findings };
  return { coverage: 'complete', findings };
}

/**
 * O piso de risco que a varredura impõe.
 *
 * "Piso" é a palavra exata: o valor devolvido nunca BAIXA o risco de nada. O
 * chamador toma o mais restritivo entre este piso e o que a heurística já
 * decidiu, e é por isso que `null` — nada achado — não é um voto em "baixo".
 *
 * Cobertura incompleta é `high` porque a alternativa é deixar ativo um payload
 * que ninguém terminou de ler.
 */
export function riskFloorFromScan(scan: PayloadScanV1): 'high' | 'medium' | null {
  if (scan.coverage === 'incomplete') return 'high';
  if (scan.findings.length === 0) return null;
  const grave = scan.findings.some(
    (f) => f.signal === 'secret_like' || f.signal === 'card_like' || f.signal === 'cpf',
  );
  return grave ? 'high' : 'medium';
}
