/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Produced by `scripts/gen-tool-catalog.ts` (`npm run gen:tool-catalog`).
 * A side-effect-free, plain-data snapshot of every tool the LLM can call,
 * consumed by the Admin UI Tools Catalog router
 * (`src/admin-ui/trpc/routers/tools-catalog.ts`).
 *
 * Importing this module pulls in ZERO tool handlers / gateway code — that is
 * the whole point (the router used to dynamically import the registry, which
 * transitively booted the presence sweep timer + a Redis connection + a BullMQ
 * queue inside the admin-ui process). Regenerate with `npm run gen:tool-catalog`
 * whenever a tool's name / description / schema / gating flag changes; the
 * drift-guard test fails otherwise.
 *
 * `enabled` is deliberately absent here — it is runtime state derived from the
 * live config feature flags and computed by the router per request from
 * `feature_flag`.
 */

/** One field of a tool's input schema (flattened by `describeZodObject`). */
export interface ToolCatalogInput {
  /** The object key. */
  name: string;
  /** A short, human-readable type label (e.g. `string`, `enum(a|b)`, `string[]`). */
  type: string;
  /** True when the field is `.optional()`, `.nullable()`, or has a `.default()`. */
  optional: boolean;
}

/** Static metadata for one catalog tool (no runtime `enabled`). */
export interface ToolCatalogEntry {
  name: string;
  description: string;
  side_effect: 'none' | 'read' | 'write' | 'communication';
  operation_type:
    | 'create'
    | 'correct'
    | 'cancel'
    | 'update_meta'
    | 'parse_only'
    | 'read'
    | 'communicate';
  sensitive: boolean;
  /** Gating flag NAME (env-var name or `FeatureFlagName` value), or null when ungated. */
  feature_flag: string | null;
  required_actions: string[];
  inputs: ToolCatalogInput[];
}

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    "name": "approve_capability_proposal",
    "description": "Aprova uma capability proposal pendente. Para holiday: cria o feriado na tabela. Para outros tipos: marca como aprovada (entrega depende do tipo).",
    "side_effect": "write",
    "operation_type": "update_meta",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "manage_capabilities"
    ],
    "inputs": [
      {
        "name": "proposal_id",
        "type": "string",
        "optional": false
      },
      {
        "name": "decision_reason",
        "type": "string",
        "optional": true
      }
    ]
  },
  {
    "name": "ask_pending_question",
    "description": "Cria uma pergunta pendente persistida que será resolvida quando o usuário responder. Use quando precisa esperar uma escolha (sim/não, ou 3-12 opções) antes de continuar.",
    "side_effect": "communication",
    "operation_type": "create",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [],
    "inputs": [
      {
        "name": "entidade_id",
        "type": "string",
        "optional": true
      },
      {
        "name": "pergunta",
        "type": "string",
        "optional": false
      },
      {
        "name": "opcoes_validas",
        "type": "object[]",
        "optional": false
      },
      {
        "name": "acao_proposta",
        "type": "object",
        "optional": true
      },
      {
        "name": "ttl_minutes",
        "type": "number",
        "optional": true
      }
    ]
  },
  {
    "name": "audit_decision",
    "description": "Registra explicitamente uma decisão e seu racional na trilha de auditoria. Sem efeito de negócio — apenas observabilidade.",
    "side_effect": "none",
    "operation_type": "read",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [],
    "inputs": [
      {
        "name": "decision",
        "type": "string",
        "optional": false
      },
      {
        "name": "rationale",
        "type": "string",
        "optional": false
      }
    ]
  },
  {
    "name": "calendar_add_business_days",
    "description": "Soma N dias úteis a uma data (N pode ser negativo para retroceder). Ex.: prazo D+5 para algum SLA.",
    "side_effect": "read",
    "operation_type": "read",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [],
    "inputs": [
      {
        "name": "date",
        "type": "string",
        "optional": false
      },
      {
        "name": "count",
        "type": "number",
        "optional": false
      },
      {
        "name": "entidade_id",
        "type": "string",
        "optional": true
      },
      {
        "name": "kind",
        "type": "enum(standard|clt)",
        "optional": true
      }
    ]
  },
  {
    "name": "calendar_business_days_between",
    "description": "Conta quantos dias úteis há entre duas datas (inclusivos). Range limitado a 366 dias para evitar abuso.",
    "side_effect": "read",
    "operation_type": "read",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [],
    "inputs": [
      {
        "name": "start",
        "type": "string",
        "optional": false
      },
      {
        "name": "end",
        "type": "string",
        "optional": false
      },
      {
        "name": "entidade_id",
        "type": "string",
        "optional": true
      },
      {
        "name": "kind",
        "type": "enum(standard|clt)",
        "optional": true
      }
    ]
  },
  {
    "name": "calendar_is_business_day",
    "description": "Verifica se uma data é dia útil no Brasil. Considera feriados nacionais, estaduais e municipais quando a entidade tem cidade/uf cadastrados.",
    "side_effect": "read",
    "operation_type": "read",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [],
    "inputs": [
      {
        "name": "date",
        "type": "string",
        "optional": false
      },
      {
        "name": "entidade_id",
        "type": "string",
        "optional": true
      },
      {
        "name": "kind",
        "type": "enum(standard|clt)",
        "optional": true
      }
    ]
  },
  {
    "name": "calendar_list_holidays",
    "description": "Lista feriados num intervalo de datas. Considera regionais (estaduais + municipais) quando entidade tem cidade/uf cadastrados.",
    "side_effect": "read",
    "operation_type": "read",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [],
    "inputs": [
      {
        "name": "start",
        "type": "string",
        "optional": false
      },
      {
        "name": "end",
        "type": "string",
        "optional": false
      },
      {
        "name": "entidade_id",
        "type": "string",
        "optional": true
      }
    ]
  },
  {
    "name": "calendar_next_holiday",
    "description": "Retorna o próximo feriado a partir de uma data (default hoje). Pode considerar feriados regionais quando entidade tem cidade/uf cadastrados.",
    "side_effect": "read",
    "operation_type": "read",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [],
    "inputs": [
      {
        "name": "from",
        "type": "string",
        "optional": true
      },
      {
        "name": "entidade_id",
        "type": "string",
        "optional": true
      }
    ]
  },
  {
    "name": "cancel_reminder",
    "description": "Cancela uma série agendada (lembrete único, outreach recorrente, payment_due). Encerra a série e todas as ocorrências pendentes/em execução numa transação só. Use quando o usuário pede para esquecer/cancelar algo agendado.",
    "side_effect": "write",
    "operation_type": "cancel",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "schedule_reminder"
    ],
    "inputs": [
      {
        "name": "series_id",
        "type": "string",
        "optional": false
      },
      {
        "name": "reason",
        "type": "string",
        "optional": true
      }
    ]
  },
  {
    "name": "cancel_transaction",
    "description": "Cancela uma transação registrada. Use APENAS quando o dono explicitamente confirmar (via pending edit_review, ou comando direto). Out-of-scope é recusado. `entidade_id` deve ser a entidade dona da transação.",
    "side_effect": "write",
    "operation_type": "cancel",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "cancel_transaction"
    ],
    "inputs": [
      {
        "name": "entidade_id",
        "type": "string",
        "optional": false
      },
      {
        "name": "transacao_id",
        "type": "string",
        "optional": false
      },
      {
        "name": "motivo",
        "type": "string",
        "optional": true
      }
    ]
  },
  {
    "name": "classify_transaction",
    "description": "Sugere uma categoria para uma transação dada sua descrição. Considera regras aprendidas e similaridade com categorias existentes.",
    "side_effect": "read",
    "operation_type": "read",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "read_transactions"
    ],
    "inputs": [
      {
        "name": "entidade_id",
        "type": "string",
        "optional": false
      },
      {
        "name": "descricao",
        "type": "string",
        "optional": false
      },
      {
        "name": "contraparte",
        "type": "string",
        "optional": true
      },
      {
        "name": "natureza",
        "type": "enum(receita|despesa|movimentacao)",
        "optional": true
      }
    ]
  },
  {
    "name": "compare_entities",
    "description": "Comparativo financeiro entre entidades em um período (receitas, despesas, lucro, caixa final).",
    "side_effect": "read",
    "operation_type": "read",
    "sensitive": true,
    "feature_flag": null,
    "required_actions": [
      "read_reports"
    ],
    "inputs": [
      {
        "name": "entidade_ids",
        "type": "string[]",
        "optional": false
      },
      {
        "name": "date_from",
        "type": "string",
        "optional": false
      },
      {
        "name": "date_to",
        "type": "string",
        "optional": false
      }
    ]
  },
  {
    "name": "conversation_state_update",
    "description": "Atualiza um estado LEVE e não-gate da conversa atual (ex.: tag de tópico, preferência do thread), fazendo merge atômico no metadata. Sempre escopado à própria conversa; estado de pendência/confirmação NÃO passa por aqui (use ask_pending_question).",
    "side_effect": "write",
    "operation_type": "update_meta",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "update_conversation_state"
    ],
    "inputs": [
      {
        "name": "patch",
        "type": "record",
        "optional": false
      },
      {
        "name": "conversation_id",
        "type": "string",
        "optional": true
      }
    ]
  },
  {
    "name": "conversation_summary_compose",
    "description": "Compõe um resumo estruturado da conversa atual (resumo, perguntas em aberto, decisões e pendências), usando o histórico fornecido ou as mensagens recentes desta conversa. Apenas leitura — não persiste nem encerra a conversa.",
    "side_effect": "none",
    "operation_type": "parse_only",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [],
    "inputs": [
      {
        "name": "history",
        "type": "object[]",
        "optional": true
      },
      {
        "name": "limit",
        "type": "number",
        "optional": true
      },
      {
        "name": "purpose",
        "type": "string",
        "optional": true
      },
      {
        "name": "max_chars",
        "type": "number",
        "optional": true
      }
    ]
  },
  {
    "name": "explain_limitation",
    "description": "Explica de forma honesta que o agente não pode realizar algo (e por quê), em vez de inventar uma ação sem permissão. Apenas texto, sem efeito colateral.",
    "side_effect": "none",
    "operation_type": "read",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [],
    "inputs": [
      {
        "name": "requested",
        "type": "string",
        "optional": false
      },
      {
        "name": "reason",
        "type": "string",
        "optional": false
      },
      {
        "name": "suggestion",
        "type": "string",
        "optional": true
      }
    ]
  },
  {
    "name": "generate_report",
    "description": "Gera um relatório financeiro em PDF e o envia como anexo no WhatsApp. Use quando o owner pedir \"extrato\", \"relatório\", \"manda em PDF\", \"comparativo\", ou quando a resposta seria uma tabela longa (>20 linhas). Caption do envio é o texto que você devolver depois do tool result. Não use para saldo (responder em texto direto).",
    "side_effect": "read",
    "operation_type": "read",
    "sensitive": false,
    "feature_flag": "FEATURE_PDF_REPORTS",
    "required_actions": [
      "read_transactions",
      "read_reports"
    ],
    "inputs": [
      {
        "name": "tipo",
        "type": "discriminator(extrato|comparativo)",
        "optional": false
      },
      {
        "name": "entidade_id",
        "type": "string (variant)",
        "optional": true
      },
      {
        "name": "date_from",
        "type": "string",
        "optional": false
      },
      {
        "name": "date_to",
        "type": "string",
        "optional": false
      },
      {
        "name": "natureza",
        "type": "enum(receita|despesa|movimentacao) (variant)",
        "optional": true
      },
      {
        "name": "entidade_ids",
        "type": "string[] (variant)",
        "optional": true
      }
    ]
  },
  {
    "name": "handoff_to_owner",
    "description": "Escala a conversa para o dono do agente (hand-off INTERNO). Não envia mensagem externa arbitrária — apenas sinaliza que o dono deve assumir/revisar.",
    "side_effect": "communication",
    "operation_type": "communicate",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "escalate_to_owner"
    ],
    "inputs": [
      {
        "name": "reason",
        "type": "string",
        "optional": false
      },
      {
        "name": "summary",
        "type": "string",
        "optional": false
      },
      {
        "name": "urgency",
        "type": "enum(low|normal|high)",
        "optional": true
      }
    ]
  },
  {
    "name": "identify_entity",
    "description": "Tenta inferir qual entidade do escopo do interlocutor o usuário está mencionando. Se ambíguo, retorna ambiguous=true e a Maia deve perguntar.",
    "side_effect": "read",
    "operation_type": "read",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "read_balance"
    ],
    "inputs": [
      {
        "name": "texto",
        "type": "string",
        "optional": false
      }
    ]
  },
  {
    "name": "list_pending",
    "description": "Lista o que está pendente para o interlocutor: perguntas abertas, workflows em andamento, aprovações 4-olhos aguardando, e transações com status pendente. Use quando o usuário pergunta \"o que tá pendente\", \"tem algo aberto?\", etc.",
    "side_effect": "read",
    "operation_type": "read",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "read_pending_questions"
    ],
    "inputs": [
      {
        "name": "entidade_id",
        "type": "string",
        "optional": true
      },
      {
        "name": "limit",
        "type": "number",
        "optional": true
      }
    ]
  },
  {
    "name": "list_pending_proposals",
    "description": "Lista capability proposals pendentes (status=submitted) para o owner aprovar ou rejeitar. Filtro opcional por capability_type (holiday, tool, knowledge, procedure, ...).",
    "side_effect": "read",
    "operation_type": "read",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [],
    "inputs": [
      {
        "name": "capability_type",
        "type": "enum(tool|knowledge|procedure|integration|other|holiday)",
        "optional": true
      }
    ]
  },
  {
    "name": "list_transactions",
    "description": "Lista transações de uma entidade com filtros opcionais.",
    "side_effect": "read",
    "operation_type": "read",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "read_transactions"
    ],
    "inputs": [
      {
        "name": "entidade_id",
        "type": "string",
        "optional": false
      },
      {
        "name": "date_from",
        "type": "string",
        "optional": true
      },
      {
        "name": "date_to",
        "type": "string",
        "optional": true
      },
      {
        "name": "categoria_id",
        "type": "string",
        "optional": true
      },
      {
        "name": "natureza",
        "type": "enum(receita|despesa|movimentacao)",
        "optional": true
      },
      {
        "name": "limit",
        "type": "number",
        "optional": true
      },
      {
        "name": "offset",
        "type": "number",
        "optional": true
      }
    ]
  },
  {
    "name": "parse_boleto",
    "description": "Extrai dados estruturados de uma imagem de boleto: linha digitável, valor, vencimento, beneficiário, banco emissor.",
    "side_effect": "read",
    "operation_type": "parse_only",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "read_balance"
    ],
    "inputs": [
      {
        "name": "media_local_path",
        "type": "string",
        "optional": false
      },
      {
        "name": "file_sha256",
        "type": "string",
        "optional": false
      }
    ]
  },
  {
    "name": "parse_image",
    "description": "Identifica o tipo da imagem (boleto vs comprovante PIX/TED) e extrai os campos. Use quando o usuário envia uma foto e você não tem certeza do tipo.",
    "side_effect": "read",
    "operation_type": "parse_only",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "read_balance"
    ],
    "inputs": [
      {
        "name": "media_local_path",
        "type": "string",
        "optional": false
      },
      {
        "name": "file_sha256",
        "type": "string",
        "optional": false
      }
    ]
  },
  {
    "name": "parse_receipt",
    "description": "Extrai dados estruturados de uma imagem de comprovante (PIX, TED, DOC, etc.): tipo, valor, beneficiário, chave PIX, endToEndId.",
    "side_effect": "read",
    "operation_type": "parse_only",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "read_balance"
    ],
    "inputs": [
      {
        "name": "media_local_path",
        "type": "string",
        "optional": false
      },
      {
        "name": "file_sha256",
        "type": "string",
        "optional": false
      }
    ]
  },
  {
    "name": "propose_fact",
    "description": "Propõe um fato operacional. O harness (Knowledge State Machine) decide se nasce ephemeral (visível ao LLM) ou pending_review (humano decide). NUNCA cria diretamente como active.",
    "side_effect": "write",
    "operation_type": "create",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "read_balance"
    ],
    "inputs": [
      {
        "name": "escopo",
        "type": "string",
        "optional": false
      },
      {
        "name": "chave",
        "type": "string",
        "optional": false
      },
      {
        "name": "valor",
        "type": "unknown",
        "optional": false
      },
      {
        "name": "texto",
        "type": "string",
        "optional": false
      },
      {
        "name": "fonte",
        "type": "enum(configurado|aprendido|inferido)",
        "optional": true
      },
      {
        "name": "confianca",
        "type": "number",
        "optional": true
      },
      {
        "name": "sensibilidade",
        "type": "enum(low|medium|high)",
        "optional": true
      }
    ]
  },
  {
    "name": "propose_hint",
    "description": "Propõe um hint comportamental ou de procedimento. Harness decide via Knowledge State Machine. Hints derivados de memória sensível NÃO verbalizam o conteúdo original.",
    "side_effect": "write",
    "operation_type": "create",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "read_balance"
    ],
    "inputs": [
      {
        "name": "hint_kind",
        "type": "enum(behavioral_hint|procedure_hint)",
        "optional": true
      },
      {
        "name": "scope_type",
        "type": "enum(interlocutor|role|channel|conversation|agent|tenant)",
        "optional": false
      },
      {
        "name": "subject_id",
        "type": "string",
        "optional": true
      },
      {
        "name": "hint_text",
        "type": "string",
        "optional": false
      },
      {
        "name": "derived_from_memory_id",
        "type": "string",
        "optional": true
      },
      {
        "name": "derived_sensitivity",
        "type": "enum(low|medium|high)",
        "optional": true
      },
      {
        "name": "ttl_days",
        "type": "number",
        "optional": true
      },
      {
        "name": "confianca",
        "type": "number",
        "optional": true
      }
    ]
  },
  {
    "name": "propose_memory",
    "description": "Propõe uma memória episódica/comportamental. Harness decide visibilidade via Knowledge State Machine. Memória sensible automaticamente cai em pending_review.",
    "side_effect": "write",
    "operation_type": "create",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "read_balance"
    ],
    "inputs": [
      {
        "name": "memory_type",
        "type": "enum(operational|preference|personal|sensitive)",
        "optional": false
      },
      {
        "name": "scope_type",
        "type": "enum(interlocutor|role|channel|conversation|agent|tenant)",
        "optional": false
      },
      {
        "name": "subject_id",
        "type": "string",
        "optional": true
      },
      {
        "name": "conteudo",
        "type": "string",
        "optional": false
      },
      {
        "name": "sensibilidade",
        "type": "enum(low|medium|high)",
        "optional": true
      },
      {
        "name": "ttl_days",
        "type": "number",
        "optional": true
      },
      {
        "name": "confianca",
        "type": "number",
        "optional": true
      }
    ]
  },
  {
    "name": "propose_rule",
    "description": "Propõe uma regra aprendida. Regras SEMPRE caem em pending_review (humano decide) — nunca auto-ativadas.",
    "side_effect": "write",
    "operation_type": "create",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "read_balance"
    ],
    "inputs": [
      {
        "name": "tipo",
        "type": "enum(classificacao|identificacao_entidade|tom_resposta|recorrencia)",
        "optional": false
      },
      {
        "name": "contexto",
        "type": "string",
        "optional": false
      },
      {
        "name": "acao",
        "type": "string",
        "optional": false
      },
      {
        "name": "contexto_jsonb",
        "type": "record",
        "optional": true
      },
      {
        "name": "acoes_jsonb",
        "type": "record",
        "optional": true
      },
      {
        "name": "confianca",
        "type": "number",
        "optional": true
      },
      {
        "name": "exemplo_origem_id",
        "type": "string",
        "optional": true
      }
    ]
  },
  {
    "name": "query_balance",
    "description": "Consulta saldos das contas bancárias de uma entidade ou de uma conta específica. Sem args, retorna saldos de todas as contas no escopo.",
    "side_effect": "read",
    "operation_type": "read",
    "sensitive": true,
    "feature_flag": null,
    "required_actions": [
      "read_balance"
    ],
    "inputs": [
      {
        "name": "entidade_id",
        "type": "string",
        "optional": true
      },
      {
        "name": "conta_id",
        "type": "string",
        "optional": true
      }
    ]
  },
  {
    "name": "read_turn_context",
    "description": "Lê o contexto do turno atual: as mensagens recentes desta conversa, dentro do escopo do agente. Apenas leitura, sem efeito colateral.",
    "side_effect": "none",
    "operation_type": "read",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [],
    "inputs": [
      {
        "name": "limit",
        "type": "number",
        "optional": true
      }
    ]
  },
  {
    "name": "recall_memory",
    "description": "Busca memórias passadas por similaridade semântica dentro do escopo do interlocutor.",
    "side_effect": "read",
    "operation_type": "read",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "read_transactions"
    ],
    "inputs": [
      {
        "name": "query",
        "type": "string",
        "optional": false
      },
      {
        "name": "tipos",
        "type": "string[]",
        "optional": true
      },
      {
        "name": "k",
        "type": "number",
        "optional": true
      }
    ]
  },
  {
    "name": "register_custom_holiday",
    "description": "Registra um feriado custom (entity_custom) ou recesso de holding (holding_recess) vinculado a uma ou mais entidades.",
    "side_effect": "write",
    "operation_type": "create",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "manage_calendar"
    ],
    "inputs": [
      {
        "name": "name",
        "type": "string",
        "optional": false
      },
      {
        "name": "month",
        "type": "number",
        "optional": false
      },
      {
        "name": "day",
        "type": "number",
        "optional": false
      },
      {
        "name": "year",
        "type": "number",
        "optional": true
      },
      {
        "name": "type",
        "type": "enum(entity_custom|holding_recess)",
        "optional": true
      },
      {
        "name": "entidade_ids",
        "type": "string[]",
        "optional": false
      }
    ]
  },
  {
    "name": "register_transaction",
    "description": "Registra uma transação financeira (receita, despesa ou movimentação) em uma conta de uma entidade. Sempre valor positivo; o sinal vem da natureza.",
    "side_effect": "write",
    "operation_type": "create",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "create_transaction"
    ],
    "inputs": [
      {
        "name": "entidade_id",
        "type": "string",
        "optional": false
      },
      {
        "name": "conta_id",
        "type": "string",
        "optional": false
      },
      {
        "name": "natureza",
        "type": "enum(receita|despesa|movimentacao)",
        "optional": false
      },
      {
        "name": "valor",
        "type": "number",
        "optional": false
      },
      {
        "name": "data_competencia",
        "type": "string",
        "optional": false
      },
      {
        "name": "data_pagamento",
        "type": "string",
        "optional": true
      },
      {
        "name": "status",
        "type": "enum(pendente|agendada|paga|recebida)",
        "optional": false
      },
      {
        "name": "descricao",
        "type": "string",
        "optional": false
      },
      {
        "name": "categoria_id",
        "type": "string",
        "optional": true
      },
      {
        "name": "contraparte_id",
        "type": "string",
        "optional": true
      },
      {
        "name": "contraparte_nome",
        "type": "string",
        "optional": true
      },
      {
        "name": "metadata",
        "type": "record",
        "optional": true
      },
      {
        "name": "origem",
        "type": "enum(whatsapp|manual)",
        "optional": true
      }
    ]
  },
  {
    "name": "reject_capability_proposal",
    "description": "Rejeita uma capability proposal pendente. Estado terminal.",
    "side_effect": "write",
    "operation_type": "update_meta",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "manage_capabilities"
    ],
    "inputs": [
      {
        "name": "proposal_id",
        "type": "string",
        "optional": false
      },
      {
        "name": "reason",
        "type": "string",
        "optional": false
      }
    ]
  },
  {
    "name": "remember_safe_fact",
    "description": "Registra um fato SEGURO sobre o interlocutor atual (ex.: preferência de tratamento, idioma). Escopo é sempre a própria pessoa da conversa — não escreve memória global nem de domínio.",
    "side_effect": "write",
    "operation_type": "create",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "save_safe_fact"
    ],
    "inputs": [
      {
        "name": "chave",
        "type": "string",
        "optional": false
      },
      {
        "name": "valor",
        "type": "string",
        "optional": false
      }
    ]
  },
  {
    "name": "request_confirmation",
    "description": "Pede confirmação ao interlocutor antes de uma ação. Apenas pergunta — não executa nada. Use quando precisar de um \"sim\" explícito antes de agir.",
    "side_effect": "none",
    "operation_type": "read",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [],
    "inputs": [
      {
        "name": "action_summary",
        "type": "string",
        "optional": false
      },
      {
        "name": "question",
        "type": "string",
        "optional": false
      }
    ]
  },
  {
    "name": "risk_signal_classify",
    "description": "Classifica o risco do turno atual (low/medium/high/critical) e recomenda a próxima ação (allow/clarify/confirm/handoff). Determinístico — o nível vem do scorer compartilhado; sem efeito colateral.",
    "side_effect": "none",
    "operation_type": "parse_only",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [],
    "inputs": [
      {
        "name": "text",
        "type": "string",
        "optional": true
      },
      {
        "name": "topic",
        "type": "enum(casual|operational_simple|financial|legal|health|critical_decision|unknown)",
        "optional": true
      },
      {
        "name": "tool_kinds",
        "type": "enum(read_local|read_external|write_local|write_external|transfer|irreversible|communication)[]",
        "optional": true
      },
      {
        "name": "skill_confidence",
        "type": "number",
        "optional": true
      },
      {
        "name": "skill_threshold",
        "type": "number",
        "optional": true
      },
      {
        "name": "active_sensitive_memory_count",
        "type": "number",
        "optional": true
      },
      {
        "name": "active_procedure_has_critical_step",
        "type": "boolean",
        "optional": true
      }
    ]
  },
  {
    "name": "save_fact",
    "description": "[DEPRECATED até P11] Use propose_fact. save_fact agora propõe via Knowledge State Machine — pode cair em pending_review se risk elevado.",
    "side_effect": "write",
    "operation_type": "create",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "read_balance"
    ],
    "inputs": [
      {
        "name": "escopo",
        "type": "string",
        "optional": false
      },
      {
        "name": "chave",
        "type": "string",
        "optional": false
      },
      {
        "name": "valor",
        "type": "unknown",
        "optional": false
      },
      {
        "name": "fonte",
        "type": "enum(configurado|aprendido|inferido)",
        "optional": true
      },
      {
        "name": "confianca",
        "type": "number",
        "optional": true
      }
    ]
  },
  {
    "name": "save_rule",
    "description": "[DEPRECATED até P11] Use propose_rule. save_rule agora propõe via Knowledge State Machine — regras sempre caem em pending_review (humano decide).",
    "side_effect": "write",
    "operation_type": "create",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "read_balance"
    ],
    "inputs": [
      {
        "name": "tipo",
        "type": "enum(classificacao|identificacao_entidade|tom_resposta|recorrencia)",
        "optional": false
      },
      {
        "name": "contexto",
        "type": "string",
        "optional": false
      },
      {
        "name": "acao",
        "type": "string",
        "optional": false
      },
      {
        "name": "contexto_jsonb",
        "type": "record",
        "optional": true
      },
      {
        "name": "acoes_jsonb",
        "type": "record",
        "optional": true
      },
      {
        "name": "exemplo_origem_id",
        "type": "string",
        "optional": true
      }
    ]
  },
  {
    "name": "schedule_reminder",
    "description": "Agenda um lembrete único para enviar via WhatsApp em um momento futuro. Para lembretes recorrentes use start_recurring_outreach ou start_recurring_payment.",
    "side_effect": "write",
    "operation_type": "create",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "schedule_reminder"
    ],
    "inputs": [
      {
        "name": "entidade_id",
        "type": "string",
        "optional": true
      },
      {
        "name": "quando",
        "type": "string",
        "optional": false
      },
      {
        "name": "texto",
        "type": "string",
        "optional": false
      },
      {
        "name": "canal",
        "type": "enum(whatsapp)",
        "optional": true
      }
    ]
  },
  {
    "name": "send_proactive_message",
    "description": "Envia uma mensagem proativa para outra pessoa. Sempre exige dual approval, exceto quando o destinatário é dono/co_dono (auto-mensagem).",
    "side_effect": "communication",
    "operation_type": "communicate",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "send_proactive_message"
    ],
    "inputs": [
      {
        "name": "pessoa_id_destino",
        "type": "string",
        "optional": false
      },
      {
        "name": "texto",
        "type": "string",
        "optional": false
      },
      {
        "name": "reason",
        "type": "string",
        "optional": false
      }
    ]
  },
  {
    "name": "start_recurring_outreach",
    "description": "Agenda uma série recorrente de mensagens para um terceiro (ex: pedir relatório mensal). Cada ciclo envia o template para o destinatário, espera resposta (ou expira em wait_response_hours), e se forward_template estiver setado, encaminha para uma segunda pessoa. Requer aprovação dupla (dual_approval_granted=true).",
    "side_effect": "communication",
    "operation_type": "create",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "send_proactive_message"
    ],
    "inputs": [
      {
        "name": "rrule",
        "type": "string",
        "optional": false
      },
      {
        "name": "destinatario_pessoa_id",
        "type": "string",
        "optional": false
      },
      {
        "name": "forward_to_pessoa_id",
        "type": "string",
        "optional": true
      },
      {
        "name": "message_template",
        "type": "string",
        "optional": false
      },
      {
        "name": "forward_template",
        "type": "string",
        "optional": true
      },
      {
        "name": "wait_response_hours",
        "type": "number",
        "optional": true
      },
      {
        "name": "month_end_policy",
        "type": "enum(skip_invalid_month|last_day_of_month|nearest_previous|nearest_next)",
        "optional": true
      },
      {
        "name": "missed_run_policy",
        "type": "enum(fire_all|fire_latest_only|skip_all|escalate_to_owner)",
        "optional": true
      },
      {
        "name": "staleness_threshold_hours",
        "type": "number",
        "optional": true
      },
      {
        "name": "exclusive_per_destinatario",
        "type": "boolean",
        "optional": true
      },
      {
        "name": "entidade_id",
        "type": "string",
        "optional": false
      },
      {
        "name": "dual_approval_granted",
        "type": "boolean",
        "optional": false
      }
    ]
  },
  {
    "name": "start_recurring_payment",
    "description": "Agenda uma série recorrente de confirmações de pagamento. A Maia NUNCA paga sozinha — em cada ciclo ela pergunta ao dono se deve pagar (sim/não/adiar), e só com \"sim\" registra a transação. Use para aluguel mensal, conta fixa, mensalidade etc.",
    "side_effect": "write",
    "operation_type": "create",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "create_transaction"
    ],
    "inputs": [
      {
        "name": "rrule",
        "type": "string",
        "optional": false
      },
      {
        "name": "conta_id",
        "type": "string",
        "optional": false
      },
      {
        "name": "valor",
        "type": "number",
        "optional": false
      },
      {
        "name": "descricao",
        "type": "string",
        "optional": false
      },
      {
        "name": "categoria_id",
        "type": "string",
        "optional": true
      },
      {
        "name": "contraparte_id",
        "type": "string",
        "optional": true
      },
      {
        "name": "escalate_after_hours",
        "type": "number",
        "optional": true
      },
      {
        "name": "month_end_policy",
        "type": "enum(skip_invalid_month|last_day_of_month|nearest_previous|nearest_next)",
        "optional": true
      },
      {
        "name": "missed_run_policy",
        "type": "enum(fire_all|fire_latest_only|skip_all|escalate_to_owner)",
        "optional": true
      },
      {
        "name": "staleness_threshold_hours",
        "type": "number",
        "optional": true
      },
      {
        "name": "entidade_id",
        "type": "string",
        "optional": false
      }
    ]
  },
  {
    "name": "start_workflow",
    "description": "Cria um workflow multi-passo persistido para tarefas que excedem o turn-by-turn (fechamento de mês, cobrança de balancete, consolidação, follow-up). Use quando a tarefa requer >2 passos sequenciais ou aguarda evento externo. NÃO use para ações simples (registrar transação, consultar saldo) nem para agendamentos recorrentes (use schedule_reminder / start_recurring_outreach / start_recurring_payment).",
    "side_effect": "write",
    "operation_type": "create",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "schedule_reminder"
    ],
    "inputs": [
      {
        "name": "tipo",
        "type": "enum(fechamento_mes|cobranca_balancete|consolidacao_caixa|follow_up)",
        "optional": false
      },
      {
        "name": "entidade_id",
        "type": "string",
        "optional": false
      },
      {
        "name": "resumo",
        "type": "string",
        "optional": false
      },
      {
        "name": "steps",
        "type": "object[]",
        "optional": false
      },
      {
        "name": "contexto",
        "type": "record",
        "optional": true
      }
    ]
  },
  {
    "name": "transcribe_audio",
    "description": "Transcreve um áudio (voice note) para texto em português.",
    "side_effect": "read",
    "operation_type": "parse_only",
    "sensitive": false,
    "feature_flag": null,
    "required_actions": [
      "read_balance"
    ],
    "inputs": [
      {
        "name": "media_local_path",
        "type": "string",
        "optional": false
      },
      {
        "name": "file_sha256",
        "type": "string",
        "optional": false
      }
    ]
  }
];
