/**
 * seed-holidays.ts — popula tabela holidays com feriados nacionais (fixos +
 * móveis 2025-2035) + dataset regional curado (state + municipal).
 *
 * Uso:
 *   tsx scripts/seed-holidays.ts [--tenant <id>] [--start <year>] [--end <year>]
 *
 * Sem --tenant: seeda todos os tenants.
 * Sem --start/--end: range default 2025..2035.
 *
 * Idempotente: ON CONFLICT DO NOTHING via UNIQUE INDEX holidays_unique_idem.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../src/db/client.js';
import { holidays, tenants } from '../src/db/schema.js';
import { NATIONAL_FIXED, nationalMovingHolidays } from '../src/lib/national-holidays.js';

interface SeedRow {
  name: string;
  month: number;
  day: number;
  year: number | null;
  type: string;
  uf: string | null;
  cidade: string | null;
}

function buildRowsForYear(year: number): SeedRow[] {
  const out: SeedRow[] = [];
  for (const f of NATIONAL_FIXED) {
    out.push({
      name: f.name,
      month: f.month,
      day: f.day,
      year: null, // recorrente
      type: 'national',
      uf: null,
      cidade: null,
    });
  }
  for (const m of nationalMovingHolidays(year)) {
    out.push({
      name: m.name,
      month: m.date.getUTCMonth() + 1,
      day: m.date.getUTCDate(),
      year, // móveis variam por ano → fica preso ao ano
      type: 'national',
      uf: null,
      cidade: null,
    });
  }
  return out;
}

function buildRegionalRows(): SeedRow[] {
  const file = join(process.cwd(), 'scripts/holidays-data.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as {
    state: Array<{ name: string; uf: string; month: number; day: number }>;
    municipal: Array<{ name: string; uf: string; cidade: string; month: number; day: number }>;
  };
  const out: SeedRow[] = [];
  for (const s of raw.state) {
    out.push({
      name: s.name,
      month: s.month,
      day: s.day,
      year: null,
      type: 'state',
      uf: s.uf,
      cidade: null,
    });
  }
  for (const m of raw.municipal) {
    out.push({
      name: m.name,
      month: m.month,
      day: m.day,
      year: null,
      type: 'municipal',
      uf: m.uf,
      cidade: m.cidade,
    });
  }
  return out;
}

export async function seedNationalsForTenant(
  tenant_id: string,
  startYear = 2025,
  endYear = 2035,
): Promise<{ inserted: number; tenant_id: string }> {
  let inserted = 0;
  // Regional (year=null, único por tenant)
  const regional = buildRegionalRows();
  for (const r of regional) {
    const result = await db
      .insert(holidays)
      .values({
        tenant_id,
        name: r.name,
        month: r.month,
        day: r.day,
        year: r.year,
        type: r.type,
        uf: r.uf,
        cidade: r.cidade,
        status: 'ativo',
        source: 'seed',
      })
      .onConflictDoNothing()
      .returning({ id: holidays.id });
    inserted += result.length;
  }
  // Nationals
  for (let y = startYear; y <= endYear; y++) {
    const rows = buildRowsForYear(y);
    for (const r of rows) {
      const result = await db
        .insert(holidays)
        .values({
          tenant_id,
          name: r.name,
          month: r.month,
          day: r.day,
          year: r.year,
          type: r.type,
          uf: r.uf,
          cidade: r.cidade,
          status: 'ativo',
          source: 'seed',
        })
        .onConflictDoNothing()
        .returning({ id: holidays.id });
      inserted += result.length;
    }
  }
  return { inserted, tenant_id };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const tenantIdx = argv.indexOf('--tenant');
  const startIdx = argv.indexOf('--start');
  const endIdx = argv.indexOf('--end');
  const startYear = startIdx >= 0 ? parseInt(argv[startIdx + 1]!, 10) : 2025;
  const endYear = endIdx >= 0 ? parseInt(argv[endIdx + 1]!, 10) : 2035;

  let tenantList: string[];
  if (tenantIdx >= 0) {
    tenantList = [argv[tenantIdx + 1]!];
  } else {
    const rows = await db.select({ id: tenants.id }).from(tenants);
    tenantList = rows.map((r) => r.id);
  }

  console.log(`> seeding ${tenantList.length} tenant(s), years ${startYear}..${endYear}`);
  let total = 0;
  for (const tid of tenantList) {
    const r = await seedNationalsForTenant(tid, startYear, endYear);
    console.log(`  ${tid}: ${r.inserted} rows inserted`);
    total += r.inserted;
  }
  console.log(`> done. total inserted: ${total}`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
