import QRCode from 'qrcode';
import { useEffect, useRef } from 'react';

/** Draws the otpauth:// URI as a QR code on a canvas (nothing leaves the browser). */
export function TotpQr({ uri }: { uri: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current) return;
    void QRCode.toCanvas(canvas.current, uri, {
      width: 208,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b0f14', light: '#ffffff' },
    });
  }, [uri]);
  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label="QR code for your authenticator app"
      className="size-52 rounded-md bg-white"
    />
  );
}

/** "JBSWY3DPEHPK3PXP" → "JBSW Y3DP EHPK 3PXP" for typing by hand. */
export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}
