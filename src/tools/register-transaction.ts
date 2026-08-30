import { z } from 'zod';
import { contasRepo, transacoesRepo, categoriasRepo } from '@/db/repositories.js';
import { withTx } from '@/db/client.js';
import { auditTx } from '@/governance/audit.js';
import type { Tool } from './_registry.js';
import { trigramSim } from '@/lib/utils.js';
import { TypedError } from '@/lib/utils.js';
import { toDecimal } from '@/lib/decimal.js';

// Issue #509 §6 — the `.describe()` texts below are shipped to the model as the
// JSON Schema `description` of each field (see src/tools/schema-json.ts). They
// state units, formats and opacity of identifiers so the model stops guessing.
// They must NEVER teach the model to assert authority (approval, ownership,
// tenancy): those come from backend state alone.
const inputSchema = z.object({
  entidade_id: z
    .string()
    .uuid()
    .describe('UUID opaco da entidade dona da conta. Nunca invente: use um id já visto no contexto.'),
  conta_id: z
    .string()
    .uuid()
    .describe('UUID opaco da conta que recebe o lançamento. Deve pertencer a entidade_id.'),
  natureza: z
    .enum(['receita', 'despesa', 'movimentacao'])
    .describe('Sinal do lançamento. O valor é sempre positivo; o sinal vem daqui.'),
  valor: z
    .number()
    .positive()
    .describe('Valor absoluto em BRL (reais), maior que zero. Use ponto decimal, ex.: 1234.56.'),
  data_competencia: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('Data de competência no formato YYYY-MM-DD (fuso do interlocutor).'),
  data_pagamento: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Data de pagamento no formato YYYY-MM-DD. Omita quando ainda não houve pagamento.'),
  status: z
    .enum(['pendente', 'agendada', 'paga', 'recebida'])
    .describe('Situação do lançamento no momento do registro.'),
  descricao: z.string().min(1).max(280).describe('Descrição livre, 1 a 280 caracteres.'),
  categoria_id: z.string().uuid().optional().describe('UUID opaco de categoria já existente.'),
  contraparte_id: z.string().uuid().optional().describe('UUID opaco de contraparte já existente.'),
  contraparte_nome: z
    .string()
    .optional()
    .describe('Nome da contraparte quando não houver contraparte_id.'),
  metadata: z
    .record(z.unknown())
    .optional()
    .describe('Mapa livre de metadados auxiliares. Não use para dados sensíveis.'),
  origem: z
    .enum(['whatsapp', 'manual'])
    .default('whatsapp')
    .describe('Canal de origem do registro. Omita para usar o default "whatsapp".'),
});

const outputSchema = z.union([
  z.object({
    transacao_id: z.string().uuid(),
    saldo_apos: z.number(),
  }),
  z.object({
    duplicate_suspected: z.literal(true),
    existing: z.object({
      transacao_id: z.string(),
      data_competencia: z.string(),
      valor: z.number(),
      descricao: z.string(),
    }),
  }),
]);

export const registerTransactionTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'register_transaction',
  description:
    'Registra uma transação financeira (receita, despesa ou movimentação) em uma conta de uma entidade. Sempre valor positivo; o sinal vem da natureza.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['create_transaction'],
  side_effect: 'write',
  // Issue #507 — cancelar depois que o handler começou deixa `effect_unknown`:
  // pode existir uma linha no razão. A compensação é EXPLÍCITA e existe no
  // registro (`cancel_transaction`), então a reconciliação é procedimento, não
  // improviso — por isso `compensatable` e não `non_interruptible`.
  effect_class: 'compensatable',
  compensated_by: 'cancel_transaction',
  redis_required: false,
  operation_type: 'create',
  audit_action: 'transaction_created',
  // Issue #366 — this money-moving tool writes its audit row TRANSACTIONALLY
  // (auditTx inside the withTx below), so the dispatcher must NOT also fire its
  // post-commit best-effort audit() (would duplicate the audit row).
  audits_in_tx: true,
  // Review #374 — PER-INVOCATION signal. `auditTx` runs ONLY on the mutating
  // branch (the `withTx` that returns `{ transacao_id, saldo_apos }`). The
  // duplicate-suspected EARLY RETURN exits before any tx, so it self-audited
  // nothing — the dispatcher must still fire its fallback audit() there.
  auditedInTx: (result) =>
    'transacao_id' in result && typeof result.transacao_id === 'string',
  extractAlvoId: (result) =>
    'transacao_id' in result && typeof result.transacao_id === 'string' ? result.transacao_id : null,
  handler: async (args, ctx) => {
    const conta = await contasRepo.byId(args.conta_id);
    if (!conta) throw new TypedError('conta_not_found', 'conta não existe');
    if (conta.entidade_id !== args.entidade_id) {
      throw new TypedError('entidade_conta_mismatch', 'a conta não pertence à entidade indicada');
    }

    // Semantic dedup (layer 3): check recent similar
    const recent = await transacoesRepo.findRecentSimilar({
      entidade_id: args.entidade_id,
      valor: args.valor.toFixed(2),
      descricao: args.descricao,
      registrado_por: ctx.pessoa.id,
      sinceMs: 2 * 60 * 60 * 1000,
    });
    const sim = recent.find((t) => trigramSim(t.descricao, args.descricao) > 0.85);
    if (sim) {
      return {
        duplicate_suspected: true as const,
        existing: {
          transacao_id: sim.id,
          data_competencia: sim.data_competencia,
          // sim.valor é string (numeric pg). toDecimal valida antes de
          // converter pra number do output_schema.
          valor: toDecimal(sim.valor).toNumber(),
          descricao: sim.descricao,
        },
      };
    }

    let categoria_id = args.categoria_id ?? null;
    if (!categoria_id) {
      const generic = await categoriasRepo.byNomeNatureza(
        args.natureza === 'receita' ? 'Outras receitas' : 'Outras despesas',
        args.natureza === 'movimentacao' ? 'movimentacao' : args.natureza,
      );
      categoria_id = generic?.id ?? null;
    }

    const contraparte_id = args.contraparte_id ?? null;
    if (!contraparte_id && args.contraparte_nome) {
      // Optionally lookup or fallback to text-only field; do not auto-create here (4-eyes).
    }

    // ATOMICITY (#323 H3 — PR #364 review blocker 2): the ledger INSERT and the
    // paired balance credit MUST commit (or roll back) together. `addToBalanceTx`
    // is fail-loud on a 0-row tenant/agent mismatch; running both writes through
    // the SAME `withTx` handle means such a throw rolls back the just-created
    // transaction too — no orphan ledger row without its balance credit
    // (corrupted money). The happy path is unchanged: both writes commit.
    //
    // saldo_atual vem como string do pg. Aritmética intermediária (sign * valor,
    // soma com saldo) seria perigosa em number — fazemos via Decimal. O update no
    // DB usa SQL `saldo_atual + ${delta}` direto no banco (numeric exato), mas o
    // saldo_apos retornado pelo tool precisa ser number (output_schema é z.number()).
    const { transacao_id, saldo_apos } = await withTx(async (tx) => {
      const t = await transacoesRepo.createTx(tx, {
        entidade_id: args.entidade_id,
        conta_id: args.conta_id,
        categoria_id,
        natureza: args.natureza,
        valor: args.valor.toFixed(2),
        data_competencia: args.data_competencia,
        data_pagamento: args.data_pagamento ?? null,
        status: args.status,
        descricao: args.descricao,
        contraparte: args.contraparte_nome ?? null,
        contraparte_id,
        origem: args.origem,
        conversa_id: ctx.conversa.id,
        mensagem_id: ctx.mensagem_id,
        registrado_por: ctx.pessoa.id,
        confianca_ia: null,
        confirmada_em: null,
        metadata: args.metadata ?? {},
      });

      let saldo_aposDec = toDecimal(conta.saldo_atual);
      if (args.status === 'paga' || args.status === 'recebida') {
        const sign = args.natureza === 'receita' ? 1 : args.natureza === 'despesa' ? -1 : 0;
        const delta = toDecimal(args.valor).times(sign);
        // addToBalanceTx aceita number; o banco faz a soma em numeric e retorna a
        // linha atualizada, da qual lemos saldo_atual já calculado.
        const updated = await contasRepo.addToBalanceTx(tx, conta.id, delta.toNumber());
        saldo_aposDec = updated ? toDecimal(updated.saldo_atual) : saldo_aposDec;
      }

      // Issue #366 — DURABLE audit: write the audit row inside the SAME tx as
      // the ledger INSERT + balance credit. If this insert fails, the whole tx
      // rolls back — money can never move without its audit row. `auditTx` does
      // NOT swallow errors (unlike the dispatcher's post-commit best-effort
      // `audit()`, which `audits_in_tx` suppresses to avoid a duplicate row).
      // metadata mirrors what the dispatcher would have recorded ({ tool }).
      await auditTx(tx, {
        acao: 'transaction_created',
        pessoa_id: ctx.pessoa.id,
        conversa_id: ctx.conversa.id,
        mensagem_id: ctx.mensagem_id,
        entidade_alvo: args.entidade_id,
        alvo_id: t.id,
        metadata: { tool: 'register_transaction' },
      });

      return { transacao_id: t.id, saldo_apos: saldo_aposDec.toNumber() };
    });

    return { transacao_id, saldo_apos };
  },
};
