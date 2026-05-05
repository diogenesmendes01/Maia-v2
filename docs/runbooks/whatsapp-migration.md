# Runbook — Migração Baileys → WhatsApp Business Cloud API

> Status: planejamento. Não há gatilho ativo. Executar quando um dos critérios em "Quando migrar" for atingido.

Este runbook documenta a decisão e o procedimento para mover o gateway WhatsApp da Maia de [Baileys](https://github.com/WhiskeySockets/Baileys) (cliente não-oficial via WebSocket) para a [WhatsApp Business Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api) (oficial, hospedada pela Meta).

---

## 1. Por que migrar

Baileys é o caminho certo para o estágio atual: zero custo por mensagem, zero burocracia, número de celular comum. Só faz sentido migrar quando o custo de continuar passa a ser maior que o custo de mudar.

Razões objetivas para migrar:

- **Risco de banimento.** Baileys faz engenharia reversa do protocolo do WhatsApp Web. A Meta não promete que continuará funcionando; bans acontecem por heurística (volume, padrão de envio, denúncias). Um ban derruba o número e leva junto a sessão Baileys.
- **Não é oficial.** Mudanças no protocolo pelo lado da Meta podem quebrar o cliente sem aviso. O time Baileys é responsivo, mas a janela entre quebra e fix é dor operacional para a Maia.
- **Sem suporte da Meta.** Quando algo dá errado em produção (entrega falhando, mídia corrompida, conta marcada), não há canal oficial. Com a Cloud API há painel, logs, suporte, e SLA.
- **Templates / mensagens iniciadas pelo negócio.** Cloud API permite mensagens fora da janela de 24h via templates aprovados. Baileys não tem esse conceito; tudo conta como mensagem comum.
- **Verificação e selo de negócio.** Cloud API permite registrar a Maia como WhatsApp Business com nome, descrição e selo verde verificado. Aumenta confiança do interlocutor e reduz risco de denúncia/ban.

Razões objetivas para **não** migrar agora:

- Custo passa de zero para por-conversa.
- Precisa de número novo registrado na Meta (não dá para usar um chip comum); migração de número exige cuidado.
- Templates aprovados pela Meta têm latência de revisão (horas a dias).
- Webhooks HTTPS exigem domínio + certificado público alcançável, não só rede interna do VPS.

---

## 2. Custos

A Cloud API tem precificação **por conversa** (janela de 24h iniciada por usuário ou negócio), não por mensagem. Categorias atuais (referência — confirmar no painel Meta na hora):

| Categoria | Faixa por conversa (BRL/USD ref.) |
|-----------|------------------------------------|
| Service (resposta dentro da janela do usuário) | gratuita até cota mensal, depois ~US$ 0.005-0.015 |
| Utility (notificação transacional iniciada pelo negócio) | ~US$ 0.005-0.030 |
| Authentication (OTP, 2FA) | ~US$ 0.01-0.05 |
| Marketing (promocional) | ~US$ 0.05-0.08 |

Brasil hoje fica na faixa baixa-média; mercados como EUA, UK e DE são mais caros. **Valores de referência. Confirmar no painel Meta no momento da decisão.**

Estimativa para a Maia (uso interno, ~5 interlocutores ativos, baixo volume):

- 50-200 conversas/dia, quase tudo Service (resposta a pergunta do usuário).
- Service tem cota mensal gratuita (mil conversas/mês na maioria dos casos).
- Utility entra para briefings, alertas de vencimento, follow-ups proativos.

Estimativa: **US$ 5-30/mês** dependendo de quanto a Maia inicia mensagem proativa. Se a maioria do tráfego for resposta dentro da janela do usuário, fica perto de zero.

---

## 3. Mudanças de código

Visão de alto nível. Detalhamento na PR de implementação.

### 3.1 Gateway

- `src/gateway/baileys.ts` → `src/gateway/whatsapp-cloud.ts`. Mantém a mesma interface pública (`onMessage`, `sendText`, `sendMedia`, `sendVoice`) para não tocar `agent/core.ts` nem tools.
- Conexão muda de WebSocket persistente para **HTTP request/response stateless**:
  - **Saída:** `POST https://graph.facebook.com/v{N}/{phone-number-id}/messages` com bearer token.
  - **Entrada:** webhook HTTPS recebido em endpoint público da Maia (ex.: `POST /webhook/whatsapp`).

### 3.2 Webhooks em vez de socket

- Adicionar rota Fastify pública: `POST /webhook/whatsapp` + `GET /webhook/whatsapp` (verification handshake).
- Validar assinatura `X-Hub-Signature-256` com app secret antes de processar payload.
- Endpoint público implica:
  - DNS apontando para o VPS.
  - Certificado TLS válido (Let's Encrypt via nginx).
  - Regra no `docs/runbooks/setup-nginx.md` para esse path.
- A fila BullMQ (`src/gateway/queue.ts`) continua igual: webhook só faz enqueue do payload bruto.

### 3.3 Mídia

- Recebimento: payload do webhook traz `media_id`, não bytes. Precisa fazer `GET /v{N}/{media-id}` para obter URL temporária, depois `GET` na URL com bearer token para baixar.
- Envio: upload prévio via `POST /v{N}/{phone-number-id}/media`, recebe `media_id`, depois envia mensagem referenciando esse id. Ou usa `link` público (não recomendado para boletos).
- OCR (`parse-boleto`, `parse-image`) e Whisper continuam iguais; só muda a etapa de obter os bytes.

### 3.4 Auth

- Token de longa duração da System User (não o access token de 60 dias do app de teste).
- Guardar em `.env` como `WHATSAPP_ACCESS_TOKEN`. Rotação manual; documentar no runbook.
- `WHATSAPP_PHONE_NUMBER_ID` e `WHATSAPP_BUSINESS_ACCOUNT_ID` também em `.env`.
- Remover dependências `@whiskeysockets/baileys` e `qrcode-terminal` do `package.json` ao final.

### 3.5 Templates

- Mensagens proativas (briefing, alerta, follow-up) que saem fora da janela de 24h precisam ser **templates aprovados pela Meta**.
- Cadastrar templates no painel:
  - `briefing_matinal` (Utility)
  - `vencimento_proximo` (Utility)
  - `followup_pendente` (Utility)
- Cada template tem variáveis posicionais (`{{1}}`, `{{2}}`). Worker preenche e envia.
- Mensagens dentro da janela (resposta a pergunta) seguem como texto livre.

---

## 4. Quando migrar

Gatilhos que disparam a migração (qualquer um basta):

1. **Primeiro incidente de banimento** do número Baileys da Maia (mesmo que reversível).
2. **Volume mensal acima de ~10.000 mensagens** (sugestão; ajustar conforme experiência). Acima desse patamar o risco-Baileys cresce desproporcionalmente.
3. **Necessidade de mensagem proativa em massa** que não cabe na janela de 24h (ex.: notificar todos os contadores ao mesmo tempo).
4. **Quebra do protocolo Baileys** que dure mais de 48h sem fix upstream.
5. **Cliente externo paga** (qualquer fluxo onde a Maia atende terceiros pagantes), porque aí o custo de downtime sobe.

Se nada disso acontecer, **não migrar.** Baileys tá ok para uso interno.

---

## 5. Checklist de migração

Ordem importa. Não pular o shadow run.

### Pré-requisitos

- [ ] Conta Meta Business verificada.
- [ ] Número de telefone novo (ou portado) registrado na conta Business — **não pode ser o mesmo chip que rodou Baileys**, porque um número não pode estar nos dois ao mesmo tempo.
- [ ] App Meta criado, produto WhatsApp adicionado, System User com token de longa duração gerado.
- [ ] Domínio público + TLS apontando para o VPS (`whatsapp.<dominio>`).
- [ ] Templates Utility cadastrados e aprovados (esperar review).

### Implementação

- [ ] Branch `feat/whatsapp-cloud-gateway`.
- [ ] Adicionar `src/gateway/whatsapp-cloud.ts` com a mesma interface de `baileys.ts`.
- [ ] Adicionar rota `/webhook/whatsapp` no Fastify (verification + validação de assinatura).
- [ ] Adicionar variáveis em `src/config/env.ts`: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`.
- [ ] Tests unit do parser de webhook (cobrir `messages`, `statuses`, `media`).
- [ ] Atualizar `setup-nginx.md` com bloco do webhook path.

### Shadow run (manter Baileys em paralelo)

- [ ] Subir Cloud API gateway no novo número, **sem desligar Baileys**.
- [ ] Avisar Mendes; ele manda mensagens de teste para o novo número.
- [ ] Observar por 1 semana: entregas, latência, mídia, áudio, cota gratuita consumida, custo real.
- [ ] Comparar logs Baileys vs Cloud API: mesma mensagem deve produzir mesmo registro em `mensagens` e mesma decisão do agente.

### Cutover

- [ ] Avisar todos os interlocutores (Mendes, esposa, contadores, funcionários) do novo número com 1 semana de antecedência.
- [ ] No dia do cutover: parar de processar entrada do Baileys (manter sessão viva só para responder "este número está sendo desativado, fale com {novo}"`).
- [ ] Apontar workers proativos (briefing, alertas) para o novo gateway.
- [ ] Monitorar 48h: webhook delivery, taxa de falha, custo real-vs-estimado.
- [ ] Após 7 dias estável: remover `gateway/baileys.ts`, dependências e código morto. Remover número antigo da rotação.

### Rollback

Se algo crítico quebrar nas primeiras 48h:

- [ ] Reativar Baileys (sessão deve estar dormente, não morta).
- [ ] Reverter aviso aos interlocutores.
- [ ] Investigar antes de tentar de novo. Não cutover às pressas.

---

## 6. Referências

- [WhatsApp Cloud API — overview](https://developers.facebook.com/docs/whatsapp/cloud-api)
- [Pricing](https://developers.facebook.com/docs/whatsapp/pricing)
- [Webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks)
- [Message templates](https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates)
