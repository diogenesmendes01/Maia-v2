/**
 * Estado de conexão do Baileys, num módulo SEM dependências — issue #726.
 *
 * `baileys.ts` é a raiz de um grafo de 257 arquivos de `src/` (3,4 MB de TS,
 * medido com o metafile do esbuild): repositórios, agente, setup, lifecycle.
 * Dois leitores só querem saber "está conectado?" e "quando caiu?":
 *
 *   - `src/observability/register.ts`, no boot, para os gauges de sessão do
 *     WhatsApp (`maia_whatsapp_sessions`, `maia_whatsapp_session_age_seconds`);
 *   - qualquer spec que passe por `registerRuntimeObservability()`.
 *
 * Antes deste módulo, `register.ts` fazia `await import('@/gateway/baileys.js')`
 * DENTRO de `registerRuntimeObservability()` — o import era "lazy" no sentido
 * de não ser de topo, mas a função o esperava, então todo caso de teste que
 * prova a fiação do boot pagava o grafo inteiro: 3,4–3,9 s isolado com cache
 * quente, 8–12 s na suíte completa com 4 workers disputando o transform do
 * Vite (medição na PR da #726).
 *
 * Aqui vive só o estado. `baileys.ts` escreve nele nos mesmos quatro pontos
 * de antes (`connection.update` open/close e o seam de teste) e continua
 * reexportando `isBaileysConnected` / `getLastDisconnectAt`, então nenhum
 * chamador existente muda. Quem só precisa do estado importa este arquivo.
 */

let connected = false;
let lastDisconnectAt: Date | null = null;

/** `true` entre `connection.update: open` e o `close` seguinte. */
export function isBaileysConnected(): boolean {
  return connected;
}

/** Instante do último `close`; `null` se a sessão nunca caiu neste processo. */
export function getLastDisconnectAt(): Date | null {
  return lastDisconnectAt;
}

/**
 * Escrita — só `baileys.ts` (e o seam de teste dele) deve chamar. Marca a
 * queda com o instante da transição, que é o que a série de idade da sessão
 * mede.
 */
export function _setBaileysConnected(value: boolean): void {
  connected = value;
}

export function _markBaileysDisconnected(at: Date = new Date()): void {
  connected = false;
  lastDisconnectAt = at;
}
