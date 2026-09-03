/**
 * Adapter de canal FALSO da PairingSession — issue #623.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O que ele é, e o que ele NÃO prova
 * ─────────────────────────────────────────────────────────────────────────
 * Ele substitui o Baileys DENTRO do runtime que o job do console sobe, para
 * que a jornada de pareamento possa ser medida ponta a ponta: console →
 * `channel_line_state` → worker `channel_pairing` → `startChannelPairing` →
 * PairingSession → material CIFRADO no Postgres → console decifra e desenha.
 * Tudo isso é código de PRODUÇÃO; o que este arquivo troca é só a borda que
 * fala com o WhatsApp — a #518 proíbe linha real no CI.
 *
 * Ele NÃO prova que a Maia conversa com o WhatsApp. Não emite
 * `connection: 'open'` de propósito, e essa omissão é a parte mais importante
 * do desenho: `open` é o evento que faz `line-pairing.ts` PROMOVER o auth
 * state e ATIVAR o canal. Um adapter falso que emitisse `open` estaria
 * fabricando prova de posse — o fail-open exato que o cabeçalho de
 * `src/gateway/line-session-manager.ts` explica. Aqui o operador vê o QR (ou
 * o código) e nada mais acontece: é a simulação honesta de um aparelho que
 * nunca escaneia.
 *
 * Este arquivo vive sob `tests/` por construção, e não sob `src/` ou
 * `scripts/`: o `Dockerfile` da raiz copia `dist/`, `migrations/`, `scripts/`
 * e `src/` para a imagem — `tests/` não entra. O adapter falso portanto não
 * existe no artefato de produção, e
 * `tests/unit/gateway/pairing-adapter-seam.spec.ts` lê o Dockerfile do disco
 * para manter isso verdadeiro.
 */
import type { WASocket } from '@whiskeysockets/baileys';
import type { PairingChannelAdapter } from '@/gateway/line-session-manager.js';

/**
 * Cadência do QR. O primeiro sai com folga suficiente para que
 * `startPairingSession` já tenha decidido, no MESMO tick, se pediu código —
 * ver `suprimirQr` abaixo. Os seguintes imitam a rotação do Baileys e
 * renovam o TTL de 90s do material na tela.
 */
const PRIMEIRO_QR_MS = 200;
const ROTACAO_QR_MS = 20_000;

/** Código de 8 caracteres, no formato que o WhatsApp devolve (A-Z0-9). */
const CODIGO_FIXO = 'E2EQR518';

type ConnectionUpdate = { qr?: string; connection?: string };

interface SocketFalso {
  ev: { on: (evento: string, handler: (arg: never) => unknown) => void };
  end: (err: Error | undefined) => void;
  user: { id: string } | undefined;
  requestPairingCode: (telefone: string) => Promise<string>;
}

/**
 * Um payload de QR com a MESMA forma do que o Baileys entrega: a string
 * bruta que `qrToPngBuffer` renderiza. Determinístico por canal para que duas
 * linhas não compartilhem material.
 */
function payloadQr(channelId: string, geracao: number): string {
  return `2@e2e-${channelId}-${geracao},fake-adapter,#623`;
}

export function adaptadorDeCanalFalso(): PairingChannelAdapter {
  return {
    open({ channel_id }) {
      const handlers = new Map<string, (arg: never) => unknown>();
      let geracao = 0;
      let suprimirQr = false;
      let encerrado = false;
      let timer: NodeJS.Timeout | null = null;

      const emitir = (u: ConnectionUpdate): void => {
        const h = handlers.get('connection.update');
        if (h) h(u as never);
      };

      const agendarQr = (atrasoMs: number): void => {
        timer = setTimeout(() => {
          if (encerrado) return;
          // `requestPairingCode` é chamado no MESMO tick em que
          // `startPairingSession` registra o handler (o executor da Promise é
          // síncrono), então em `PRIMEIRO_QR_MS` já se sabe qual método o
          // operador escolheu. Emitir QR no fluxo de CÓDIGO faria o worker
          // gravar material `qr` por cima do `code`, e a tela mostraria o
          // artefato errado — uma corrida que o teste leria como bug do
          // console.
          if (suprimirQr) return;
          geracao += 1;
          emitir({ qr: payloadQr(channel_id, geracao) });
          agendarQr(ROTACAO_QR_MS);
        }, atrasoMs);
        // O runtime é um processo de longa duração; ainda assim este timer
        // nunca deve ser o único a segurar o event loop.
        timer.unref();
      };

      const sock: SocketFalso = {
        ev: {
          on: (evento, handler) => {
            handlers.set(evento, handler);
          },
        },
        end: () => {
          encerrado = true;
          if (timer) clearTimeout(timer);
          timer = null;
        },
        // NUNCA preenchido: sem `connection: 'open'` o manager jamais lê
        // `sock.user`, e é isso que impede este adapter de "provar" posse.
        user: undefined,
        requestPairingCode: (telefone: string) => {
          suprimirQr = true;
          // O Baileys devolve o código para o número pedido; o formato é o
          // que a tela formata como `XXXX-XXXX`.
          void telefone;
          return Promise.resolve(CODIGO_FIXO);
        },
      };

      agendarQr(PRIMEIRO_QR_MS);

      return Promise.resolve({
        // O manager usa `ev.on`, `end`, `user` e `requestPairingCode` da
        // superfície gigante do `WASocket`, e nada além. O cast é local a
        // este arquivo de teste — o tipo de produção continua sendo o do
        // Baileys.
        sock: sock as unknown as WASocket,
        saveCreds: () => Promise.resolve(),
      });
    },
  };
}
