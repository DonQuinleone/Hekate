import { deflateSync, inflateSync } from "node:zlib";
import type { PdfImage } from "./pdf.ts";

/**
 * A PNG as a PDF draws it (#515): a workspace's logo, which `sanitiseLogo` always writes as
 * eight-bit RGBA without interlacing, on the cover and at the head of every page of its QA
 * report. Its rows are unfiltered here and its colour and opacity written apart, as PDF keeps
 * them. Anything else (another bit depth, a palette, interlacing, a broken file) is null, and
 * the report carries Hekate's mark instead. `light` says the logo was made for a dark ground
 * (as the sign-in page is): a third or more of what it shows is too pale to read on paper.
 */
export function pdfImageOfPng(png: Uint8Array): (PdfImage & { light: boolean }) | null {
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 33 || signature.some((b, i) => bytes[i] !== b)) return null;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Buffer[] = [];
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (body.length !== length) return null;
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
      if (depth !== 8 || interlace !== 0) return null;
      channels = colour === 6 ? 4 : colour === 2 ? 3 : 0;
      if (!channels) return null;
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (!width || !height || data.length === 0 || width > 4096 || height > 4096) return null;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(data));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? (pixels[out + x - channels] as number) : 0;
      const up = y > 0 ? (pixels[out - stride + x] as number) : 0;
      const corner = y > 0 && x >= channels ? (pixels[out - stride + x - channels] as number) : 0;
      let predicted: number;
      switch (filter) {
        case 0:
          predicted = 0;
          break;
        case 1:
          predicted = left;
          break;
        case 2:
          predicted = up;
          break;
        case 3:
          predicted = (left + up) >> 1;
          break;
        case 4: {
          const p = left + up - corner;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - corner);
          predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
          break;
        }
        default:
          return null;
      }
      pixels[out + x] = ((row[x] as number) + predicted) & 0xff;
    }
  }
  const rgb = channels === 3 ? pixels : Buffer.alloc(width * height * 3);
  const alpha = channels === 4 ? Buffer.alloc(width * height) : null;
  let shown = 0;
  let pale = 0;
  for (let i = 0; i < width * height; i++) {
    const [r, g, b, a] = [0, 1, 2, 3].map((k) => pixels[i * channels + k] as number);
    if (alpha) {
      rgb[i * 3] = r as number;
      rgb[i * 3 + 1] = g as number;
      rgb[i * 3 + 2] = b as number;
      alpha[i] = a as number;
    }
    if (channels === 3 || (a as number) >= 128) {
      shown++;
      // Relative luminance, roughly: pale enough that paper hardly shows it.
      if (0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number) > 200) pale++;
    }
  }
  return {
    width,
    height,
    rgb: deflateSync(rgb),
    alpha: alpha ? deflateSync(alpha) : null,
    light: shown > 0 && pale / shown >= 1 / 3,
  };
}
