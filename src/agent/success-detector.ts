import { stripDiacritics } from '@/lib/utils.js';

const SUCCESS_PATTERNS = [
  /\bperfeito\b/i,
  /\bexatamente\b/i,
  /\bfechou\b/i,
  /\bcerto\b.*\b(sim|isso)\b/i,
  /\bobrigado\b/i,
  /\bok\b.*\b(pode|mandar|seguir|fechou)\b/i,
  /\bisso\s*(mesmo|ai)\b/i,
];

const CORRECTION_OVERRIDE = [/\bn[ãa]o\b/i, /\berrad/i, /\bcorrige/i];

export function detectSuccess(message: string): boolean {
  if (CORRECTION_OVERRIDE.some((re) => re.test(message))) return false;
  const normalized = stripDiacritics(message.toLowerCase().trim());
  return SUCCESS_PATTERNS.some((re) => re.test(normalized));
}
