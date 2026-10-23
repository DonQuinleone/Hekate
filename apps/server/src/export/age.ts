import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

/**
 * The age file format (age-encryption.org/v1), to X25519 recipients, written here rather than
 * taken from a library: a workspace's export (#186) is encrypted with it, so that `age -d`
 * (or rage, or any implementation of the specification) opens it with the key shown once, and
 * nothing Hekate keeps can. It is built from Node's own X25519, HKDF-SHA-256, HMAC-SHA-256 and
 * ChaCha20-Poly1305, as the specification describes: a random file key wrapped for each
 * recipient, a header MAC, then the payload in 64 KiB chunks, each sealed with its counter and
 * a last-chunk flag, so nothing can be cut, reordered or added unnoticed.
 */

const VERSION_LINE = "age-encryption.org/v1";
const X25519_LABEL = "age-encryption.org/v1/X25519";
/** Plaintext per payload chunk. */
const CHUNK = 64 * 1024;
const TAG = 16;
const COLUMNS = 64;

// Bech32 (BIP 173), as age writes its keys, without the 90-character limit.

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i] ?? 0;
  }
  return chk >>> 0;
}

const expand = (hrp: string) => [
  ...[...hrp].map((c) => c.charCodeAt(0) >>> 5),
  0,
  ...[...hrp].map((c) => c.charCodeAt(0) & 31),
];

function convert(data: Iterable<number>, from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const max = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >>> bits) & max);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & max);
  } else if (bits >= from || ((acc << (to - bits)) & max) !== 0) {
    throw new Error("Bech32 padding is wrong");
  }
  return out;
}

export function bech32Encode(hrp: string, data: Uint8Array): string {
  const words = convert(data, 8, 5, true);
  const mod = polymod([...expand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const check = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...check].map((w) => CHARSET[w]).join("")}`;
}

export function bech32Decode(text: string): { hrp: string; data: Buffer } {
  if (text !== text.toLowerCase() && text !== text.toUpperCase())
    throw new Error("Bech32 is in one case");
  const lower = text.toLowerCase();
  const at = lower.lastIndexOf("1");
  if (at < 1 || at + 7 > lower.length) throw new Error("Not Bech32");
  const hrp = lower.slice(0, at);
  const words = [...lower.slice(at + 1)].map((c) => {
    const w = CHARSET.indexOf(c);
    if (w < 0) throw new Error("Not Bech32");
    return w;
  });
  if (polymod([...expand(hrp), ...words]) !== 1) throw new Error("The Bech32 checksum is wrong");
  return { hrp, data: Buffer.from(convert(words.slice(0, -6), 5, 8, false)) };
}

// X25519 keys from and to their 32 raw bytes, through their DER forms.

const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

const privateFromRaw = (raw: Buffer) =>
  createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
const publicFromRaw = (raw: Buffer) =>
  createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
const rawPublic = (key: KeyObject) =>
  (key.export({ format: "der", type: "spki" }) as Buffer).subarray(SPKI_PREFIX.length);
const rawPrivate = (key: KeyObject) =>
  (key.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(PKCS8_PREFIX.length);

/** A recipient's public key, from its `age1…` form. */
export function parseRecipient(recipient: string): Buffer {
  const { hrp, data } = bech32Decode(recipient);
  if (hrp !== "age" || data.length !== 32) throw new Error("Not an age X25519 recipient");
  return data;
}

/** A new key pair: the secret key (`AGE-SECRET-KEY-1…`) and its recipient (`age1…`). */
export function generateIdentity(): { secretKey: string; recipient: string } {
  const pair = generateKeyPairSync("x25519");
  const secret = rawPrivate(pair.privateKey);
  try {
    return {
      secretKey: bech32Encode("age-secret-key-", secret).toUpperCase(),
      recipient: bech32Encode("age", rawPublic(pair.publicKey)),
    };
  } finally {
    secret.fill(0);
  }
}

/** The recipient a secret key opens files for. */
export function recipientOf(secretKey: string): string {
  const { hrp, data } = bech32Decode(secretKey);
  if (hrp !== "age-secret-key-" || data.length !== 32) throw new Error("Not an age secret key");
  return bech32Encode("age", rawPublic(createPublicKey(privateFromRaw(data))));
}

const b64 = (bytes: Buffer) => bytes.toString("base64").replace(/=+$/, "");
const unb64 = (text: string) => {
  if (!/^[A-Za-z0-9+/]*$/.test(text)) throw new Error("Not base64");
  return Buffer.from(text, "base64");
};

const hkdf = (ikm: Buffer, salt: Buffer, info: string) =>
  Buffer.from(hkdfSync("sha256", ikm, salt, info, 32));

function seal(key: Buffer, nonce: Buffer, plain: Buffer): Buffer {
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: TAG });
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function open(key: Buffer, nonce: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < TAG) throw new Error("Too short to open");
  const decipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: TAG });
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
  return Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - TAG)),
    decipher.final(),
  ]);
}

/** A stanza's body, in lines of 64 columns, the last always shorter (empty if need be). */
function wrapped(text: string): string {
  const lines: string[] = [];
  for (let at = 0; at <= text.length; at += COLUMNS) lines.push(text.slice(at, at + COLUMNS));
  return lines.join("\n");
}

const chunkNonce = (counter: bigint, last: boolean) => {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(counter, 3);
  nonce[11] = last ? 1 : 0;
  return nonce;
};

const isZero = (bytes: Buffer) => bytes.every((b) => b === 0);

/** The header for a file key, wrapped for each recipient, with its MAC. */
function headerFor(fileKey: Buffer, recipients: Buffer[]): Buffer {
  let text = `${VERSION_LINE}\n`;
  for (const recipient of recipients) {
    const ephemeral = generateKeyPairSync("x25519");
    const share = rawPublic(ephemeral.publicKey);
    const shared = diffieHellman({
      privateKey: ephemeral.privateKey,
      publicKey: publicFromRaw(recipient),
    });
    if (isZero(shared)) throw new Error("The recipient's key is not usable");
    const wrapKey = hkdf(shared, Buffer.concat([share, recipient]), X25519_LABEL);
    const body = seal(wrapKey, Buffer.alloc(12), fileKey);
    text += `-> X25519 ${b64(share)}\n${wrapped(b64(body))}\n`;
  }
  text += "---";
  const mac = createHmac("sha256", hkdf(fileKey, Buffer.alloc(0), "header"))
    .update(text)
    .digest();
  return Buffer.from(`${text} ${b64(mac)}\n`);
}

/**
 * Encrypts what passes through to one or more recipients (`age1…`), as an age file. The last
 * chunk is held back until the end, as only then is it known to be the last.
 */
export function ageEncryptor(recipients: string[]): Transform {
  if (recipients.length === 0) throw new Error("An age file needs a recipient");
  const keys = recipients.map(parseRecipient);
  const fileKey = randomBytes(16);
  const nonce = randomBytes(16);
  const payloadKey = hkdf(fileKey, nonce, "payload");
  const head = Buffer.concat([headerFor(fileKey, keys), nonce]);
  fileKey.fill(0);
  let pending: Buffer[] = [];
  let held = 0;
  let counter = 0n;
  let started = false;
  const start = (stream: Transform) => {
    if (started) return;
    started = true;
    stream.push(head);
  };
  return new Transform({
    transform(this: Transform, chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
      start(this);
      pending.push(chunk);
      held += chunk.length;
      // More than a chunk held: the first chunk's worth is not the last.
      if (held > CHUNK) {
        let all = Buffer.concat(pending);
        while (all.length > CHUNK) {
          this.push(seal(payloadKey, chunkNonce(counter, false), all.subarray(0, CHUNK)));
          counter += 1n;
          all = all.subarray(CHUNK);
        }
        pending = [all];
        held = all.length;
      }
      done();
    },
    flush(this: Transform, done: TransformCallback) {
      start(this);
      this.push(seal(payloadKey, chunkNonce(counter, true), Buffer.concat(pending)));
      pending = [];
      payloadKey.fill(0);
      done();
    },
  });
}

/**
 * Opens a whole age file with a secret key: for tests, and for checking an archive by hand.
 * Refuses anything altered, cut short or added to.
 */
export function ageDecrypt(secretKey: string, file: Buffer): Buffer {
  const { hrp, data: secret } = bech32Decode(secretKey);
  if (hrp !== "age-secret-key-" || secret.length !== 32) throw new Error("Not an age secret key");
  const identity = privateFromRaw(secret);
  const ours = rawPublic(createPublicKey(identity));
  const end = file.indexOf("\n---");
  if (end < 0) throw new Error("No age header");
  const lineEnd = file.indexOf("\n", end + 1);
  const headerText = file.subarray(0, end + 4).toString("latin1");
  const macText = file.subarray(end + 5, lineEnd).toString("latin1");
  const lines = headerText.split("\n");
  if (lines[0] !== VERSION_LINE) throw new Error("Not an age file");
  let fileKey: Buffer | null = null;
  for (let i = 1; i < lines.length - 1; ) {
    const args = (lines[i] ?? "").split(" ");
    i += 1;
    let body = "";
    for (;;) {
      const line = lines[i] ?? "";
      i += 1;
      body += line;
      if (line.length < COLUMNS) break;
    }
    if (args[0] !== "->" || args[1] !== "X25519" || args.length !== 3 || fileKey) continue;
    const share = unb64(args[2] ?? "");
    const shared = diffieHellman({ privateKey: identity, publicKey: publicFromRaw(share) });
    const wrapKey = hkdf(shared, Buffer.concat([share, ours]), X25519_LABEL);
    try {
      fileKey = open(wrapKey, Buffer.alloc(12), unb64(body));
    } catch {
      // Wrapped for another recipient.
    }
  }
  if (!fileKey) throw new Error("No recipient here is this key's");
  const mac = createHmac("sha256", hkdf(fileKey, Buffer.alloc(0), "header"))
    .update(headerText)
    .digest();
  const given = unb64(macText);
  if (given.length !== mac.length || !timingSafeEqual(given, mac))
    throw new Error("The header has been altered");
  const nonce = file.subarray(lineEnd + 1, lineEnd + 17);
  const payloadKey = hkdf(fileKey, nonce, "payload");
  const sealed = file.subarray(lineEnd + 17);
  const out: Buffer[] = [];
  let counter = 0n;
  for (let at = 0; ; at += CHUNK + TAG) {
    const piece = sealed.subarray(at, at + CHUNK + TAG);
    const last = at + CHUNK + TAG >= sealed.length;
    out.push(open(payloadKey, chunkNonce(counter, last), piece));
    counter += 1n;
    if (last) break;
  }
  return Buffer.concat(out);
}
