/**
 * P8.5 — formatting + redaction helpers used by React components.
 */

export function formatDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString('pt-BR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelativeAge(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  const ms = Date.now() - date.getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

export function ageBucket(d: Date | string): 'lt_1h' | 'lt_24h' | 'lt_7d' | 'lt_30d' | 'older' {
  const date = typeof d === 'string' ? new Date(d) : d;
  const ms = Date.now() - date.getTime();
  const hours = ms / (60 * 60 * 1000);
  if (hours < 1) return 'lt_1h';
  if (hours < 24) return 'lt_24h';
  const days = hours / 24;
  if (days < 7) return 'lt_7d';
  if (days < 30) return 'lt_30d';
  return 'older';
}

/**
 * Redact PII-shaped fields. Used by trace renderers when user lacks an
 * active debug_snapshot_grant.
 */
export function redactValue(key: string, value: unknown): unknown {
  const SENSITIVE_KEY_PATTERNS = /(email|phone|cpf|cnpj|password|token|api[_-]?key|ssn)/i;
  if (SENSITIVE_KEY_PATTERNS.test(key)) return '[REDACTED]';
  if (typeof value === 'string' && value.length > 200) {
    return value.slice(0, 100) + '... [truncated]';
  }
  return value;
}

export function redactPacket(packet: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(packet)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redactPacket(v as Record<string, unknown>);
    } else {
      out[k] = redactValue(k, v);
    }
  }
  return out;
}
