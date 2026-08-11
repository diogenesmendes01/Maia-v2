/**
 * Sonda sintética (spec §1.3 / review P1-C) — GATE do sink de outbound.
 *
 * A impossibilidade de envio físico para um canal `is_synthetic` precisa valer
 * INDEPENDENTE da flag `MAIA_SYNTHETIC_PROBE` e sobreviver ao kill-switch/
 * restart: com a flag off, um job antigo ainda na fila (BullMQ) pode chegar a
 * `buildOutput` e, sem o gate, cair no transporte Baileys real do canal de
 * sonda. Por isso o gate NÃO depende da flag.
 *
 * O gate carrega, no BOOT (sempre, antes do worker de agente), o conjunto dos
 * `channels.id` marcados `is_synthetic=true`. `buildOutput` intercepta QUALQUER
 * envio cujo `channel_id` esteja nesse conjunto. Keying por `channel_id` (o
 * portador do marcador imutável) é preciso e sem blast radius — só o canal
 * sintético exato é neutralizado, nunca um canal real. O conjunto é imutável em
 * runtime (is_synthetic só é setado no seed da migração) e recarregado a cada
 * boot.
 */

let syntheticChannelIds: ReadonlySet<string> = new Set();

/** Carrega o conjunto de canais sintéticos (chamado no boot, sempre). */
export function loadSyntheticChannelIds(ids: Iterable<string>): void {
  syntheticChannelIds = new Set(ids);
}

/** O canal é sintético? (lookup O(1), sem flag, sem DB por envio). */
export function isSyntheticChannel(channel_id: string): boolean {
  return syntheticChannelIds.has(channel_id);
}

export function syntheticChannelCount(): number {
  return syntheticChannelIds.size;
}

/** Test-only: define o conjunto entre casos. */
export function _setSyntheticChannelIdsForTests(ids: Iterable<string>): void {
  syntheticChannelIds = new Set(ids);
}
