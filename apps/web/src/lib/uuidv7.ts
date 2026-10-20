let lastMs = -1;
let counter = 0;

const random12 = () => crypto.getRandomValues(new Uint16Array(1))[0] ?? 0;

/**
 * UUIDv7 (RFC 9562), made in the browser as the server makes them: 48-bit Unix milliseconds,
 * a 12-bit counter so ids made in the same millisecond sort in the order they were made, then
 * random bits. The take log names takes it starts offline with these (#51).
 */
export function uuidv7(now: number = Date.now()): string {
  let ms = now;
  if (ms > lastMs) {
    counter = random12() & 0x7ff;
  } else {
    ms = lastMs;
    counter += 1;
    if (counter > 0xfff) {
      ms += 1;
      counter = random12() & 0x7ff;
    }
  }
  lastMs = ms;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let t = ms;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = t % 256;
    t = Math.floor(t / 256);
  }
  bytes[6] = 0x70 | (counter >> 8);
  bytes[7] = counter & 0xff;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
