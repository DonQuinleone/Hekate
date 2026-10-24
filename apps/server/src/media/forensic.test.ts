import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CODE_LENGTH,
  chanceOf,
  DEFAULT_STRENGTH,
  detectMark,
  detectMarks,
  FALSE_MATCH_LIMIT,
  forensicKey,
  MARK_RATE,
  MarkEmbedder,
  markCode,
  markFor,
  markPattern,
} from "./forensic.ts";
import { sampleMusic } from "./sample-music.ts";

const key = forensicKey(Buffer.alloc(32, 7));
const pattern = markPattern(key);
const ids = Array.from(
  { length: 500 },
  (_, i) => `0192a7c4-0000-7000-8000-${String(i).padStart(12, "0")}`,
);
const candidates = ids.map((id) => ({ id, code: markCode(key, id) }));
const recipient = candidates[123] as (typeof candidates)[number];

const added = (sound: Float32Array, mark: Float32Array) =>
  sound.map((v, i) => v + (mark[i] as number));
const energy = (x: Float32Array) => x.reduce((sum, v) => sum + v * v, 0);

describe("forensic marks: keys and codes", () => {
  it("follows from the workspace's key and the mark's id, and nothing else", () => {
    expect(markCode(key, recipient.id)).toEqual(recipient.code);
    expect(recipient.code).toHaveLength(CODE_LENGTH);
    expect(new Set(recipient.code)).toEqual(new Set([1, -1]));
    // Another mark, or another workspace, has an unrelated code: about half its signs agree.
    const agree = (a: Int8Array, b: Int8Array) => a.filter((v, i) => v === b[i]).length / a.length;
    expect(agree(recipient.code, markCode(key, ids[124] as string))).toBeGreaterThan(0.4);
    expect(agree(recipient.code, markCode(key, ids[124] as string))).toBeLessThan(0.6);
    const other = forensicKey(Buffer.alloc(32, 8));
    expect(agree(recipient.code, markCode(other, recipient.id))).toBeLessThan(0.6);
    expect(markPattern(other).symbolSigns).not.toEqual(pattern.symbolSigns);
    // The forensic key is not the workspace's key.
    expect(forensicKey(Buffer.alloc(32, 7)).equals(Buffer.alloc(32, 7))).toBe(false);
  });

  it("bounds the chance of a false match by every comparison made", () => {
    expect(chanceOf(0, 10)).toBe(1);
    expect(chanceOf(8, 1)).toBeCloseTo(Math.exp(-32));
    expect(chanceOf(8, 1000)).toBeCloseTo(1000 * Math.exp(-32));
  });
});

describe("forensic marks: embedding", () => {
  const sound = sampleMusic(12, MARK_RATE, { seed: 2 });

  it("makes the same mark whatever pieces the sound arrives in, ending where it ends", () => {
    const whole = markFor(sound, pattern, recipient.code);
    expect(whole).toHaveLength(sound.length);
    const embedder = new MarkEmbedder(pattern, recipient.code);
    const parts: Float32Array[] = [];
    for (let at = 0, n = 1; at < sound.length; at += n, n = (n * 7 + 300) % 5000)
      parts.push(embedder.push(sound.subarray(at, Math.min(sound.length, at + n))));
    parts.push(embedder.end());
    const pieced = new Float32Array(sound.length);
    let at = 0;
    for (const p of parts) {
      pieced.set(p, at);
      at += p.length;
    }
    expect(at).toBe(sound.length);
    for (let i = 0; i < sound.length; i += 997)
      expect(pieced[i]).toBeCloseTo(whole[i] as number, 6);
  });

  it("is quiet beside the music: about the strength, in its band, and nothing in silence", () => {
    const mark = markFor(sound, pattern, recipient.code);
    // Over the whole spectrum the mark is more than 25 dB below the music.
    expect(10 * Math.log10(energy(mark) / energy(sound))).toBeLessThan(-25);
    expect(
      markFor(new Float32Array(MARK_RATE), pattern, recipient.code).every((v) => v === 0),
    ).toBe(true);
    expect(markFor(sound, pattern, recipient.code, 0).every((v) => v === 0)).toBe(true);
    expect(DEFAULT_STRENGTH).toBeLessThanOrEqual(0.05);
  });

  it("gives way rather than take a loud recording past full scale", () => {
    const loud = sampleMusic(6, MARK_RATE, { seed: 4, level: 0.995 });
    const marked = added(loud, markFor(loud, pattern, recipient.code));
    expect(Math.max(...marked.map(Math.abs))).toBeLessThanOrEqual(1);
  });
});

describe("forensic marks: detection", () => {
  const sound = sampleMusic(40, MARK_RATE, { seed: 3 });
  const marked = added(sound, markFor(sound, pattern, recipient.code));

  it("names the recipient of a marked recording, with the chance of a mistake", () => {
    const found = detectMark(marked, pattern, candidates);
    expect(found.match?.id).toBe(recipient.id);
    expect(found.match?.chance).toBeLessThan(FALSE_MATCH_LIMIT);
    expect(found.sync.chance).toBeLessThan(1e-3);
    expect(found.comparisons).toBeGreaterThanOrEqual(candidates.length);
  });

  it("names them from 20 seconds cut from anywhere, quieter", () => {
    const from = 7 * MARK_RATE + 123;
    const clip = marked.subarray(from, from + 20 * MARK_RATE).map((v) => v * 0.25);
    expect(detectMark(clip, pattern, candidates).match?.id).toBe(recipient.id);
  });

  it("finds nothing in the unmarked recording, nor with another workspace's key", () => {
    for (const seed of [3, 5, 6]) {
      const plain = seed === 3 ? sound : sampleMusic(30, MARK_RATE, { seed });
      const found = detectMark(plain, pattern, candidates);
      expect(found.match).toBeNull();
      // The best of 500 unrelated codes is no better than chance would make it.
      expect(found.best?.chance).toBeGreaterThan(1e-3);
    }
    const other = forensicKey(randomBytes(32));
    const theirs = ids.map((id) => ({ id, code: markCode(other, id) }));
    expect(detectMark(marked, markPattern(other), theirs).match).toBeNull();
  });

  it("looks under every version of the key, counting each comparison", () => {
    const older = forensicKey(Buffer.alloc(32, 1));
    const groups = [
      {
        pattern: markPattern(older),
        candidates: ids.map((id) => ({ id, code: markCode(older, id) })),
      },
      { pattern, candidates },
    ];
    const found = detectMarks(marked, groups);
    expect(found.match?.id).toBe(recipient.id);
    expect(found.comparisons).toBe(2 * detectMark(marked, pattern, candidates).comparisons);
  });

  it("finds nothing in silence or in a clip too short to hold a symbol", () => {
    expect(detectMark(new Float32Array(10 * MARK_RATE), pattern, candidates).match).toBeNull();
    expect(detectMark(marked.subarray(0, 600), pattern, candidates).best).toBeNull();
  });
});
