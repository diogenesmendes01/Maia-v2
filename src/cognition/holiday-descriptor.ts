/**
 * Parser canônico do descriptor de feriado usado como `pattern_descriptor` no
 * payload das capability_proposals (proposal.capability_type='holiday').
 *
 * Formato:
 *   holiday:<name_slug>:<month>/<day>:<type>:<entidade_id|"global">
 *
 * Exemplos:
 *   holiday:imaculada-conceicao:12/8:municipal:550e8400-e29b-41d4-a716-446655440000
 *   holiday:dia-da-padaria:5/12:national:global
 *
 * name_slug: lowercase, ASCII-fold, espaços → hífens.
 */
export type HolidayProposalType =
  | 'national'
  | 'state'
  | 'municipal'
  | 'entity_custom'
  | 'holding_recess';

export interface HolidayDescriptorPayload {
  name: string;
  month: number;
  day: number;
  type: HolidayProposalType;
  entidade_id: string; // UUID ou "global"
  uf?: string;
  cidade?: string;
  year?: number;
  pattern_descriptor: string;
}

const TYPE_RE = /^(national|state|municipal|entity_custom|holding_recess)$/;

export function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    // Combining diacritical marks (U+0300..U+036F)
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function buildHolidayDescriptor(args: {
  name: string;
  month: number;
  day: number;
  type: HolidayProposalType;
  entidade_id: string;
}): string {
  return `holiday:${slugifyName(args.name)}:${args.month}/${args.day}:${args.type}:${args.entidade_id}`;
}

export function parseHolidayDescriptor(s: string): {
  descriptor: string;
  payload: HolidayDescriptorPayload;
} {
  const m = s.match(
    /^holiday:([a-z0-9-]+):(\d{1,2})\/(\d{1,2}):(national|state|municipal|entity_custom|holding_recess):(.+)$/,
  );
  if (!m) throw new Error(`invalid holiday descriptor: ${s}`);
  const [, name, monthStr, dayStr, type, entidade_id] = m;
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (month < 1 || month > 12) throw new Error(`invalid month: ${month}`);
  if (day < 1 || day > 31) throw new Error(`invalid day: ${day}`);
  if (!TYPE_RE.test(type!)) throw new Error(`invalid type: ${type}`);
  return {
    descriptor: s,
    payload: {
      name: name!,
      month,
      day,
      type: type as HolidayProposalType,
      entidade_id: entidade_id!,
      pattern_descriptor: s,
    },
  };
}
