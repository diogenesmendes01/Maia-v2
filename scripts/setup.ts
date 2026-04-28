import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { config } from '@/config/env.js';
import {
  pessoasRepo,
  permissoesRepo,
  entidadesRepo,
  contasRepo,
  selfStateRepo,
} from '@/db/repositories.js';
import { db } from '@/db/client.js';
import { self_state } from '@/db/schema.js';
import { sql } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { normalizePhoneBR } from '@/lib/brazilian.js';

const rl = readline.createInterface({ input, output });
const ask = (q: string) => rl.question(q + ' ');

async function ensureSelfState() {
  const existing = await selfStateRepo.getActive();
  if (existing) return;
  // Load v0 prompt from file
  const promptPath = 'src/identity/maia-prompt.md';
  const text = await readFile(promptPath, 'utf8').catch(() => 'Você é a Maia.');
  await db.insert(self_state).values({ versao: 1, system_prompt: text, ativa: true });
  console.log('  + self_state v1 created');
}

async function ensureOwner() {
  let owner = await pessoasRepo.findByPhone(config.OWNER_TELEFONE_WHATSAPP);
  if (owner) {
    console.log(`  = owner already exists: ${owner.nome}`);
    return owner;
  }
  console.log('  + creating owner from .env');
  owner = await pessoasRepo.create({
    nome: config.OWNER_NOME,
    apelido: null,
    telefone_whatsapp: config.OWNER_TELEFONE_WHATSAPP,
    tipo: 'dono',
    email: null,
    observacoes: null,
    preferencias: {},
    modelo_mental: {},
    status: 'ativa',
  });
  console.log(`  + owner ${owner.nome} created`);
  return owner;
}

async function importEntities(filePath: string | null, owner_id: string) {
  if (!filePath) return [];
  const text = await readFile(filePath, 'utf8');
  if (filePath.endsWith('.json')) {
    const json = JSON.parse(text);
    const created = [];
    for (const ent of json.entities ?? []) {
      const existing = (await entidadesRepo.list()).find((e) => e.nome === ent.nome);
      if (existing) {
        console.log(`  = entidade ${ent.nome} já existe`);
        created.push(existing);
        continue;
      }
      const e = await entidadesRepo.create({
        nome: ent.nome,
        tipo: ent.tipo,
        documento: ent.documento ?? null,
        status: 'ativa',
        cor: ent.cor ?? null,
        observacoes: null,
        metadata: {},
      });
      console.log(`  + entidade ${e.nome}`);
      await permissoesRepo.create({
        pessoa_id: owner_id,
        entidade_id: e.id,
        papel: 'dono',
        profile_id: 'dono_total',
        acoes_permitidas: ['*'],
        limites: {},
        status: 'ativa',
      });
      created.push(e);
    }
    for (const c of json.contas_bancarias ?? []) {
      const ent = created.find((e) => e.nome === c.entidade);
      if (!ent) continue;
      await contasRepo.create({
        entidade_id: ent.id,
        banco: c.banco,
        agencia: c.agencia ?? null,
        numero: c.numero ?? null,
        apelido: c.apelido,
        tipo: c.tipo,
        saldo_atual: '0',
        status: 'ativa',
        metadata: {},
      });
      console.log(`  + conta ${c.apelido}`);
    }
    return created;
  }
  console.log('  ! markdown import not implemented; use entities.json');
  return [];
}

async function main() {
  console.log('Maia setup wizard');
  console.log('=================');

  // Verify DB connectivity
  await db.execute(sql`SELECT 1`);
  console.log('  ok db');

  await ensureSelfState();
  const owner = await ensureOwner();

  const fromFile = (await ask('Importar entidades de arquivo? (caminho ou enter para pular)')).trim();
  await importEntities(fromFile || null, owner.id);

  // Co-owner (optional)
  const wantCo = (await ask('Cadastrar co-dona/co-dono agora? (s/N)')).trim().toLowerCase();
  if (wantCo === 's' || wantCo === 'sim' || wantCo === 'y') {
    const nome = (await ask('Nome:')).trim();
    const telRaw = (await ask('Telefone (com DDI):')).trim();
    const tel = normalizePhoneBR(telRaw);
    if (!tel) {
      console.log('  ! telefone inválido — pulando');
    } else if (tel === config.OWNER_TELEFONE_WHATSAPP) {
      console.log('  ! telefone igual ao do owner — pulando');
    } else {
      const exists = await pessoasRepo.findByPhone(tel);
      if (exists) {
        console.log(`  = já cadastrada: ${exists.nome}`);
      } else {
        const co = await pessoasRepo.create({
          nome,
          apelido: null,
          telefone_whatsapp: tel,
          tipo: 'co_dono',
          email: null,
          observacoes: null,
          preferencias: {},
          modelo_mental: {},
          status: 'quarentena',
        });
        const ents = await entidadesRepo.list();
        for (const e of ents) {
          await permissoesRepo.create({
            pessoa_id: co.id,
            entidade_id: e.id,
            papel: 'admin',
            profile_id: 'co_dono',
            acoes_permitidas: ['*'],
            limites: {},
            status: 'ativa',
          });
        }
        console.log(`  + co-dona ${co.nome} cadastrada (em quarentena até primeira mensagem)`);
      }
    }
  }

  rl.close();
  console.log('done — agora rode: npm run dev');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
