import type { Readable } from "node:stream";

/**
 * A POSIX tar archive (pax), written as a stream: a workspace's export (#186) holds whatever
 * names its files have, of any length and in any script, and files of any size, so a name that
 * plain ustar cannot hold, or a size of 8 GiB or more, goes in a pax extended header first, as
 * GNU tar, bsdtar and 7-Zip all read. Every entry's size is known before it starts.
 */

const BLOCK = 512;
/** The largest size ustar's eleven octal digits hold. */
const USTAR_MAX_SIZE = 8 ** 11 - 1;

export interface TarEntry {
  /** Its path in the archive, with forward slashes and no leading one. */
  path: string;
  size: number;
  modified: Date;
  /** Its bytes: exactly `size` of them, or the archive is refused as it is written. */
  body: Buffer | Readable | AsyncIterable<Buffer>;
}

const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`;

function header(name: string, size: number, modified: Date, type: "0" | "x"): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, "utf8");
  block.write(octal(0o644, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii");
  block.write(octal(0, 8), 116, "ascii");
  block.write(octal(size > USTAR_MAX_SIZE ? 0 : size, 12), 124, "ascii");
  block.write(octal(Math.max(0, Math.floor(modified.getTime() / 1000)), 12), 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write(type, 156, "ascii");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

/** A pax record: its own length in decimal, counted with itself. */
function record(key: string, value: string): string {
  const rest = ` ${key}=${value}\n`;
  const restBytes = Buffer.byteLength(rest);
  let length = restBytes + 1;
  while (String(length).length + restBytes !== length) length = String(length).length + restBytes;
  return `${length}${rest}`;
}

const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** Whether ustar's name field holds the path as it is. */
const fitsUstar = (path: string) => /^[\x20-\x7e]*$/.test(path) && path.length <= 100;

/** The header blocks for an entry: a pax header first where ustar cannot say it all. */
export function entryHeader(path: string, size: number, modified: Date): Buffer {
  const records: string[] = [];
  if (!fitsUstar(path)) records.push(record("path", path));
  if (size > USTAR_MAX_SIZE) records.push(record("size", String(size)));
  const plain = header(fitsUstar(path) ? path : asciiStandIn(path), size, modified, "0");
  if (records.length === 0) return plain;
  const pax = Buffer.from(records.join(""), "utf8");
  return Buffer.concat([
    header("PaxHeader", pax.length, modified, "x"),
    pax,
    padding(pax.length),
    plain,
  ]);
}

/** What a reader that ignores pax headers sees instead of a name ustar cannot hold. */
const asciiStandIn = (path: string) => {
  const ascii = path.replace(/[^\x20-\x7e]/g, "_");
  return ascii.length <= 100 ? ascii : ascii.slice(-100);
};

/** The archive, entry by entry, then the two empty blocks that end it. */
export async function* tarStream(entries: AsyncIterable<TarEntry>): AsyncGenerator<Buffer> {
  for await (const entry of entries) {
    yield entryHeader(entry.path, entry.size, entry.modified);
    let written = 0;
    const body =
      entry.body instanceof Buffer ? [entry.body] : (entry.body as AsyncIterable<Buffer>);
    for await (const chunk of body) {
      written += chunk.length;
      if (written > entry.size) throw new Error(`${entry.path} is longer than it said`);
      yield chunk;
    }
    if (written !== entry.size) throw new Error(`${entry.path} is shorter than it said`);
    yield padding(entry.size);
  }
  yield Buffer.alloc(BLOCK * 2);
}

/**
 * Reads a whole archive this module wrote back into its entries, pax paths and sizes included:
 * for tests, and for checking an archive by hand.
 */
export function readTar(archive: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let pax: Record<string, string> = {};
  for (let at = 0; at + BLOCK <= archive.length; ) {
    const block = archive.subarray(at, at + BLOCK);
    if (block.every((b) => b === 0)) break;
    const field = (start: number, length: number) =>
      block
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const type = field(156, 1);
    const size = pax.size ? Number(pax.size) : Number.parseInt(field(124, 12) || "0", 8);
    const body = archive.subarray(at + BLOCK, at + BLOCK + size);
    at += BLOCK + size + ((BLOCK - (size % BLOCK)) % BLOCK);
    if (type === "x") {
      pax = {};
      for (let i = 0; i < body.length; ) {
        const space = body.indexOf(0x20, i);
        const length = Number(body.subarray(i, space).toString("ascii"));
        const [key, ...value] = body
          .subarray(space + 1, i + length - 1)
          .toString("utf8")
          .split("=");
        pax[key ?? ""] = value.join("=");
        i += length;
      }
      continue;
    }
    out.set(pax.path ?? field(0, 100), Buffer.from(body));
    pax = {};
  }
  return out;
}
