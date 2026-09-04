/**
 * Guarda das DECISÕES ABERTAS do piloto de cobrança (#469, spec v2 + ADR 0006).
 *
 * ## O defeito que esta suíte trava
 *
 * A spec v2 do work loop de cobrança e o ADR 0006 registram doze perguntas que
 * NÃO são decidíveis por quem escreve a spec — elas pertencem ao dono do
 * produto, ao dono da segurança, ao jurídico e ao DPO. O modo de falha não é
 * alguém decidir e assinar: é a decisão **vazar para dentro do documento sem
 * assinatura**, em uma de três formas, em ordem crescente de dificuldade para
 * achar a olho:
 *
 * 1. **Regra vigente** — o documento afirma o comportamento no indicativo
 *    ("o agente NÃO responde ao devedor em nenhum horário") quando ninguém
 *    decidiu isso.
 * 2. **Critério de aceite** — a decisão aberta vira item de checklist, DoD ou
 *    pré-requisito de fatia ("Resposta do devedor ⇒ zero envio autônomo").
 * 3. **Valor concreto disfarçado de exemplo** — `"holdout_fraction": 0.2` num
 *    bloco de código, `"inicio": "09:00"` num payload de amostra,
 *    `"offset_days": 7` numa tabela. Um número que aparece três vezes como
 *    "exemplo" já virou default de fato, e ninguém mais lembra que ninguém o
 *    escolheu.
 *
 * A terceira é a traiçoeira: ela mora em blocos de código, SQL, tabelas e
 * diagramas, que é justamente onde a leitura humana desliga o ceticismo. Por
 * isso este guard varre a linha crua do arquivo, sem pular cerca de código.
 *
 * ## O contrato
 *
 * Toda decisão ainda aberta aparece **apenas como opções**, num bloco com
 * marcador único e mecanicamente detectável:
 *
 * ```
 * > **DECISÃO ABERTA — DA-01 · rótulo** — Qn do ADR 0006
 * > ...as opções, e o que muda conforme a escolha...
 * > - `decided_by:`
 * > - `decided_at:`
 * ```
 *
 * Os dois campos ficam **explicitamente presentes e vazios**. O campo vazio é o
 * que torna a ausência de decisão visível em vez de esquecida.
 *
 * ## Por que a lista é escrita à mão, item por item
 *
 * Um guard genérico de "linguagem que soa decidida" seria vago e daria falso
 * positivo em toda frase do documento. O que existe aqui é o oposto: uma lista
 * EXPLÍCITA, um item por decisão ainda aberta, com os padrões literais que
 * caracterizam o valor daquele item. É verboso de propósito — **a lista é o
 * contrato**, e mexer nela é um ato visível em code review.
 *
 * ## Como promover um valor quando a decisão for tomada
 *
 * 1. preencher `decided_by:` e `decided_at:` no bloco;
 * 2. escrever o valor decidido no documento, como regra;
 * 3. remover o bloco `DECISÃO ABERTA` correspondente; e
 * 4. remover o item desta lista, **no mesmo PR**.
 *
 * Os quatro passos são obrigatórios juntos: por isso um bloco com os campos
 * preenchidos reprova (passo 1 sem os passos 2–4), e um valor fora de bloco
 * reprova (passo 2 sem o passo 1). Não há caminho que promova um valor sem que
 * um humano edite ESTE arquivo — e essa edição é a evidência.
 *
 * ## O alcance: uma lista de FORMAS CONHECIDAS, não uma cobertura de prosa
 *
 * Leia esta seção antes de confiar no guard, e antes de editar a lista.
 *
 * **Nenhum item cobre prosa arbitrária. Nenhum.** Um valor pode voltar como
 * campo (`"holdout_fraction": 0.2`) ou como prosa ("cerca de 20% dos devedores
 * como grupo de controle"). A forma de campo é fechada. A de prosa não é
 * fechável por regex: o que existe, por item, é uma **lista enumerada de formas
 * conhecidas** — as que a draft de fato usou, mais as que revisões encontraram.
 * Essa lista é o contrato, e ela é finita por construção.
 *
 * DA-01 e DA-02 têm a lista mais longa (percentual com `%` ou "por cento",
 * decimal, fração em palavras, vizinhança de holdout/controle/tratamento; e a
 * unidade no modo assertivo ou por exclusão). Isso as torna mais difíceis de
 * reincidir — **não** cobertas.
 *
 * ### Formas conhecidamente NÃO cobertas
 *
 * Estas atravessam hoje. Estão aqui porque quem edita a lista precisa saber que
 * a classe existe, e qual é:
 *
 * | frase | por que atravessa |
 * |---|---|
 * | `A alocação entre braços acontece no nível do devedor.` | diz a unidade sem nenhum verbo assertivo mapeado — "no nível do" no lugar de "por" |
 * | `Reservamos uma em cada cinco carteiras para comparação.` | fração em razão ("uma em cada cinco"), forma não prevista; e "comparação" está fora do vocabulário de vizinhança |
 * | `O braço sem contato representa 20 por cento do total.` | "braço sem contato" é sinônimo de holdout fora do vocabulário (holdout/controle/tratamento) |
 *
 * Contraste com `Um quinto dos inadimplentes permanece sem tratamento durante o
 * piloto.`, que **reprova** — a mesma ideia, mas com "tratamento" na vizinhança
 * e a fração numa forma prevista. A diferença entre as duas é vocabulário, não
 * substância: é exatamente a fronteira do que um guard textual alcança.
 *
 * Apertar mais fecha algumas formas e deixa outras, com retorno decrescente e
 * risco crescente de falso positivo. A escolha registrada é parar aqui e
 * **declarar**, em vez de perseguir cobertura que não existe.
 *
 * ### Então onde mora a defesa de verdade
 *
 * Não no regex. A defesa é o procedimento: a lista é curta e legível, promover
 * um valor exige os **quatro passos no mesmo PR**, e o quarto passo é editar
 * ESTE arquivo — o que põe a promoção na frente de um revisor humano. O guard é
 * um **ratchet contra reincidência das formas que a draft usou**, não uma prova
 * de impossibilidade. Quem quiser burlar consegue; o ponto é que não consegue
 * por descuido, que é como as dez decisões viraram default da primeira vez.
 *
 * A distinção que sustenta a DA-02 é de **modo verbal, não de vocabulário**:
 * "o sorteio por item contamina" é o diagnóstico e precisa continuar dizível;
 * "o sorteio é por item" é a regra e reprova. Por isso o imperfeito ("a draft
 * sorteava por item") fica de fora de propósito.
 *
 * ## ARMADILHA DA LINGUAGEM: `\b` do JavaScript é ASCII-only
 *
 * Isto não é uma nota sobre a DA-02. Vale para **qualquer guard textual em
 * português neste repositório**, e é a razão de esta seção estar em caixa alta.
 *
 *     /\bé\b/u.test('holdout é por devedor')        // false
 *     /\bserá\b/u.test('randomização será por doc')  // false
 *
 * `é`, `á`, `ã`, `ç`, `õ` não são caracteres de palavra para o `\b`, nem com a
 * flag `u`. Um padrão como `\b(?:[ée]|ser[áa])\b` **nunca dispara** — e passa
 * em code review parecendo cobertura, porque a lista de alternativas está lá e
 * ninguém executa a regex mentalmente. Duas versões deste próprio arquivo
 * foram entregues com padrões mortos por isso.
 *
 * Onde a borda cai sobre caractere acentuado, use lookaround Unicode:
 * `(?<![\p{L}])…(?![\p{L}])`. Onde cai sobre ASCII (`\bunidade\b`), `\b` está
 * correto e é mais legível — não troque por ritual.
 *
 * ## O que esta suíte NÃO afirma
 *
 * Que a decisão está certa, que o dono correto assinou, ou que o valor promovido
 * é o que ele disse. Nada disso é verificável a partir do texto. E, depois da
 * seção de alcance acima: **não afirma que um valor não pode voltar em prosa.**
 * O que ela afirma é que nenhum valor volta nas formas enumeradas nesta lista
 * sem que um humano edite este arquivo.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RAIZ = resolve(__dirname, '..', '..', '..');

const SPEC = 'docs/superpowers/specs/2026-07-31-collections-work-loop-design.md';
const ADR = 'docs/architecture/decisions/0006-cobranca-piloto-perguntas-em-aberto.md';

const DOCUMENTOS = [SPEC, ADR] as const;

// ───────────────────────────────────────────────────────────────────────────
// Leitura e parsing dos blocos
// ───────────────────────────────────────────────────────────────────────────

type Linha = { readonly numero: number; readonly texto: string; readonly emBloco: string | null };
type Bloco = {
  readonly id: string;
  readonly documento: string;
  readonly linhaInicial: number;
  readonly texto: string;
};

const ABERTURA_DE_BLOCO = /^>\s*\*\*DECIS[ÃA]O ABERTA\s*[—–-]\s*(DA-\d{2})\b/u;

function lerDocumento(caminhoRelativo: string): { linhas: Linha[]; blocos: Bloco[] } {
  const bruto = readFileSync(resolve(RAIZ, caminhoRelativo), 'utf8');
  const linhas: Linha[] = [];
  const blocos: Bloco[] = [];

  let blocoAtual: string | null = null;
  let inicioAtual = 0;
  let acumulado: string[] = [];

  const fecharBloco = (): void => {
    if (blocoAtual !== null) {
      blocos.push({
        id: blocoAtual,
        documento: caminhoRelativo,
        linhaInicial: inicioAtual,
        texto: acumulado.join('\n'),
      });
    }
    blocoAtual = null;
    acumulado = [];
  };

  bruto.split('\n').forEach((texto, indice) => {
    const numero = indice + 1;
    const abertura = ABERTURA_DE_BLOCO.exec(texto);

    if (abertura) {
      fecharBloco();
      blocoAtual = abertura[1] ?? null;
      inicioAtual = numero;
    } else if (blocoAtual !== null && !texto.startsWith('>')) {
      // Uma linha que não é citação encerra o blockquote — é a mesma regra do
      // renderizador de markdown, então o teste enxerga o bloco que o leitor vê.
      fecharBloco();
    }

    if (blocoAtual !== null) acumulado.push(texto);
    linhas.push({ numero, texto, emBloco: blocoAtual });
  });

  fecharBloco();
  return { linhas, blocos };
}

const CONTEUDO = new Map(DOCUMENTOS.map((caminho) => [caminho, lerDocumento(caminho)]));

// ───────────────────────────────────────────────────────────────────────────
// A LISTA. Um item por decisão ainda aberta. Mexer aqui é mexer no contrato.
// ───────────────────────────────────────────────────────────────────────────

type Padrao = { readonly re: RegExp; readonly porque: string };
type ItemAberto = {
  readonly da: string;
  readonly rotulo: string;
  readonly pergunta: string;
  readonly padroes: readonly Padrao[];
};

const ITENS_ABERTOS: readonly ItemAberto[] = [
  {
    da: 'DA-01',
    rotulo: 'fração do holdout (o "20% de holdout")',
    pergunta: 'Q6(a)',
    // A fração não precisa da palavra "holdout" para ser a fração: "20% dos
    // devedores como grupo de controle" é o mesmo valor com outro vocabulário.
    // Por isso a vizinhança inclui controle/tratamento, e as formas cobertas
    // são percentual, decimal e fração em palavras — nos dois sentidos de
    // leitura, porque o número tanto precede quanto segue o substantivo.
    padroes: [
      { re: /holdout_fraction\s*"?\s*[:=]\s*"?\d/u, porque: 'campo do envelope com valor numérico' },
      {
        re: /\b\d{1,3}(?:[.,]\d+)?\s*(?:%|por cento)[^.\n]{0,70}\b(?:holdout|controle|tratamento)\b/iu,
        porque: 'percentual na vizinhança de holdout/controle/tratamento',
      },
      {
        re: /\b(?:holdout|grupo de controle|bra[çc]o de controle|grupo de tratamento)\b[^.\n]{0,70}\d{1,3}(?:[.,]\d+)?\s*(?:%|por cento)/iu,
        porque: 'percentual na vizinhança de holdout/controle/tratamento',
      },
      {
        // A quantidade tem de PARECER quantidade. Um `\d` solto aqui lia
        // "§5.2" como número e reprovava a própria tabela de índice do ADR —
        // o mesmo tropeço que a DA-06 já tinha tido.
        re: /\bfra[çc][ãa]o\b[^.\n]{0,30}\b(?:do holdout|de holdout|de controle|do grupo de controle)\b[^.\n]{0,30}(?:\d{1,3}\s*%|0[.,]\d+|\d{1,3}\s+por cento|\d{1,2}\s+em\s+\d{1,2})/iu,
        porque: 'fração do holdout com quantidade concreta',
      },
      {
        re: /\b0[.,]\d+\b[^.\n]{0,50}\b(?:holdout|grupo de controle)\b/iu,
        porque: 'fração decimal na vizinhança de holdout/controle',
      },
      {
        re: /\b(?:holdout|grupo de controle)\b[^.\n]{0,50}\b0[.,]\d+\b/iu,
        porque: 'fração decimal na vizinhança de holdout/controle',
      },
      {
        re: /\b(?:d[ée]cimo|quinto|quarto|ter[çc]o|metade)\b[^.\n]{0,50}\b(?:holdout|controle|tratamento)\b/iu,
        porque: 'fração em palavras na vizinhança de holdout/controle',
      },
      {
        re: /\b(?:holdout|grupo de controle)\b[^.\n]{0,50}\b(?:d[ée]cimo|quinto|quarto|ter[çc]o|metade)\b/iu,
        porque: 'fração em palavras na vizinhança de holdout/controle',
      },
    ],
  },
  {
    da: 'DA-02',
    rotulo: 'unidade experimental do holdout',
    pergunta: 'Q6(b)',
    padroes: [
      { re: /holdout_unit\s*"?\s*[:=]\s*"?[A-Za-z_]/u, porque: 'campo do envelope com unidade concreta' },
      {
        // Bordas Unicode, não `\b`: ver o comentário em VERBOS_ASSERTIVOS abaixo.
        re: /\bunidade experimental\b[^.\n]{0,30}(?<![\p{L}])(?:é|precisa ser|deve ser|será|passa a ser)(?![\p{L}])/iu,
        porque: 'unidade afirmada no indicativo',
      },
      { re: /\bunidade experimental por devedor\b/iu, porque: 'unidade afirmada como mitigação vigente' },
      { re: /\bunidade (?:de sorteio|do holdout)\s+[ée]\b/iu, porque: 'unidade afirmada no indicativo' },
      {
        re: /\bitens de um mesmo devedor caem no mesmo bra[çc]o\b/iu,
        porque: 'critério de aceite que fixa a unidade',
      },
      { re: /\bsorte(?:ia|ado|ada)\s+por devedor\b/iu, porque: 'unidade afirmada no indicativo' },
      // O que denuncia a unidade não é a palavra "sorteio" perto de "por
      // item" — essa combinação é o DIAGNÓSTICO da draft, e ele precisa
      // continuar dizível ("a randomização por item contamina", "o sorteio por
      // item"). O que denuncia é a unidade dita no modo ASSERTIVO: um verbo de
      // ligação, de futuro ou de dever entre o sorteio e a unidade, ou o
      // enquadramento exclusivo ("nunca por item", "em vez de por devedor").
      // A distinção é de modo verbal, não de vocabulário, e é por isso que
      // ela sobrevive a reformulação.
      {
        // ATENÇÃO à borda: `\b` do JS é ASCII-only, então /\bé\b/ NUNCA casa —
        // "é" não é caractere de palavra para ele. Um verbo acentuado entre
        // `\b` é um padrão morto, e foi exatamente isso que deixou passar
        // "O sorteio do holdout é por devedor." e "A randomização será por
        // documento.". As bordas aqui são lookarounds Unicode.
        re: /\b(?:sorteio|sorte(?:ia|iam|ado|ada|ados|adas)|randomiza(?:ção|cao|do|da)|aleatoriza(?:ção|cao|do|da)|holdout|grupo de controle|bra[çc]o)(?![\p{L}])[^.\n]{0,60}(?<![\p{L}])(?:é|são|fica|ficam|sai|saem|roda|opera|vai|vão|será|serão|passa a ser|passam a ser|deve ser|devem ser|precisa ser|precisam ser|acontece|se dá|agrupa|agrupado|agrupada|clusteriza|clusterizado)(?![\p{L}])[^.\n]{0,24}\bpor\s+(?:devedor|item|pessoa|documento|CPF|CNPJ|contraparte|grupo econ[ôo]mico)\b/iu,
        porque: 'unidade do sorteio afirmada no modo assertivo',
      },
      {
        re: /\b(?:nunca|sempre|jamais|e n[ãa]o|em vez de|ao inv[ée]s de)\s+por\s+(?:devedor|item|pessoa|documento|CPF|CNPJ|grupo econ[ôo]mico)\b/iu,
        porque: 'unidade afirmada por exclusão ("nunca por item")',
      },
      {
        re: /\bunidade\b[^.\n]{0,40}(?<![\p{L}])(?:é|será|passa a ser|vai ser|deve ser|precisa ser)\s+(?:o\s+|a\s+)?(?:devedor|item|documento|CPF|CNPJ|pessoa|grupo econ[ôo]mico)\b/iu,
        porque: 'unidade afirmada no indicativo',
      },
      {
        re: /\bholdout_unit\b[^.\n]{0,20}(?<![\p{L}])(?:é|será|vai ser)\s+`?(?:devedor|item|documento|CPF|CNPJ)/iu,
        porque: 'unidade afirmada no indicativo',
      },
    ],
  },
  {
    da: 'DA-03',
    rotulo: 'cadência (quais passos, com que intervalo)',
    pergunta: 'Q8',
    padroes: [
      { re: /offset_days\s*"?\s*[:=]\s*"?-?\d/u, porque: 'intervalo concreto no envelope' },
      { re: /\bcad[êe]ncia\b[^.\n]{0,40}\d+\s*dias?\b/iu, porque: 'cadência concreta em prosa' },
      { re: /\ba cada\s+\d+\s*dias?\b/iu, porque: 'cadência concreta em prosa' },
      { re: /\bintervalo de\s+\d+\s*dias?\b/iu, porque: 'cadência concreta em prosa' },
    ],
  },
  {
    da: 'DA-04',
    rotulo: 'janela de contato (horário, dias, feriados, fuso)',
    pergunta: 'Q5 / Q8',
    padroes: [
      { re: /"(?:inicio|início|fim)"\s*:\s*"?\d{1,2}:\d{2}/u, porque: 'horário concreto no envelope' },
      { re: /"tz"\s*:\s*"[A-Za-z]+\/[A-Za-z_]+"/u, porque: 'fuso concreto no envelope' },
      { re: /"dias"\s*:\s*\[/u, porque: 'lista concreta de dias no envelope' },
      { re: /"respeita_feriados"\s*:\s*(?:true|false)/u, porque: 'política de feriado concreta no envelope' },
      { re: /\bAm[ée]rica\/Sao_Paulo\b/u, porque: 'fuso concreto' },
      { re: /\b\d{1,2}:\d{2}\s*(?:[àa]s|at[ée]|[-–])\s*\d{1,2}:\d{2}\b/u, porque: 'faixa de horário concreta' },
      {
        re: /\bjanela de contato\b[^.\n]{0,40}\b\d{1,2}\s*h(?:oras)?\b/iu,
        porque: 'janela de contato concreta em prosa',
      },
    ],
  },
  {
    da: 'DA-05',
    rotulo: 'máximo de passos por item',
    pergunta: 'Q8',
    padroes: [
      { re: /max_steps_per_item\s*"?\s*[:=]\s*"?\d/u, porque: 'teto concreto no envelope' },
      {
        re: /\bm[áa]ximo\s+(?:de\s+)?\d+\s*(?:passos|contatos|mensagens|envios)\b/iu,
        porque: 'teto concreto em prosa',
      },
      { re: /\b\d+\s*passos por item\b/iu, porque: 'teto concreto em prosa' },
    ],
  },
  {
    da: 'DA-06',
    rotulo: 'janela de atribuição da métrica',
    pergunta: 'Q7 / §9.1',
    padroes: [
      { re: /attribution_window_days\s*"?\s*[:=]\s*"?\d/u, porque: 'janela concreta no envelope' },
      { re: /\bjanela de atribui[çc][ãa]o\b[^.\n]{0,40}\b\d+\s*dias?\b/iu, porque: 'janela concreta em prosa' },
      { re: /\batribui[çc][ãa]o\b[^.\n]{0,30}\d+\s*dias?\b/iu, porque: 'janela concreta em prosa' },
    ],
  },
  {
    da: 'DA-07',
    rotulo: 'superfície em que o humano atende a fila de exceções',
    pergunta: 'Q11',
    padroes: [
      { re: /\bfila de exce[çc][õo]es no console\b/iu, porque: 'superfície afirmada no indicativo' },
      {
        re: /\bfila\s+(?:de exce[çc][õo]es\s+)?(?:do piloto\s+)?(?:[ée]|fica|vive|mora|est[áa])\s+(?:a\s+)?(?:no|do)\s+console\b/iu,
        porque: 'superfície afirmada no indicativo',
      },
      {
        re: /\b(?:p[õo]e|coloca|deixa)\s+a\s+fila\s+(?:de exce[çc][õo]es\s+)?no console\b/iu,
        porque: 'superfície afirmada no indicativo',
      },
      { re: /\bexce[çc][õo]es no console\b/iu, porque: 'superfície afirmada no indicativo' },
      { re: /\bO humano resolve no console\b/iu, porque: 'superfície afirmada no indicativo' },
    ],
  },
  {
    da: 'DA-08',
    rotulo: 'snapshot datado por ciclo como fonte da métrica',
    pergunta: 'Q1 / Q7',
    padroes: [
      { re: /\bsnapshot\b[^.\n]{0,40}\b(?:por|a cada)\s+ciclo\b/iu, porque: 'mecanismo afirmado como decidido' },
      { re: /\bsnapshot datado\b/iu, porque: 'mecanismo afirmado como decidido' },
      { re: /\bsnapshot imut[áa]vel\b/iu, porque: 'mecanismo afirmado como decidido' },
    ],
  },
  {
    da: 'DA-09',
    rotulo: 'resposta ao inbound do devedor (inclusive fora da janela)',
    pergunta: 'Q10',
    padroes: [
      { re: /\bo agente\b[^.\n]{0,40}\bn[ãa]o responde\b/iu, porque: 'regra vigente sobre decisão aberta' },
      { re: /\bnunca responde ao devedor\b/iu, porque: 'regra vigente sobre decisão aberta' },
      { re: /\bnenhuma resposta aut[ôo]noma\b/iu, porque: 'regra vigente sobre decisão aberta' },
      { re: /\bn[ãa]o existe resposta aut[ôo]noma\b/iu, porque: 'regra vigente sobre decisão aberta' },
      { re: /\bsem resposta aut[ôo]noma\b/iu, porque: 'regra vigente sobre decisão aberta' },
      { re: /\bzero\b[^.\n]{0,24}\benvio aut[ôo]nomo\b/iu, porque: 'critério de aceite sobre decisão aberta' },
      { re: /§\s*8\.2\s+prevale/iu, porque: 'resolução afirmada da Q10' },
      { re: /\bprevalece sobre a Q10\b/iu, porque: 'resolução afirmada da Q10' },
      { re: /\bregra vigente\b/iu, porque: 'o texto declara regra vigente para uma decisão aberta' },
      { re: /\bInbound do devedor\b[^.\n]{0,24}\bsai do loop\b/iu, porque: 'regra vigente sobre decisão aberta' },
      { re: /\bem nenhum hor[áa]rio\b/iu, porque: 'regra vigente sobre decisão aberta' },
      { re: /\bem qualquer hor[áa]rio\b/iu, porque: 'critério de aceite sobre decisão aberta' },
    ],
  },
  {
    da: 'DA-10',
    rotulo: 'classe de aprovação e TTL do mandato',
    pergunta: 'Q9',
    padroes: [
      { re: /approval_class\s*=\s*'?two_distinct_owners/iu, porque: 'classe concreta afirmada como decidida' },
      { re: /\bDois owners distintos aprovam\b/iu, porque: 'classe concreta afirmada como decidida' },
      {
        re: /\bclasse de aprova[çc][ãa]o\b[^.\n]{0,24}[ée]\s+`?two_distinct_owners/iu,
        porque: 'classe concreta afirmada como decidida',
      },
    ],
  },
  {
    da: 'DA-11',
    rotulo: 'composição do "R$ líquido" (o que entra na conta, e o nome do número)',
    pergunta: 'Q7',
    // A composição não precisa de número para virar default: "o líquido
    // desconta o custo de LLM rateado" fixa a conta inteira sem um dígito.
    // As formas aqui são as que a revisão anterior de fato usou (a fórmula
    // "bruto menos custo de mensagem" em prosa) mais as assertivas óbvias.
    padroes: [
      {
        re: /(?<![\p{L}])l[íi]quido(?![\p{L}])["”]?\s*=/iu,
        porque: 'fórmula da composição afirmada como decidida',
      },
      { re: /\brecuperado bruto menos\b/iu, porque: 'composição concreta afirmada fora de bloco' },
      {
        re: /\b(?:entra|entram|n[ãa]o entra|n[ãa]o entram)\s+n[oa]\s+(?:conta do\s+)?["“]?l[íi]quido\b/iu,
        porque: 'componente afirmado dentro/fora da conta do líquido',
      },
      {
        re: /(?<![\p{L}])l[íi]quido(?![\p{L}])["”]?\s+desconta\s+/iu,
        porque: 'composição concreta no indicativo',
      },
      {
        re: /(?<![\p{L}])l[íi]quido(?![\p{L}])[^.\n]{0,60}(?<!\bque )\b(?:considera|inclui|abate|subtrai)\b[^.\n]{0,40}\bcusto/iu,
        porque:
          'composição concreta com outro verbo ("considera o custo…") — forma achada em sonda de revisão; "que subtrai" (oração relativa em constatação de fato) fica de fora de propósito',
      },
      {
        re: /\brateio\s+(?:por|proporcional ao?)\s+(?:slot|contato|envio|objetivo|item|mensagem|r[ée]gua)\b/iu,
        porque: 'critério de rateio afirmado como decidido',
      },
      {
        re: /\bconvertid[oa]s?\s+(?:a|para)\s+BRL\s+(?:pela|pelo|por|na|com)\b/iu,
        porque: 'política cambial afirmada como decidida',
      },
    ],
  },
  {
    da: 'DA-12',
    rotulo: 'limiar do breaker automático (nível 0 da §11.3)',
    pergunta: 'Q8 / Q5',
    // O mecanismo (pausa + sem re-arme) é desenho e continua dizível; o que
    // reprova é o GATILHO concreto — em campo, em número ou em palavras
    // ("a primeira reclamação pausa" é limiar 1 sem nenhum dígito).
    padroes: [
      { re: /breaker_threshold\s*"?\s*[:=]\s*"?\d/u, porque: 'limiar concreto em campo' },
      {
        re: /\b(?:limiar|threshold)\b[^.\n]{0,40}\b\d+\s*(?:reclama[çc][õo]|bloqueio|sinai|ocorr[êe]ncia)/iu,
        porque: 'limiar concreto em prosa',
      },
      {
        re: /\b\d+\s*(?:reclama[çc][õo]es?|bloqueios?|opt-outs?|sinais)\b[^.\n]{0,60}\b(?:pausa|abre|dispara|breaker|disjuntor)\b/iu,
        porque: 'limiar concreto em prosa',
      },
      {
        re: /\b(?:breaker|disjuntor)\b[^.\n]{0,60}\b(?:a partir de|acima de|com mais de|com)\s+\d+\s*falhas?/iu,
        porque: 'limiar concreto em prosa ("abre com N falhas") — forma achada em sonda de revisão',
      },
      {
        re: /\b(?:breaker|disjuntor)\b[^.\n]{0,60}\b(?:a partir de|acima de|com mais de)\s+\d/iu,
        porque: 'limiar concreto em prosa',
      },
      {
        re: /\b(?:primeir[ao]|segund[ao]|terceir[ao])\s+(?:reclama[çc][ãa]o|bloqueio|sinal|ocorr[êe]ncia|opt-out)\b[^.\n]{0,40}\b(?:pausa|abre|dispara|derruba|para)(?![\p{L}])/iu,
        porque: 'limiar em palavras ("a primeira reclamação pausa") afirmado como regra',
      },
      {
        re: /\blimiar do breaker\b[^.\n]{0,30}(?<![\p{L}])(?:é|será|fica em|passa a ser)(?![\p{L}])[^.\n]{0,12}\d/iu,
        porque: 'limiar afirmado no indicativo',
      },
    ],
  },
];

// Os artifícios retóricos que transformaram decisões abertas em defaults de fato
// na draft. São strings literais, não julgamento de estilo: "a spec propõe X"
// põe X no documento com uma preferência marcada por tom — exatamente o que a
// regra do dono proíbe ("sem uma delas marcada como preferida por diagramação,
// ordem ou tom").
const RETORICA_PROIBIDA: readonly Padrao[] = [
  {
    re: /\bA spec \*{0,2}prop[õo]e\*{0,2}\b/u,
    porque: 'a spec não propõe resposta para decisão aberta — ela lista opções',
  },
  { re: /^\s*>?\s*\*\*Proposta[.:]?\*\*/u, porque: 'bloco "Proposta" marca uma opção como preferida' },
  { re: /\bRESOLVIDA COMO PROPOSTA\b/u, porque: 'estado "proposta" é decisão sem assinatura' },
];

// ───────────────────────────────────────────────────────────────────────────

function foraDeBloco(documento: string): Linha[] {
  const conteudo = CONTEUDO.get(documento);
  if (!conteudo) throw new Error(`documento não lido: ${documento}`);
  return conteudo.linhas.filter((l) => l.emBloco === null);
}

function todosOsBlocos(): Bloco[] {
  return DOCUMENTOS.flatMap((d) => CONTEUDO.get(d)?.blocos ?? []);
}

describe('decisões abertas do piloto de cobrança (#469)', () => {
  describe('nenhum valor de decisão aberta vive fora de um bloco DECISÃO ABERTA', () => {
    for (const item of ITENS_ABERTOS) {
      it(`${item.da} — ${item.rotulo} (${item.pergunta})`, () => {
        const achados: string[] = [];
        for (const documento of DOCUMENTOS) {
          for (const linha of foraDeBloco(documento)) {
            for (const padrao of item.padroes) {
              const m = padrao.re.exec(linha.texto);
              if (m) {
                achados.push(
                  `${documento}:${linha.numero} — ${padrao.porque}\n` +
                    `      trecho: ${JSON.stringify(m[0])}\n` +
                    `      padrão: ${String(padrao.re)}`,
                );
              }
            }
          }
        }

        expect(
          achados,
          `\n${item.da} (${item.rotulo}) continua sendo DECISÃO ABERTA (${item.pergunta} do ADR 0006),\n` +
            `mas aparece como valor ou regra FORA de um bloco "> **DECISÃO ABERTA — ${item.da} …**":\n\n` +
            achados.map((a) => `  · ${a}`).join('\n') +
            `\n\nOu o trecho vira opção dentro do bloco ${item.da}, ou — se a decisão FOI tomada —\n` +
            `preencha decided_by/decided_at, promova o valor, remova o bloco e remova ${item.da}\n` +
            `da lista ITENS_ABERTOS deste arquivo, tudo no mesmo PR.\n`,
        ).toEqual([]);
      });
    }
  });

  describe('cada decisão aberta tem bloco, e o bloco tem os dois campos vazios', () => {
    it('todo item da lista tem pelo menos um bloco DECISÃO ABERTA', () => {
      const presentes = new Set(todosOsBlocos().map((b) => b.id));
      const faltando = ITENS_ABERTOS.filter((i) => !presentes.has(i.da)).map((i) => `${i.da} (${i.rotulo})`);
      expect(
        faltando,
        '\nSumiram blocos "> **DECISÃO ABERTA — …**" de itens que continuam abertos.\n' +
          'Apagar o bloco não fecha a decisão — só a torna invisível de novo.\n' +
          faltando.map((f) => `  · ${f}`).join('\n') +
          '\n',
      ).toEqual([]);
    });

    it('todo bloco declara decided_by e decided_at, e ambos estão vazios', () => {
      const problemas: string[] = [];
      for (const bloco of todosOsBlocos()) {
        // O resto da LINHA, não só o que está dentro das crases: `decided_by:`
        // seguido de "Fulano" fora da crase é assinatura igual, e uma captura
        // que parasse na crase leria vazio — o guard passaria com o bloco
        // assinado, que é justamente o caso que ele existe para pegar.
        const by = /decided_by\s*:([^\n]*)/u.exec(bloco.texto);
        const at = /decided_at\s*:([^\n]*)/u.exec(bloco.texto);
        const local = `${bloco.documento}:${bloco.linhaInicial} (${bloco.id})`;

        if (!by) problemas.push(`${local} — falta o campo \`decided_by:\``);
        if (!at) problemas.push(`${local} — falta o campo \`decided_at:\``);
        if (!by || !at) continue;

        const limpar = (v: string): string => v.replaceAll('`', '').replace(/^[\s—–-]+/u, '').trim();
        const valorBy = limpar(by[1] ?? '');
        const valorAt = limpar(at[1] ?? '');

        if (valorBy !== '' || valorAt !== '') {
          problemas.push(
            `${local} — decided_by=${JSON.stringify(valorBy)} decided_at=${JSON.stringify(valorAt)}: ` +
              'a decisão foi assinada mas o valor NÃO foi promovido. Promova o valor no documento, ' +
              'remova este bloco e remova o item da lista ITENS_ABERTOS, no mesmo PR.',
          );
        }
      }
      expect(problemas, `\n${problemas.map((p) => `  · ${p}`).join('\n')}\n`).toEqual([]);
    });
  });

  describe('a retórica que fabrica defaults', () => {
    it('nenhum "a spec propõe" / "Proposta:" sobre decisão aberta', () => {
      const achados: string[] = [];
      for (const documento of DOCUMENTOS) {
        for (const linha of foraDeBloco(documento)) {
          for (const padrao of RETORICA_PROIBIDA) {
            const m = padrao.re.exec(linha.texto);
            if (m) {
              achados.push(
                `${documento}:${linha.numero} — ${padrao.porque}\n      trecho: ${JSON.stringify(m[0])}`,
              );
            }
          }
        }
      }
      expect(achados, `\n${achados.map((a) => `  · ${a}`).join('\n')}\n`).toEqual([]);
    });
  });

  describe('Q1, Q2b e Q3 bloqueiam as fatias 3, 4 e 5', () => {
    const BLOQUEANTES = ['Q1', 'Q2b', 'Q3'] as const;

    it('a tabela §13 da spec nomeia as três bloqueantes em CADA fatia de 3 a 5', () => {
      const conteudo = CONTEUDO.get(SPEC);
      if (!conteudo) throw new Error('spec não lida');
      const faltas: string[] = [];

      for (const fatia of ['3', '4', '5']) {
        const linha = conteudo.linhas.find(
          (l) => l.texto.startsWith('|') && new RegExp(`\\*\\*Fatia ${fatia}\\b`, 'u').test(l.texto),
        );
        if (!linha) {
          faltas.push(`§13 não tem linha para a Fatia ${fatia}`);
          continue;
        }
        for (const q of BLOQUEANTES) {
          if (!new RegExp(`\\b${q}\\b`, 'u').test(linha.texto)) {
            faltas.push(`§13, Fatia ${fatia} (linha ${linha.numero}) não nomeia ${q} como pré-condição`);
          }
        }
      }

      expect(
        faltas,
        '\nAs três bloqueantes precisam aparecer em CADA linha das fatias 3–5 de §13. Uma cadeia\n' +
          'implícita ("nenhuma fatia começa antes de a linha acima estar satisfeita") deixa as\n' +
          'fatias 4 e 5 com critério de entrada que passa por cima de Q1/Q2b/Q3.\n' +
          faltas.map((f) => `  · ${f}`).join('\n') +
          '\n',
      ).toEqual([]);
    });

    it('o ADR declara as três bloqueando as fatias 3 a 5', () => {
      const conteudo = CONTEUDO.get(ADR);
      if (!conteudo) throw new Error('ADR não lido');
      const bruto = conteudo.linhas.map((l) => l.texto).join('\n');
      const faltas: string[] = [];

      for (const q of BLOQUEANTES) {
        const secao = new RegExp(`### ${q} —[\\s\\S]*?\\n---`, 'u').exec(bruto);
        if (!secao) {
          faltas.push(`o ADR não tem seção para ${q}`);
          continue;
        }
        const bloqueia = /\*\*Bloqueia\*\*\s*\|([^|\n]*)\|/u.exec(secao[0]);
        if (!bloqueia) {
          faltas.push(`${q} não declara a linha **Bloqueia**`);
          continue;
        }
        if (!/fatias?\s*3\s*(?:a|at[ée]|[-–—])\s*5/iu.test(bloqueia[1] ?? '')) {
          faltas.push(`${q} declara "Bloqueia |${bloqueia[1]}|" — precisa dizer as fatias 3 a 5`);
        }
      }

      expect(faltas, `\n${faltas.map((f) => `  · ${f}`).join('\n')}\n`).toEqual([]);
    });
  });
});
