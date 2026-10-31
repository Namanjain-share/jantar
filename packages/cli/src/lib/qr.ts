import QRCode from 'qrcode';

/** A QR code for `text` drawn with block characters, for a terminal. */
export async function terminalQr(text: string): Promise<string> {
  const qr = await QRCode.toString(text, { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
  return qr.endsWith('\n') ? qr : `${qr}\n`;
}
