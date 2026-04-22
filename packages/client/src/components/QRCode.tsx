/**
 * QRCode - Renders a QR code as SVG using uqr.
 */

import { encode } from "uqr";

interface QRCodeProps {
  /** The data to encode */
  value: string;
  /** Size in pixels (default: 200) */
  size?: number;
  /** Module color (default: black) */
  color?: string;
  /** Background color (default: white) */
  bgColor?: string;
}

export function QRCode({
  value,
  size = 200,
  color = "#000000",
  bgColor = "#ffffff",
}: QRCodeProps) {
  const { data } = encode(value);
  const moduleCount = data.length;
  const moduleSize = size / moduleCount;

  // Build SVG path for all dark modules
  let path = "";
  for (let row = 0; row < moduleCount; row++) {
    const rowData = data[row];
    if (!rowData) continue;
    for (let col = 0; col < moduleCount; col++) {
      if (rowData[col]) {
        const x = col * moduleSize;
        const y = row * moduleSize;
        path += `M${x},${y}h${moduleSize}v${moduleSize}h-${moduleSize}z`;
      }
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="QR code"
    >
      <rect width={size} height={size} fill={bgColor} />
      <path d={path} fill={color} />
    </svg>
  );
}
