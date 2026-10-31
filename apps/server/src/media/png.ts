import { deflateSync, inflateSync } from "node:zlib";
import type { PdfImage } from "./pdf.ts";

/**
 * A PNG as a PDF draws it (#515): a workspace's logo, which `sanitiseLogo` always writes as
 * eight-bit RGBA without interlacing, on the cover and at the head of every page of its QA
 * report. Its rows are unfiltered here and its colour and opacity written apart, as PDF keeps
 * them. Anything else (another bit depth, a palette, interlacing, a broken file) is null, and
 * the report carries Hekate's mark instead.
 */
export function pdfImageOfPng(png: Uint8Array): PdfImage | null {
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
  if (channels === 3) return { width, height, rgb: deflateSync(pixels), alpha: null };
  const rgb = Buffer.alloc(width * height * 3);
  const alpha = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = pixels[i * 4] as number;
    rgb[i * 3 + 1] = pixels[i * 4 + 1] as number;
    rgb[i * 3 + 2] = pixels[i * 4 + 2] as number;
    alpha[i] = pixels[i * 4 + 3] as number;
  }
  return { width, height, rgb: deflateSync(rgb), alpha: deflateSync(alpha) };
}
