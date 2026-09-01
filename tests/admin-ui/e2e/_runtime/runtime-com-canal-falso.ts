#!/usr/bin/env tsx
/**
 * O SEGUNDO PROCESSO do job do console — issue #623.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que ele existe
 * ─────────────────────────────────────────────────────────────────────────
 * O console não gera QR nem código de pareamento: `channelLines.startPairing`
 * grava um COMANDO em `channel_line_state` e devolve. Quem abre a sessão,
 * produz o material e o cifra com `MAIA_STAGING_KEYRING` é o worker
 * `channel_pairing`, que vive no RUNTIME. Enquanto o job subia um processo
 * só, quatro casos da jornada de pareamento ficavam fora do gate.
 *
 * Este entrypoint sobe o runtime de verdade — `src/index.ts`, o mesmo
 * `main()` do container `app` — no papel `scheduler` e com o grupo de jobs
 * `channel`. Nada é reimplementado aqui: o que ele faz, e a única coisa que
 * faz, é INSTALAR o adapter de canal falso antes de o
 * `LineSessionManager` existir.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que um ENTRYPOINT, e não uma chave de configuração
 * ─────────────────────────────────────────────────────────────────────────
 * Provar posse da linha é o que AUTORIZA a linha a rotear. Uma chave de
 * contrato que trocasse o adapter seria configuração documentada do produto:
 * um interruptor que desliga a prova de posse, alcançável por env var em
 * qualquer container. Sendo um entrypoint, o caminho até o adapter falso é
 * "executar outro programa" — e este programa não está na imagem de
 * produção (o Dockerfile copia `dist/`, `migrations/`, `scripts/` e `src/`;
 * `tests/` não entra). `tests/unit/gateway/pairing-adapter-seam.spec.ts`
 * mantém as duas afirmações verdadeiras contra o disco.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O ambiente vem de QUEM CHAMA
 * ─────────────────────────────────────────────────────────────────────────
 * `scripts/admin-ui-e2e.sh` o executa com o MESMO `DATABASE_URL`,
 * `REDIS_URL` e `MAIA_STAGING_KEYRING` do console — é essa partilha que faz
 * o envelope que o runtime sela abrir no console — e acrescenta
 * `MAIA_PROCESS_ROLE=scheduler` + `MAIA_SCHEDULER_GROUPS=channel`. O boot
 * fail-closed do subset `runtime` acontece normalmente, no import de
 * `@/config/env.js` lá dentro: configuração torta reprova aqui, não três
 * camadas adiante.
 *
 * Uso: `npx tsx tests/admin-ui/e2e/_runtime/runtime-com-canal-falso.ts`
 */
import { installPairingChannelAdapter } from '@/gateway/line-session-manager.js';
import { adaptadorDeCanalFalso } from './adaptador-de-canal-falso.js';

installPairingChannelAdapter(adaptadorDeCanalFalso());

// `import()` DINÂMICO e depois da instalação, de propósito: `src/index.ts`
// executa `main()` no load, e `main()` chega ao `getLineSessionManager()`.
// Um import estático seria içado para o topo do módulo e o manager nasceria
// com o Baileys — o adapter falso ficaria instalado e inerte, que é a falha
// silenciosa que `installPairingChannelAdapter` recusa.
await import('@/index.js');
