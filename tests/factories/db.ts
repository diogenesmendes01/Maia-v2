/**
 * Light-weight DB factories for the integration suites. Returns the freshly
 * inserted row so tests can assert on ids. Does not own its own connection —
 * caller passes a pg client (typically inside a transaction).
 */
import { randomInt } from 'node:crypto';
import type pg from 'pg';

export type Ent = { id: string; nome: string; tipo: string };
export type Cta = { id: string; entidade_id: string; apelido: string };
export type Pes = { id: string; telefone_whatsapp: string; tipo: string };
export type Tx = {
  id: string;
  entidade_id: string;
  conta_id: string;
  natureza: string;
  valor: string;
  descricao: string;
};
export type Cp = { id: string; entidade_id: string; nome: string };

export async function mkEntidade(
  client: pg.PoolClient,
  overrides: Partial<{ nome: string; tipo: string }> = {},
): Promise<Ent> {
  const nome = overrides.nome ?? `E-${randomInt(0, 1e9).toString(36)}`;
  const tipo = overrides.tipo ?? 'pj';
  const r = await client.query<Ent>(
    `INSERT INTO entidades(nome, tipo) VALUES ($1, $2) RETURNING id, nome, tipo`,
    [nome, tipo],
  );
  return r.rows[0]!;
}

export async function mkConta(
  client: pg.PoolClient,
  entidade_id: string,
  overrides: Partial<{ apelido: string; banco: string; tipo: string }> = {},
): Promise<Cta> {
  const apelido = overrides.apelido ?? `C-${randomInt(0, 1e9).toString(36)}`;
  const banco = overrides.banco ?? 'X';
  const tipo = overrides.tipo ?? 'cc';
  const r = await client.query<Cta>(
    `INSERT INTO contas_bancarias(entidade_id, banco, apelido, tipo)
     VALUES ($1, $2, $3, $4) RETURNING id, entidade_id, apelido`,
    [entidade_id, banco, apelido, tipo],
  );
  return r.rows[0]!;
}

export async function mkPessoa(
  client: pg.PoolClient,
  overrides: Partial<{ nome: string; tipo: string; status: string }> = {},
): Promise<Pes> {
  // randomInt is process-safe (crypto-backed) and good enough for the cardinality
  // of any single test run. A previous version used a `let` counter which would
  // collide under parallel test execution.
  const phone = `+551199${randomInt(0, 10_000_000).toString().padStart(7, '0')}`;
  const r = await client.query<Pes>(
    `INSERT INTO pessoas(nome, telefone_whatsapp, tipo, status)
     VALUES ($1, $2, $3, $4) RETURNING id, telefone_whatsapp, tipo`,
    [
      overrides.nome ?? `Pessoa ${randomInt(0, 1e9).toString(36)}`,
      phone,
      overrides.tipo ?? 'funcionario',
      overrides.status ?? 'ativa',
    ],
  );
  return r.rows[0]!;
}

export async function mkTransacao(
  client: pg.PoolClient,
  entidade_id: string,
  conta_id: string,
  overrides: Partial<{
    natureza: string;
    valor: number;
    data_competencia: string;
    descricao: string;
    status: string;
  }> = {},
): Promise<Tx> {
  const r = await client.query<Tx>(
    `INSERT INTO transacoes(entidade_id, conta_id, natureza, valor, data_competencia,
       status, descricao, origem)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual')
     RETURNING id, entidade_id, conta_id, natureza, valor, descricao`,
    [
      entidade_id,
      conta_id,
      overrides.natureza ?? 'despesa',
      overrides.valor ?? 10,
      overrides.data_competencia ?? '2026-01-15',
      overrides.status ?? 'paga',
      overrides.descricao ?? 'desc',
    ],
  );
  return r.rows[0]!;
}

export async function mkContraparte(
  client: pg.PoolClient,
  entidade_id: string,
  overrides: Partial<{ nome: string; tipo: string }> = {},
): Promise<Cp> {
  const r = await client.query<Cp>(
    `INSERT INTO contrapartes(entidade_id, nome, tipo)
     VALUES ($1, $2, $3) RETURNING id, entidade_id, nome`,
    [entidade_id, overrides.nome ?? 'cp', overrides.tipo ?? 'outro'],
  );
  return r.rows[0]!;
}
