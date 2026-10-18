/**
 * A Broadcast Wave file's bytes, made to order for tests (#41, #45): its format, a bext chunk
 * with the day and timecode, an iXML chunk with scene, take, tape and track names, and silence.
 */
export function waveBytes(options: {
  channels?: number;
  sampleRate?: number;
  seconds?: number;
  day?: string;
  /** Seconds since midnight. */
  start?: number;
  description?: string;
  ixml?: { scene?: string; take?: string; tape?: string; tracks?: string[]; rate?: string };
  /** iXML after the audio, as some recorders write it. */
  ixmlLast?: boolean;
}): Uint8Array {
  const channels = options.channels ?? 1;
  const sampleRate = options.sampleRate ?? 48_000;
  const bits = 24;
  const ascii = (text: string) => new TextEncoder().encode(text);
  const chunk = (id: string, body: Uint8Array) => {
    const padded = new Uint8Array(8 + body.length + (body.length % 2));
    padded.set(ascii(id), 0);
    new DataView(padded.buffer).setUint32(4, body.length, true);
    padded.set(body, 8);
    return padded;
  };
  const fmt = new Uint8Array(16);
  const f = new DataView(fmt.buffer);
  f.setUint16(0, 1, true);
  f.setUint16(2, channels, true);
  f.setUint32(4, sampleRate, true);
  f.setUint32(8, (sampleRate * channels * bits) / 8, true);
  f.setUint16(12, (channels * bits) / 8, true);
  f.setUint16(14, bits, true);
  const parts: Uint8Array[] = [chunk("fmt ", fmt)];
  if (options.day !== undefined || options.start !== undefined || options.description) {
    const bext = new Uint8Array(602);
    bext.set(ascii(options.description ?? ""), 0);
    bext.set(ascii(options.day ?? ""), 320);
    const samples = Math.round((options.start ?? 0) * sampleRate);
    const b = new DataView(bext.buffer);
    b.setUint32(338, samples % 2 ** 32, true);
    b.setUint32(342, Math.floor(samples / 2 ** 32), true);
    parts.push(chunk("bext", bext));
  }
  let ixml: Uint8Array | null = null;
  if (options.ixml) {
    const { scene, take, tape, tracks, rate } = options.ixml;
    const tag = (name: string, value?: string) => (value ? `<${name}>${value}</${name}>` : "");
    ixml = chunk(
      "iXML",
      ascii(
        `<?xml version="1.0"?><BWFXML>${tag("SCENE", scene)}${tag("TAKE", take)}${tag("TAPE", tape)}` +
          `<SPEED>${tag("TIMECODE_RATE", rate)}</SPEED>` +
          (tracks
            ? `<TRACK_LIST><TRACK_COUNT>${tracks.length}</TRACK_COUNT>${tracks
                .map(
                  (n, i) =>
                    `<TRACK><CHANNEL_INDEX>${i + 1}</CHANNEL_INDEX><NAME>${n}</NAME></TRACK>`,
                )
                .join("")}</TRACK_LIST>`
            : "") +
          "</BWFXML>",
      ),
    );
    if (!options.ixmlLast) parts.push(ixml);
  }
  const frames = Math.round((options.seconds ?? 0.01) * sampleRate);
  parts.push(chunk("data", new Uint8Array((frames * channels * bits) / 8)));
  if (ixml && options.ixmlLast) parts.push(ixml);
  const body = parts.reduce((n, p) => n + p.length, 4);
  const out = new Uint8Array(8 + body);
  out.set(ascii("RIFF"), 0);
  new DataView(out.buffer).setUint32(4, body, true);
  out.set(ascii("WAVE"), 8);
  let at = 12;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A reader over bytes in memory, as a browser's `File.slice` or a file handle gives them. */
export const readerOf =
  (bytes: Uint8Array) =>
  async (position: number, length: number): Promise<Uint8Array> =>
    bytes.subarray(position, Math.min(bytes.length, position + length));
