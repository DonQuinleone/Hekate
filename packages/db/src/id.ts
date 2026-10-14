import { randomBytes } from "node:crypto";

let lastMs = -1;
let counter = 0;

/**
 * UUIDv7 (RFC 9562): 48-bit Unix milliseconds, then a 12-bit counter, then random
 * bits. Ids sort by creation time, and ids made in the same millisecond by this
 * process sort in the order they were made (RFC 9562 section 6.2, method 1): the
 * counter starts at a random value below 2048 each millisecond and counts up; if it
 * runs out, the timestamp moves on by one millisecond.
 */
export function uuidv7(now: number = Date.now()): string {
  let ms = now;
  if (ms > lastMs) {
    counter = randomBytes(2).readUInt16BE(0) & 0x7ff;
  } else {
    ms = lastMs;
    counter += 1;
    if (counter > 0xfff) {
      ms += 1;
      counter = randomBytes(2).readUInt16BE(0) & 0x7ff;
    }
  }
  lastMs = ms;

  const bytes = randomBytes(16);
  let t = BigInt(ms);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  bytes[6] = 0x70 | (counter >> 8);
  bytes[7] = counter & 0xff;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
