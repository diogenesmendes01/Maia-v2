import { sha256, bucket5min, canonicalize, stripDiacritics } from '@/lib/utils.js';

export function normalizePayload(p: unknown): string {
  const c = canonicalize(p) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...c };
  if ('valor' in out && (typeof out.valor === 'number' || typeof out.valor === 'string')) {
    out.valor_centavos = Math.round(Number(out.valor) * 100);
    delete out.valor;
  }
  if ('descricao' in out && typeof out.descricao === 'string') {
    out.descricao = stripDiacritics(out.descricao.trim().toLowerCase());
  }
  if ('data_competencia' in out && typeof out.data_competencia === 'string') {
    out.data_competencia = out.data_competencia.slice(0, 10);
  }
  return sha256(JSON.stringify(out));
}

export function computeIdempotencyKey(input: {
  pessoa_id: string;
  entity_id: string;
  tool_name: string;
  operation_type: string;
  payload: unknown;
  file_sha256?: string;
  timestamp?: Date;
}): string {
  if (input.file_sha256) {
    return sha256(
      [
        input.pessoa_id,
        input.entity_id,
        input.tool_name,
        input.operation_type,
        input.file_sha256,
      ].join('|'),
    );
  }
  const bucket = bucket5min(input.timestamp ?? new Date());
  return sha256(
    [
      input.pessoa_id,
      input.entity_id,
      input.tool_name,
      input.operation_type,
      normalizePayload(input.payload),
      bucket,
    ].join('|'),
  );
}
