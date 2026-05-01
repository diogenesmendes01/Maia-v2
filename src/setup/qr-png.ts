import QRCode from 'qrcode';

/**
 * Convert a Baileys QR string to a 320×320 PNG buffer. Used by
 * `GET /setup/qr.png`. Defaults match WhatsApp's expectation
 * (medium error correction, square output).
 */
export async function qrToPngBuffer(qrString: string): Promise<Buffer> {
  return QRCode.toBuffer(qrString, {
    errorCorrectionLevel: 'M',
    width: 320,
    margin: 1,
  });
}
