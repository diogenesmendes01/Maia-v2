export function parseDecision(reply: string): 'aprova' | 'bloqueia' | null {
  const r = reply.trim().toLowerCase();
  if (/^(sim|libera|aprova|ok|pode)/.test(r)) return 'aprova';
  if (/^(n[ãa]o|bloqueia|bloquear|nao libera)/.test(r)) return 'bloqueia';
  return null;
}

export function maskPhone(tel: string): string {
  if (tel.length < 6) return '***';
  return tel.slice(0, 4) + '*****' + tel.slice(-2);
}
