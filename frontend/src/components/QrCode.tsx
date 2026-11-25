import { useMemo } from "react";
import { encode } from "uqr";

/** QR code as crisp SVG modules, dark on a white tile so every phone camera reads it. */
export function QrCode({ text, size = 200 }: { text: string; size?: number }) {
  const { path, n } = useMemo(() => {
    const qr = encode(text, { ecc: "M", border: 2 });
    let d = "";
    qr.data.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x} ${y}h1v1h-1z`)));
    return { path: d, n: qr.size };
  }, [text]);
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" role="img" aria-label={`QR code for ${text}`}>
      <rect width={n} height={n} fill="#fff" />
      <path d={path} fill="#0b0912" />
    </svg>
  );
}
