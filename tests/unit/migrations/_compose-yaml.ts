/**
 * Leitor mínimo dos dois arquivos de Compose deste repositório (issue #516).
 *
 * O PARSER MUDOU DE CASA (issue #572). Ele nasceu aqui, em `tests/`, quando o
 * único consumidor era um guard de teste. A #572 acrescentou um SEGUNDO
 * consumidor que roda em produção — `scripts/config.ts preflight`, o passo que
 * `docs/runbooks/deploy-prod.md` §1 manda rodar antes do `up` — e um parser em
 * `tests/` não pode ser importado por um script de operação.
 *
 * Então o corpo foi movido VERBATIM para `src/config/compose-env.ts`, junto
 * com a composição do ambiente efetivo, e este arquivo virou o adaptador que
 * as specs de #516 já usavam: mesmo nome, mesma assinatura, uma leitura de
 * disco a mais (o módulo de `src/` é puro e recebe TEXTO).
 *
 * O motivo de não haver duas cópias é o mesmo motivo de o parser ser estrito:
 * duas derivações de "o que o container recebe" são duas respostas possíveis,
 * e a do teste é justamente a que ninguém roda em produção.
 */
import { readFileSync } from 'node:fs';
import { parseComposeText, type ComposeNode } from '@/config/compose-env.js';

export {
  ComposeParseError,
  asMap,
  asString,
  interpolate,
  parseComposeText,
  type ComposeNode,
} from '@/config/compose-env.js';

/** Parse a Compose file from disk. Throws on anything it does not understand. */
export function parseComposeFile(path: string): Record<string, ComposeNode> {
  return parseComposeText(readFileSync(path, 'utf8'), path);
}
