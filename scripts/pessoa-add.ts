import { config } from '@/config/env.js';
import { pessoasRepo, permissoesRepo, entidadesRepo, profilesRepo } from '@/db/repositories.js';
import { validatePhoneNumber } from '@/identity/duplicate-detection.js';
import { audit } from '@/governance/audit.js';

function arg(name: string): string | undefined {
  const flag = `--${name}=`;
  for (const a of process.argv) if (a.startsWith(flag)) return a.slice(flag.length);
  return undefined;
}

async function main() {
  const nome = arg('nome');
  const telefone = arg('telefone');
  const profile_id = arg('profile') ?? 'leitor';
  const entidadesArg = arg('entidades') ?? '';
  const limiteStr = arg('limite');

  if (!nome || !telefone) {
    console.error(
      'usage: npm run pessoa:add -- --nome="Joana" --telefone="+55..." --profile=contador_leitura --entidades=E1,E3 --limite=0',
    );
    process.exit(2);
  }

  const validation = await validatePhoneNumber(telefone);
  if (validation.kind !== 'ok') {
    console.error(`phone validation: ${validation.kind}`);
    process.exit(1);
  }

  const profile = await profilesRepo.byId(profile_id);
  if (!profile) {
    console.error(`unknown profile: ${profile_id}`);
    process.exit(1);
  }

  const ents = await entidadesRepo.list();
  const targetIds: string[] = [];
  for (const piece of entidadesArg.split(',').map((s) => s.trim()).filter(Boolean)) {
    const ent = ents.find((e) => e.nome === piece || e.id === piece);
    if (!ent) {
      console.error(`entidade not found: ${piece}`);
      process.exit(1);
    }
    targetIds.push(ent.id);
  }

  const created = await pessoasRepo.create({
    nome,
    apelido: null,
    telefone_whatsapp: validation.canonical,
    tipo: profile.id === 'co_dono' ? 'co_dono' : profile.id === 'contador_leitura' ? 'contador' : 'funcionario',
    email: null,
    observacoes: null,
    preferencias: {},
    modelo_mental: {},
    status: 'quarentena',
  });
  await audit({ acao: 'person_created', alvo_id: created.id, metadata: { nome, profile_id } });

  for (const eid of targetIds) {
    await permissoesRepo.create({
      pessoa_id: created.id,
      entidade_id: eid,
      papel: profile.id === 'co_dono' ? 'admin' : profile.id === 'contador_leitura' ? 'contador' : 'operador',
      profile_id: profile.id,
      acoes_permitidas: profile.acoes,
      limites: limiteStr ? { valor_max: Number(limiteStr) } : {},
      status: 'ativa',
    });
    await audit({ acao: 'permission_changed', alvo_id: created.id, metadata: { entidade_id: eid, profile_id } });
  }

  console.log(`pessoa ${nome} (${validation.canonical}) — em quarentena.`);
  console.log(`Aviso: precisa que ${config.OWNER_NOME} confirme a primeira mensagem dela.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
