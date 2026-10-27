import { describe, expect, it } from "vitest";
import type { EmbeddedMetadata, MediaInfo } from "./media.ts";
import { timecodeOf } from "./metadata.ts";
import {
  applyMetadataChanges,
  correctedMetadata,
  editableFields,
  metadataChanges,
  metadataFormatOf,
  metadataValueProblem,
  samplesOfTimecode,
} from "./metadata-edit.ts";

const read: EmbeddedMetadata = {
  bext: { description: "Maple Leaf Rag, V2 dry", originator: "Endless Hal" },
  tags: { title: "Maple Leaf Rag" },
};

describe("correcting embedded metadata (decision 264)", () => {
  it("offers the editor only where Hekate can write the file as it leaves", () => {
    const info = (format: string): MediaInfo => ({
      format,
      audio: { codec: "pcm_s24le", channels: 2, sampleRate: 48_000 },
      metadata: { tags: {} },
    });
    expect(metadataFormatOf(info("wav"))).toBe("wave");
    expect(metadataFormatOf(info("flac"))).toBe("flac");
    expect(metadataFormatOf(info("mp3"))).toBe("mp3");
    expect(metadataFormatOf(info("aiff"))).toBeNull();
    expect(metadataFormatOf(info("mov,mp4,m4a,3gp,3g2,mj2"))).toBeNull();
    // Metadata never read: nothing to correct yet.
    expect(metadataFormatOf({ format: "wav", audio: info("wav").audio })).toBeNull();
    expect(metadataFormatOf(null)).toBeNull();
  });

  it("lists bext and iXML for a wave file, and only the tags its INFO can hold", () => {
    const wave = editableFields("wave", 48_000);
    expect(wave).toContain("description");
    expect(wave).toContain("scene");
    expect(wave).toContain("isrc");
    expect(wave).not.toContain("composer");
    expect(editableFields("wave")).not.toContain("timeReference");
    expect(editableFields("flac")).toEqual([
      "title",
      "artist",
      "album",
      "albumArtist",
      "composer",
      "genre",
      "date",
      "isrc",
      "copyright",
    ]);
  });

  it("refuses a value its field cannot hold, in words", () => {
    expect(metadataValueProblem("originator", "Endless Hall Records")).toBeNull();
    expect(metadataValueProblem("originator", "x".repeat(33))).toBe("At most 32 characters");
    expect(metadataValueProblem("description", "Café")).toBeNull();
    expect(metadataValueProblem("description", "Ласточка")).toMatch(/Latin-1/);
    expect(metadataValueProblem("title", "Ласточка")).toBeNull();
    expect(metadataValueProblem("title", "two\nlines")).toBe("One line of text, please");
    expect(metadataValueProblem("isrc", "GB-ABC-26-00001")).toBeNull();
    expect(metadataValueProblem("isrc", "GBABC2600001")).toBeNull();
    expect(metadataValueProblem("isrc", "none")).toMatch(/ISRC/);
    expect(metadataValueProblem("originationDate", "2026-10-14")).toBeNull();
    expect(metadataValueProblem("originationDate", "14 Oct")).toMatch(/date/);
    expect(metadataValueProblem("timeReference", "1728000000")).toBeNull();
    expect(metadataValueProblem("timeReference", "10:00")).toMatch(/Samples/);
    // Empty clears a field.
    expect(metadataValueProblem("isrc", "")).toBeNull();
  });

  it("checks a request's every value, and refuses one that changes nothing", () => {
    expect(metadataChanges.safeParse({ changes: { isrc: "GB-ABC-26-00001" } }).success).toBe(true);
    expect(metadataChanges.safeParse({ changes: {} }).success).toBe(false);
    expect(metadataChanges.safeParse({ changes: { isrc: "nope" } }).success).toBe(false);
    expect(metadataChanges.safeParse({ changes: { umid: "x" } }).success).toBe(false);
  });

  it("keeps a correction with what the file says, and drops it when the two agree again", () => {
    const first = applyMetadataChanges(
      read,
      {},
      { originator: "Endless Hall", isrc: "GBABC2600001" },
    );
    expect(first.metadata.bext?.originator).toBe("Endless Hall");
    expect(first.metadata.tags.isrc).toBe("GBABC2600001");
    expect(first.corrections).toEqual({
      originator: { value: "Endless Hall", read: "Endless Hal" },
      isrc: { value: "GBABC2600001", read: null },
    });
    expect(first.changed).toEqual([
      { field: "originator", from: "Endless Hal", to: "Endless Hall" },
      { field: "isrc", from: null, to: "GBABC2600001" },
    ]);
    // Typed back as it was: no longer a correction. Null restores what the file says.
    const second = applyMetadataChanges(first.metadata, first.corrections, {
      originator: "Endless Hal",
      isrc: null,
    });
    expect(second.corrections).toEqual({});
    expect(second.metadata).toEqual(read);
    expect(second.changed.map((c) => c.field)).toEqual(["originator", "isrc"]);
  });

  it("clears a field with an empty value, and records nothing for a value that stays", () => {
    const cleared = applyMetadataChanges(
      read,
      {},
      { title: "", description: read.bext?.description ?? "" },
    );
    expect(cleared.metadata.tags.title).toBeUndefined();
    expect(cleared.corrections).toEqual({ title: { value: "", read: "Maple Leaf Rag" } });
    expect(cleared.changed).toEqual([{ field: "title", from: "Maple Leaf Rag", to: null }]);
  });

  it("gives a recording iXML and bext it did not have, and lays corrections over a new read", () => {
    const bare: EmbeddedMetadata = { tags: {} };
    const { metadata, corrections } = applyMetadataChanges(
      bare,
      {},
      {
        scene: "12",
        timeReference: "1728000000",
      },
    );
    expect(metadata.ixml).toEqual({ bytes: 0, scene: "12" });
    expect(metadata.bext).toEqual({ timeReference: 1_728_000_000 });
    // Probed again, the file says what it always said; the corrections go back over it.
    expect(correctedMetadata(bare, corrections)).toEqual(metadata);
    expect(correctedMetadata(read, null)).toEqual(read);
  });

  it("reads typed timecode as samples since midnight, as the QA view writes it", () => {
    const tenHours = 10 * 3600 * 48_000;
    expect(samplesOfTimecode("10:00:00", 48_000)).toBe(tenHours);
    expect(samplesOfTimecode("10:00:00:12", 48_000, "25/1")).toBe(tenHours + 23_040);
    expect(timecodeOf(samplesOfTimecode("10:00:00:12", 48_000, "25/1") ?? 0, 48_000, "25/1")).toBe(
      "10:00:00:12",
    );
    // Frames without a rate, a frame past the rate, or no timecode at all.
    expect(samplesOfTimecode("10:00:00:12", 48_000)).toBeNull();
    expect(samplesOfTimecode("10:00:00:25", 48_000, "25/1")).toBeNull();
    expect(samplesOfTimecode("25:00:00", 48_000)).toBeNull();
    expect(samplesOfTimecode("ten", 48_000)).toBeNull();
  });
});
