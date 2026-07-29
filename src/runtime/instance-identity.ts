/**
 * Identidade da INSTÂNCIA do runtime (review PR #528 rodada 2).
 *
 * A posse de linha WhatsApp é distribuída: o socket vive na memória de UM
 * processo, e comandos como `disable`/`repair` precisam ser endereçados a ele.
 * Isso exige que o worker (que reivindica o comando) e o gateway (que segura o
 * socket) concordem, byte a byte, sobre "quem eu sou" — daí a fonte única.
 *
 * Formato `<hostname>:<pid>`, consistente com as identidades de lease que já
 * existiam no repo (`src/scheduling/engine.ts`, `src/scheduling/outbox-drain.ts`)
 * e legível nas queries de diagnóstico do runbook.
 *
 * Por que não `lifecycle.instanceId` (#512): ele é um UUID aleatório por
 * processo — tem a mesma propriedade de unicidade, mas não diz ao operador
 * QUAL container segura a linha, que é justamente a pergunta que se faz ao
 * investigar uma linha que não desliga. Os dois convivem: o `instanceId`
 * identifica o processo na telemetria de ciclo de vida, este identifica o dono
 * de um recurso.
 *
 * Muda a cada restart de propósito: é exatamente assim que uma lease órfã é
 * reconhecida.
 */
import { hostname } from 'node:os';

let cached: string | null = null;

export function runtimeInstanceId(): string {
  cached ??= `${hostname()}:${process.pid}`;
  return cached;
}
