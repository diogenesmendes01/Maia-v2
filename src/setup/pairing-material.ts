/**
 * Issue #518 — material EFÊMERO de pareamento (QR / código de 8 dígitos).
 *
 * O QR e o código provam posse de uma linha WhatsApp: quem os lê consegue
 * conectar um aparelho. Logo, eles são credenciais de curtíssima vida e:
 *   - NUNCA aparecem em URL, query string, redirect, referer ou access log;
 *   - NUNCA são serializados em `audit_log` / `admin_audit_log`;
 *   - NUNCA são persistidos em claro.
 *
 * Como o console (Next.js) e o runtime (Baileys) são processos distintos, o
 * material precisa atravessar o Postgres compartilhado. A travessia usa o
 * MESMO envelope AES-256-GCM versionado do staging de inbound (092,
 * `gateway/staging-crypto.ts`) — um único keyring para "segredo curto em
 * repouso", com rotação por `key_id`.
 *
 * O QR já viaja RENDERIZADO como data URI PNG: quem tem `qrcode` é o runtime,
 * e um `data:` URI é conteúdo inline (não gera request, não vaza em referer
 * nem em access log) — diferente do `/setup/qr.png?token=…` legado.
 *
 * Fail-closed: sem keyring configurado, `sealPairingMaterial` LANÇA. O
 * chamador converte isso em erro tipado para o operador em vez de degradar
 * para texto em claro.
 */
import {
  parseKeyring,
  sealEnvelope,
  openEnvelope,
  type StagingKeyring,
} from '../gateway/staging-crypto.js';
import { TypedError } from '../lib/utils.js';

export type PairingMaterial =
  | { kind: 'qr'; png_data_uri: string }
  | { kind: 'code'; code: string };

/**
 * TTL do material apresentado ao operador. Deliberadamente MENOR que o TTL da
 * PairingSession (15 min): um QR já rotacionado pelo Baileys não deve
 * continuar visível, e um código expirado precisa sumir da tela.
 */
export const PAIRING_MATERIAL_TTL_MS = 90_000;

/**
 * O keyring está configurado? Consultado pelas superfícies de LEITURA para
 * degradar com uma mensagem honesta ("pareamento indisponível: keyring não
 * configurado") em vez de estourar no meio de uma listagem.
 */
export function isPairingMaterialConfigured(): boolean {
  try {
    parseKeyring();
    return true;
  } catch {
    return false;
  }
}

function keyring(): StagingKeyring {
  try {
    return parseKeyring();
  } catch (err) {
    throw new TypedError(
      'pairing_material_keyring_unset',
      'MAIA_STAGING_KEYRING/MAIA_STAGING_ACTIVE_KEY_ID precisam estar configurados ' +
        'no runtime E no console: o QR/código de pareamento só trafega cifrado.',
      { cause: (err as Error).message },
    );
  }
}

export function sealPairingMaterial(material: PairingMaterial): {
  envelope: Buffer;
  key_id: string;
} {
  const ring = keyring();
  const envelope = sealEnvelope(Buffer.from(JSON.stringify(material), 'utf8'), ring);
  return { envelope, key_id: ring.activeKeyId };
}

/**
 * Decifra. Lança `pairing_material_unreadable` quando o envelope não abre
 * (chave rotacionada e removida, corrupção, tag inválida) — o chamador trata
 * como "material indisponível", nunca como conteúdo parcial.
 */
export function openPairingMaterial(envelope: Buffer): PairingMaterial {
  const ring = keyring();
  let plain: Buffer;
  try {
    plain = openEnvelope(envelope, ring);
  } catch (err) {
    throw new TypedError(
      'pairing_material_unreadable',
      'envelope de pareamento não pôde ser aberto',
      { cause: (err as Error).message },
    );
  }
  const parsed = JSON.parse(plain.toString('utf8')) as PairingMaterial;
  if (parsed.kind === 'qr' && typeof parsed.png_data_uri === 'string') return parsed;
  if (parsed.kind === 'code' && typeof parsed.code === 'string') return parsed;
  throw new TypedError(
    'pairing_material_unreadable',
    'envelope de pareamento com formato desconhecido',
    {},
  );
}
