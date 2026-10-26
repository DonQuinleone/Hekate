/**
 * A picture's size in pixels from the first bytes of its file, for a stage plan's floor-plan
 * underlay (decision 242): ControlRoom keeps its scale in metres a pixel, and Hekate its width
 * in metres. PNG, JPEG, GIF and BMP, the pictures ControlRoom's loader reads that a browser
 * shows; anything else is null.
 */
export function imageSize(head: Uint8Array): { width: number; height: number } | null {
  const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString("latin1", 12, 16) === "IHDR")
    return positive(b.readUInt32BE(16), b.readUInt32BE(20));
  if (
    b.length >= 10 &&
    (b.toString("latin1", 0, 6) === "GIF87a" || b.toString("latin1", 0, 6) === "GIF89a")
  )
    return positive(b.readUInt16LE(6), b.readUInt16LE(8));
  if (b.length >= 26 && b.toString("latin1", 0, 2) === "BM")
    return positive(Math.abs(b.readInt32LE(18)), Math.abs(b.readInt32LE(22)));
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpegSize(b);
  return null;
}

const positive = (width: number, height: number) =>
  width > 0 && height > 0 ? { width, height } : null;

/** A JPEG's size, from its first start-of-frame marker. */
function jpegSize(b: Buffer): { width: number; height: number } | null {
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1] as number;
    // Fill bytes, and markers that stand alone.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = b.readUInt16BE(at + 2);
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return positive(b.readUInt16BE(at + 7), b.readUInt16BE(at + 5));
    at += 2 + length;
  }
  return null;
}
