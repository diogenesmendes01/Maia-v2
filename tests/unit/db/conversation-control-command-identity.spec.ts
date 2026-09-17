/**
 * Identidade canônica de um comando de controle humano (spec §8.3.2, §8.2.4).
 *
 * Achado de revisão da PR #766: o `request_hash` de pausa e retomada cobria só
 * `request_payload`. A mesma chave com o mesmo payload, reusada noutra conversa,
 * por outro operador, com outro epoch esperado ou noutra operação, voltava como
 * REPLAY aceito do comando anterior — sem pausar nada e sem auditar.
 *
 * O §8.3.2 fixa o que entra: "versão do contrato, principal autenticado, tipo de
 * comando, controle/conversa, epoch esperado e payload validado", e "reuso
 * divergente, inclusive em outra conversa ou tipo de comando, dá conflito".
 * `reason_code` e `resume_policy` são campos validados do comando, então fazem
 * parte do payload validado.
 *
 * Cada caso varia UM campo. Sem isso, remover um campo da identidade passaria
 * pela suíte — que é exatamente como o defeito original passou.
 */
import { describe, it, expect } from 'vitest';
import {
  CONVERSATION_CONTROL_COMMAND_CONTRACT,
  conversationControlCommandDigest,
  type ConversationControlCommandIdentity,
} from '@/db/repositories/conversation-control-repo.js';

const base: ConversationControlCommandIdentity = {
  kind: 'pause',
  control_id: '0b8f1f6e-0f4e-4a0e-9d7b-2d6a4c1e9f10',
  expected_epoch: '0',
  requested_by_app_user_id: 'operador-1',
  reason_code: 'operator_takeover',
  resume_policy: null,
  request_payload: { note: 'cliente pediu atendente', canal: 'whatsapp' },
};

const digest = (over: Partial<ConversationControlCommandIdentity> = {}) =>
  conversationControlCommandDigest({ ...base, ...over });

describe('conversationControlCommandDigest — a identidade do §8.3.2', () => {
  it('1. cabe no CHECK da 141: 64 hex puros, sem prefixo', () => {
    expect(digest()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('2. é determinística', () => {
    expect(digest()).toBe(digest());
  });

  it.each([
    ['kind', { kind: 'resume' as const }],
    ['control_id', { control_id: '5c2d7e8a-3b1f-4c6d-8e9a-1f2b3c4d5e6f' }],
    ['expected_epoch', { expected_epoch: '1' }],
    ['requested_by_app_user_id', { requested_by_app_user_id: 'operador-2' }],
    ['reason_code', { reason_code: 'safety_review' }],
    ['resume_policy', { resume_policy: 'future_only' }],
    ['request_payload', { request_payload: { note: 'outra coisa', canal: 'whatsapp' } }],
  ])('3. mudar `%s` muda a identidade', (_campo, over) => {
    expect(digest(over)).not.toBe(digest());
  });

  it('4. a ordem das chaves do payload NÃO muda a identidade (é canônica)', () => {
    expect(digest({ request_payload: { canal: 'whatsapp', note: 'cliente pediu atendente' } })).toBe(
      digest(),
    );
  });

  it('5. payload ausente e payload nulo são a mesma identidade', () => {
    expect(digest({ request_payload: undefined })).toBe(digest({ request_payload: null }));
  });

  it('6. a identidade não é só o payload — o defeito original', () => {
    // O hash antigo era o digest canônico do payload sozinho. Igualdade aqui
    // significaria que os outros campos não entram.
    expect(
      digest({ control_id: '5c2d7e8a-3b1f-4c6d-8e9a-1f2b3c4d5e6f', requested_by_app_user_id: 'x' }),
    ).not.toBe(digest());
  });

  it('7. vetor fixo: a composição da identidade não muda em silêncio', () => {
    // Calculado FORA desta implementação: sha256 de
    // "maia.canonical-json/v1\n" + o JSON canônico escrito à mão (chaves em
    // ordem de code unit, inclusive dentro do payload). Pega o que os casos 3
    // não pegam — o contrato sair do digest, um campo trocar de nome. Mudar a
    // composição invalida os hashes já gravados (um retry que atravesse o deploy
    // vira conflito), então a mudança precisa ser deliberada e trocar este valor.
    expect(CONVERSATION_CONTROL_COMMAND_CONTRACT).toBe('maia.conversation_control_command/v1');
    expect(digest()).toBe('5bed589afb3ac25cecdcf23de15404cbe731b9b6d47b85c7b205dfc1f6d7c0f5');
  });
});
