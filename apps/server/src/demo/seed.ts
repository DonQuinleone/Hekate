import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { type createSql, uuidv7 } from "@hekate/db";
import { CHUNK_SIZE } from "@hekate/storage";
import { textPdfOf } from "../media/pdf.ts";
import { samplePdf } from "../media/sample-pdf.ts";
import { SETUP_CODE_HEADER } from "../setup-code.ts";
import { FIXED_TIME, type Seeded } from "./seeded.ts";

/**
 * Seeds one instance as a studio would have it (decision 266): a music project with a track in
 * two versions (a dry and a wet mix in the second), its score, takes, sessions, comments of
 * every kind and reviews in every state; a video project with a cut and a deliverable; a
 * general project with a booklet; other workspaces, one of them suspended; and the instance's
 * billing, support and status. Everything is made here, so every run sees the same.
 *
 * It all goes through the HTTP API, as the browser would send it, so the same seed fills the
 * visual suite's instance (apps/e2e, through Playwright's request context) and the demo
 * (`cli.ts demo seed`, through fetch and a cookie jar). What only a browser can do, or only the
 * suite wants (its captures, reading a guest's link out of the server's log), is left to the
 * hooks in SeedOptions. A few rows no route writes (failures, usage, a year of invoices, the
 * clock) go straight to the database when a connection is given.
 */

/** A postgres.js connection, as `createSql` makes one. */
export type Sql = ReturnType<typeof createSql>;

/** What a request answers with: enough to check it and read it. */
export interface SessionResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface SessionInit {
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}

/** One signed-in person's requests: the cookies of one browser context, or of one jar. */
export interface Session {
  /** A JSON call that must succeed: it throws with the method, the path and the answer. */
  api<T>(method: string, path: string, body?: unknown): Promise<T>;
  /** A request as it is: a binary body, a form, a bearer token, or a status to look at. */
  fetch(path: string, init?: SessionInit): Promise<SessionResponse>;
  /** Lets the session go once the seed has finished with it. */
  close?(): Promise<void>;
}

/** The owner's session, and a way to open a fresh, signed-out one for everyone else. */
export interface Client<S extends Session = Session> {
  owner: S;
  session(): Promise<S>;
}

export interface SeedOptions<S extends Session = Session> {
  client: Client<S>;
  /** The server's setup code: it opens POST /api/setup (decision 061). */
  setupCode: string;
  /** For what no route writes; without it, those rows are left out. */
  sql?: Sql;
  /** Where the media is written; a temporary directory, removed afterwards, by default. */
  media?: string;
  /** Right after the first owner is made and signed in: the suite captures the empty home. */
  afterSetup?(owner: S): Promise<void>;
  /** With the guest signed in, before their session is closed: the suite keeps its cookies. */
  afterGuest?(guest: S): Promise<void>;
  /** With a suspended workspace's owner signed in: the suite captures what they are told. */
  afterSuspended?(owner: S): Promise<void>;
  /**
   * The link the review's guest was sent, which only the mail holds (or the server's log,
   * without a mail server). Absent, or empty, the guest's visit and comment are left out.
   */
  guestLink?(): Promise<string | undefined>;
}

/** Everyone the seed gives a password has this one. */
export const PASSWORD = "correct horse battery";

/** The accounts anyone can sign in as, by the workspaces they own. */
export const accounts = {
  alex: {
    name: "Alex Rivera",
    email: "producer@example.test",
    workspace: "Endless Hall Records",
    note: "its owner, and the instance's operator",
  },
  tomas: {
    name: "Tomas Varga",
    email: "owner@saltmarsh.example",
    workspace: "Saltmarsh Films",
    note: "its owner",
  },
  mira: {
    name: "Mira Solberg",
    email: "mira@lantern.example",
    workspace: "Lantern Pictures",
    note: "its owner; the workspace is suspended",
  },
} as const;

const json = { "content-type": "application/json" };

/** The JSON call every session makes the same way, over whatever sends its requests. */
export function apiOf(fetch: Session["fetch"]): Session["api"] {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(path, {
      method,
      ...(body === undefined ? {} : { headers: json, body: JSON.stringify(body) }),
    });
    await check(response, `${method} ${path}`);
    // A 204 says it is done and carries nothing to read.
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  };
}

/** Fails with what the server said, where a status (or any success) was expected. */
async function check(response: SessionResponse, label: string, status?: number) {
  const wanted = status === undefined ? response.ok : response.status === status;
  if (!wanted)
    throw new Error(
      `${label}: ${response.status}${status === undefined ? "" : ` (wanted ${status})`}: ${await response.text()}`,
    );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A few seconds of something like music: plucked notes over a bass, the same every time.
 * `damage` adds what the quality checks look for: a burst driven into clipping, and a
 * moment of digital silence.
 */
function recording(path: string, seconds: number, brightness: number, damage = false) {
  const note = (base: string, steps: string) =>
    `0.25*sin(2*PI*(${base}*pow(2,${steps}/12))*t)*exp(-4*mod(t,0.5))`;
  const left = `${note("220", "mod(floor(t*2),5)*2")}+${note("110", "mod(floor(t/2),4)*3")}*0.8`;
  const right = `${note("330", "mod(floor(t*2),4)*2")}*${brightness}+${note("110", "mod(floor(t/2),4)*3")}*0.8`;
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `aevalsrc='${left}|${right}':s=44100:d=${seconds}`,
    ...(damage
      ? [
          "-af",
          "volume=enable='between(t,12,12.5)':volume=8,volume=enable='between(t,31,31.04)':volume=0",
        ]
      : []),
    // The file under review says what it is, as a studio's Broadcast Wave would (#41).
    ...(damage
      ? [
          "-write_bext",
          "1",
          "-metadata",
          "description=Maple Leaf Rag, V2 dry",
          "-metadata",
          "originator=Endless Hall Records",
          "-metadata",
          "origination_date=2026-10-14",
          "-metadata",
          "origination_time=09:58:00",
          "-metadata",
          `time_reference=${10 * 3600 * 44_100}`,
          "-metadata",
          "title=Maple Leaf Rag",
          "-metadata",
          "artist=Endless Hall Records",
        ]
      : []),
    "-c:a",
    "pcm_s16le",
    path,
  ]);
}

function cut(path: string, size = "1280x720", source = "testsrc2") {
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `${source}=size=${size}:rate=25:duration=12`,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:sample_rate=48000:duration=12",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    // Starting at ten o'clock, as a programme's timecode does (#146).
    "-timecode",
    "10:00:00:00",
    "-shortest",
    path,
  ]);
}

interface SeededFile {
  id: string;
  name: string;
  kind: string;
  streamStatus: string;
  analysisStatus: string;
}

/** What a browser would say a file is, by its name; nothing for one it does not know. */
const contentTypeOf = (path: string) =>
  (
    ({
      ".wav": "audio/wav",
      ".mp4": "video/mp4",
      ".pdf": "application/pdf",
      ".png": "image/png",
      ".zip": "application/zip",
    }) as Record<string, string>
  )[extname(path).toLowerCase()];

/** Sends files as the browser does (decision 017): an upload, its chunks, then complete. */
async function upload(session: Session, projectId: string, paths: string[], folderId?: string) {
  for (const path of paths) {
    const data = readFileSync(path);
    const { upload } = await session.api<{ upload: { id: string } }>("POST", "/api/uploads", {
      projectId,
      name: basename(path),
      size: data.byteLength,
      contentType: contentTypeOf(path),
      ...(folderId ? { folderId } : {}),
    });
    const chunks = Math.max(1, Math.ceil(data.byteLength / CHUNK_SIZE));
    for (let index = 0; index < chunks; index++) {
      const sent = await session.fetch(`/api/uploads/${upload.id}/chunks/${index}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: data.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
      });
      await check(sent, `PUT chunk ${index} of ${basename(path)}`, 204);
    }
    await session.api("POST", `/api/uploads/${upload.id}/complete`, {});
  }
}

/** Every file measured, drawn and analysed, as far as it will go. */
async function settled(session: Session, projectId: string): Promise<SeededFile[]> {
  const done = (s: string) => s === "ready" || s === "failed" || s === "none";
  for (let tries = 0; tries < 120; tries++) {
    const { files } = await session.api<{ files: SeededFile[] }>(
      "GET",
      `/api/projects/${projectId}/files`,
    );
    if (files.every((f) => done(f.streamStatus) && done(f.analysisStatus))) return files;
    await sleep(1000);
  }
  throw new Error("The media worker did not finish in time");
}

/** Fills a fresh instance, and says what it made. */
export async function seed<S extends Session>(options: SeedOptions<S>): Promise<Seeded> {
  const { client, sql } = options;
  const owner = client.owner;
  const media = options.media ?? mkdtempSync(join(tmpdir(), "hekate-demo-"));
  mkdirSync(media, { recursive: true });
  const file = (name: string) => join(media, name);
  recording(file("Maple Leaf Rag - Mix v1.wav"), 40, 0.6);
  recording(file("Maple Leaf Rag - Dry v2.wav"), 40, 0.8, true);
  recording(file("Maple Leaf Rag - Wet v2.wav"), 40, 1);
  recording(file("Maple Leaf Rag - Dry v3.wav"), 40, 0.9);
  writeFileSync(file("Maple Leaf Rag - Score.pdf"), samplePdf(3, { bars: true }));
  const takeFiles = [1, 2, 3, 4].map((n) => file(`Maple Leaf Rag - T${n}.wav`));
  takeFiles.forEach((path, i) => {
    recording(path, 6 + i * 2, 0.7);
  });
  cut(file("Opening titles - Cut 3.mp4"));
  cut(file("Title sequence - Cut 1 - 16x9.mp4"));
  cut(file("Title sequence - Cut 1 - 9x16.mp4"), "360x640");
  // The next cut looks unlike the first, so comparing them shows which is which (#147).
  cut(file("Title sequence - Cut 2 - 16x9.mp4"), "1280x720", "smptehdbars");

  // The first person sets up the workspace (decision 061): the setup code opens the route,
  // and its answer signs the owner in.
  const created = await owner.fetch("/api/setup", {
    method: "POST",
    headers: { ...json, [SETUP_CODE_HEADER]: options.setupCode },
    body: JSON.stringify({
      name: accounts.alex.name,
      email: accounts.alex.email,
      password: PASSWORD,
      organisation: accounts.alex.workspace,
    }),
  });
  await check(created, "POST /api/setup", 201);
  await options.afterSetup?.(owner);
  const { user } = await owner.api<{ user: { id: string } }>("GET", "/api/me");

  const { project: music } = await owner.api<{ project: { id: string } }>("POST", "/api/projects", {
    name: "Joplin Rags",
    profile: "music",
    description: "Six rags for solo piano, recorded over two days in the hall.",
  });
  const { project: video } = await owner.api<{ project: { id: string } }>("POST", "/api/projects", {
    name: "Opening titles",
    profile: "video",
    description: "The title sequence and its cuts, for picture lock.",
  });

  await upload(owner, music.id, [
    file("Maple Leaf Rag - Mix v1.wav"),
    file("Maple Leaf Rag - Dry v2.wav"),
    file("Maple Leaf Rag - Wet v2.wav"),
    file("Maple Leaf Rag - Dry v3.wav"),
    file("Maple Leaf Rag - Score.pdf"),
  ]);
  await upload(owner, video.id, [
    file("Opening titles - Cut 3.mp4"),
    file("Title sequence - Cut 1 - 16x9.mp4"),
    file("Title sequence - Cut 1 - 9x16.mp4"),
    file("Title sequence - Cut 2 - 16x9.mp4"),
  ]);
  const musicFiles = await settled(owner, music.id);
  const videoFiles = await settled(owner, video.id);
  const cutFile = videoFiles.find((f) => f.name === "Opening titles - Cut 3.mp4");
  const named = (part: string) => {
    const found = musicFiles.find((f) => f.name.includes(part));
    if (!found) throw new Error(`No file named like ${part}`);
    return found.id;
  };
  const score = named("Score");
  const dry = named("Dry v2");
  if (!cutFile) throw new Error("The cut did not upload");
  // Its caption tracks, from sidecar files (#146, #201): English subtitles, and French
  // captions for the deaf and hard of hearing, whose language and kind its name and header say.
  const caption = async (name: string, query: string, text: string) => {
    const added = await owner.fetch(`/api/files/${cutFile.id}/captions?${query}`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(name),
      },
      body: Buffer.from(text),
    });
    await check(added, `caption ${name}`);
  };
  await caption(
    "Opening titles - Cut 3 - English.srt",
    "label=English&language=en&kind=subtitles",
    [
      "1",
      "00:00:00,000 --> 00:00:02,500",
      "ENDLESS HALL RECORDS",
      "PRESENTS",
      "",
      "2",
      "00:00:03,000 --> 00:00:05,500",
      "Every hall has a sound of its own.",
      "",
      "3",
      "00:00:06,000 --> 00:00:08,000",
      "OPENING TITLES",
      "",
      "4",
      "00:00:08,500 --> 00:00:11,500",
      "We recorded at night,",
      "when the city was quiet.",
      "",
    ].join("\n"),
  );
  await caption(
    "Opening titles - Cut 3.fr.sdh.vtt",
    `label=${encodeURIComponent("French (SDH)")}`,
    [
      "WEBVTT",
      "",
      "00:00.000 --> 00:02.500",
      "ENDLESS HALL RECORDS PRÉSENTE",
      "",
      "00:03.000 --> 00:05.500",
      "NARRATEUR : Chaque salle a son propre son.",
      "",
      "00:06.000 --> 00:08.000",
      "[Piano doux]",
      "",
    ].join("\n"),
  );

  // A deliverable (#16): a track in the video project, its first cut in two renditions, one
  // said to be clean and graded.
  const { track: deliverable } = await owner.api<{ track: { id: string } }>(
    "POST",
    `/api/projects/${video.id}/tracks`,
    { name: "Title sequence" },
  );
  const rendition = (part: string) => {
    const found = videoFiles.find((f) => f.name.includes(part));
    if (!found) throw new Error(`No rendition named like ${part}`);
    return found.id;
  };
  const { track: withCut } = await owner.api<{
    track: { versions: { variants: { id: string }[] }[] };
  }>("POST", `/api/tracks/${deliverable.id}/versions`, {
    notes: "Picture lock candidate.",
    variants: [
      { fileId: rendition("16x9"), name: "Main" },
      { fileId: rendition("9x16"), name: "Social" },
    ],
  });
  const main = withCut.versions[0]?.variants[0];
  if (main) {
    await owner.api("PATCH", `/api/variants/${main.id}`, { subtitled: false, graded: true });
  }
  // Its second cut, to compare with the first frame by frame (#147).
  await owner.api("POST", `/api/tracks/${deliverable.id}/versions`, {
    notes: "Titles moved up a second.",
    variants: [{ fileId: rendition("Cut 2"), name: "Main" }],
  });

  // A track in two versions, and one not yet started.
  const { track } = await owner.api<{ track: { id: string } }>(
    "POST",
    `/api/projects/${music.id}/tracks`,
    { name: "Maple Leaf Rag", scoreFileId: score },
  );
  await owner.api("POST", `/api/tracks/${track.id}/versions`, {
    notes: "First edit from the Tuesday sessions.",
    variants: [{ fileId: named("Mix v1"), name: "Mix" }],
  });
  const { track: withTwo } = await owner.api<{ track: { versions: { id: string }[] } }>(
    "POST",
    `/api/tracks/${track.id}/versions`,
    {
      notes: "Bars 12 to 16 replaced with take 7.",
      variants: [
        { fileId: dry, name: "Dry" },
        { fileId: named("Wet v2"), name: "Wet" },
      ],
    },
  );
  // Four takes of it from the sessions (#21), in a folder of their own: three with bars, rated
  // and noted, leaving bars 17 to 24 uncovered, and one without bars.
  const { folder: sessionFolder } = await owner.api<{ folder: { id: string } }>(
    "POST",
    `/api/projects/${music.id}/folders`,
    { name: "Session takes" },
  );
  await upload(owner, music.id, takeFiles, sessionFolder.id);
  const takeIds = (await settled(owner, music.id))
    .filter((f) => /T\d\.wav$/.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => f.id);
  const { takes } = await owner.api<{ takes: { id: string }[] }>(
    "POST",
    `/api/tracks/${track.id}/takes`,
    { fileIds: takeIds },
  );
  const takeDetails = [
    {
      barFrom: 1,
      barTo: 16,
      page: 1,
      rating: 2,
      notes: "Warm-up run. Tempo settles after the repeat.",
      timecodeIn: "10:08:30:00",
      timecodeOut: "10:12:01:00",
    },
    {
      barFrom: 1,
      barTo: 16,
      page: 1,
      rating: 4,
      starred: true,
      notes: "Good opening, pedal noise at bar 5.",
      timecodeIn: "10:14:02:00",
      timecodeOut: "10:19:40:00",
      falseStarts: 1,
    },
    {
      barFrom: 25,
      barTo: 48,
      page: 2,
      rating: 5,
      starred: true,
      label: "Insert",
      notes: "Keeper into the trio. Lovely rubato.",
      timecodeIn: "10:26:11:00",
      timecodeOut: "10:30:52:00",
      falseStarts: 2,
    },
    { rating: 3, notes: "Safety through the coda." },
  ];
  for (const [i, change] of takeDetails.entries()) {
    const take = takes[i];
    if (take) await owner.api("PATCH", `/api/takes/${take.id}`, change);
  }
  // The day they were recorded (#21, #45): three of the takes, the fourth from another day.
  const { session: dayTwo } = await owner.api<{ session: { id: string } }>(
    "POST",
    `/api/projects/${music.id}/sessions`,
    {
      name: "Day 2",
      recordedOn: "2026-10-13",
      venue: "Endless Hall, studio 2",
      trackIds: [track.id],
    },
  );
  await owner.api("POST", `/api/projects/${music.id}/sessions`, {
    name: "Day 3",
    recordedOn: "2026-10-14",
    venue: "Endless Hall, studio 2",
  });
  for (const take of takes.slice(0, 3))
    await owner.api("PATCH", `/api/takes/${take.id}`, { sessionId: dayTwo.id });
  // What the room kept beside the take log on the day (#51).
  await owner.api("PATCH", `/api/sessions/${dayTwo.id}`, {
    notes: "Piano a touch bright after lunch; room pair up 1 dB.",
    reference: "Trio from bar 25, repeat taken. Keep T2's opening.",
  });
  const tuner = await owner.api<{ todo: { id: string } }>(
    "POST",
    `/api/sessions/${dayTwo.id}/todos`,
    { text: "Tell the tuner about the A" },
  );
  await owner.api("PATCH", `/api/sessions/${dayTwo.id}/todos/${tuner.todo.id}`, { done: true });
  await owner.api("POST", `/api/sessions/${dayTwo.id}/todos`, {
    text: "Pick-ups for bars 17 to 19",
  });
  // The producer's marks on its score (#52): an edit plot through takes 2, 3 and 4, an issue
  // fixed by take 3, a wrong note, a dynamic and a note.
  const marking = await owner.api<{ categories: { id: string; name: string }[] }>(
    "GET",
    `/api/tracks/${track.id}/score-marks`,
  );
  const noise = marking.categories.find((c) => c.name === "Noise")?.id;
  for (const mark of [
    { kind: "edit", page: 1, x: 0.12, y: 0.16, barFrom: 1, to: 2 },
    { kind: "edit", page: 1, x: 0.3, y: 0.52, barFrom: 9, from: 2, to: 3 },
    { kind: "edit", page: 1, x: 0.16, y: 0.86, barFrom: 17, from: 3, to: 4 },
    {
      kind: "issue",
      page: 1,
      x: 0.62,
      y: 0.3,
      width: 0.2,
      height: 0.06,
      barFrom: 5,
      text: "Pedal noise",
      categoryId: noise,
      takes: [1, 2],
      fixedBy: 3,
    },
    { kind: "wrong-note", page: 1, x: 0.7, y: 0.55, barFrom: 9, text: "LH F sharp" },
    {
      kind: "issue",
      page: 1,
      x: 0.45,
      y: 0.5,
      barFrom: 9,
      barTo: 12,
      text: "Left hand rushes",
      categoryId: marking.categories.find((c) => c.name === "Ensemble")?.id,
      takes: [1],
      fixedBy: 2,
    },
    { kind: "dynamic", page: 1, x: 0.85, y: 0.7, barFrom: 13, text: "mp, not mf" },
    {
      kind: "note",
      page: 1,
      x: 0.9,
      y: 0.12,
      barFrom: 1,
      text: "Tempo settles by bar 3; keep T2's opening.",
    },
  ])
    await owner.api("POST", `/api/tracks/${track.id}/score-marks`, mark);
  // The patch list (#54): one stage box, as the prototype has it.
  const patched: Record<string, string> = {};
  const { box } = await owner.api<{ box: { id: string } }>(
    "POST",
    `/api/projects/${music.id}/stage-boxes`,
    { name: "Stage box A" },
  );
  for (const row of [
    { direction: "input", source: "Main L", device: "DPA 4006", cable: "A1" },
    { direction: "input", source: "Main R", device: "DPA 4006", cable: "A2" },
    {
      direction: "input",
      source: "Spot piano L",
      device: "Schoeps MK4",
      cable: "A3",
      notes: "Lid on the short stick",
    },
    { direction: "input", source: "Spot piano R", device: "Schoeps MK4", cable: "A4" },
    { direction: "input", source: "Room L", device: "Neumann KM 183", cable: "A5" },
    { direction: "input", source: "Room R", device: "Neumann KM 183", cable: "A6" },
    {
      direction: "output",
      source: "Talkback",
      device: "Headphone amp",
      cable: "B1",
      notes: "To the piano",
    },
    { direction: "output", source: "Cue mix", device: "Headphone amp", cable: "B2" },
  ]) {
    const { row: made } = await owner.api<{ row: { id: string } }>(
      "POST",
      `/api/stage-boxes/${box.id}/rows`,
      row,
    );
    patched[row.source] = made.id;
  }
  // The stage plan (#53), as the prototype draws it: its microphones on the patch above.
  const { plan } = await owner.api<{ plan: { id: string } }>(
    "POST",
    `/api/projects/${music.id}/stage-plans`,
    { name: "Endless Hall", width: 12, depth: 8 },
  );
  // Time-ordered ids, as the app makes them, so the plan draws in the order things were put down.
  // One moment for all of them, so an item is named the same each time it is asked for.
  const putDown = Date.now();
  const itemId = (n: number) =>
    `${(putDown + n)
      .toString(16)
      .padStart(12, "0")
      .replace(/^(.{8})(.{4})$/, "$1-$2")}-7000-8000-${n.toString(16).padStart(12, "0")}`;
  const mic = (n: number, source: string, x: number, y: number, group: string) => ({
    id: itemId(n),
    kind: "mic",
    x,
    y,
    w: 0.3,
    h: 0.3,
    patchRowId: patched[source],
    group,
  });
  await owner.api("POST", `/api/stage-plans/${plan.id}/edits`, {
    add: [
      { id: itemId(1), kind: "wall", label: "Rear wall", x: 0, y: 0, w: 12, h: 0.2 },
      { id: itemId(2), kind: "riser", label: "Riser", x: 7.2, y: 1.8, w: 2.4, h: 2.4 },
      { id: itemId(3), kind: "piano", label: "Piano", x: 4.5, y: 2, w: 2.7, h: 1.6, rotation: -20 },
      { id: itemId(4), kind: "performer", label: "Piano", x: 4.4, y: 4, w: 0.6, h: 0.6 },
      { id: itemId(5), kind: "performer", label: "Violin", x: 7.8, y: 3.4, w: 0.6, h: 0.6 },
      { id: itemId(6), kind: "performer", label: "Cello", x: 8.8, y: 2.6, w: 0.6, h: 0.6 },
      mic(7, "Main L", 5.2, 5.6, "Main pair"),
      mic(8, "Main R", 6.8, 5.6, "Main pair"),
      mic(9, "Spot piano L", 4.8, 1.6, "Piano spots"),
      mic(10, "Spot piano R", 6.6, 1.4, "Piano spots"),
      mic(11, "Room L", 2, 7, "Room pair"),
      mic(12, "Room R", 10, 7, "Room pair"),
      { id: itemId(13), kind: "label", label: "Audience", x: 5.2, y: 7.4, w: 1.6, h: 0.4 },
    ],
  });
  // The hall's floor plan, drawn under the stage plan (#53): 16 m across, the stage's back wall
  // a metre in from the top.
  const m = 841.89 / 16;
  const hall = [
    "0.2 G 2 w 8 8 825.89 579.28 re S",
    `0.4 G 1 w ${2 * m} ${595.28 - m - 8 * m} ${12 * m} ${8 * m} re S`,
    "0.5 G 0.6 w",
    ...Array.from({ length: 2 }, (_, row) =>
      Array.from(
        { length: 14 },
        (_, seat) =>
          `${1.2 * m + seat * m} ${595.28 - 9.6 * m - row * 0.9 * m} ${0.7 * m} ${0.6 * m} re S`,
      ).join("\n"),
    ),
    `0.3 g 0 ${595.28 - 4 * m} 8 ${1.2 * m} re f ${841.89 - 8} ${595.28 - 4 * m} 8 ${1.2 * m} re f`,
    "BT /H 14 Tf 0.35 g 24 570 Td (Endless Hall, ground floor) Tj ET",
  ].join("\n");
  writeFileSync(
    file("Endless Hall - Floor plan.pdf"),
    textPdfOf([{ points: { width: 841.89, height: 595.28 }, content: hall }]),
  );
  const { folder: venueFolder } = await owner.api<{ folder: { id: string } }>(
    "POST",
    `/api/projects/${music.id}/folders`,
    { name: "Venue" },
  );
  await upload(owner, music.id, [file("Endless Hall - Floor plan.pdf")], venueFolder.id);
  const floorPlan = (await settled(owner, music.id)).find(
    (f) => f.name === "Endless Hall - Floor plan.pdf",
  );
  await owner.api("PATCH", `/api/stage-plans/${plan.id}`, {
    underlay: { fileId: floorPlan?.id, x: -2, y: -1, width: 16, opacity: 0.35 },
  });
  // V2's edit decision list, given after it was made (#56): takes 2, 3 and 4, and a
  // pick-up recorded apart, which is no take of the track.
  const edlPath = file("Maple Leaf Rag - V2.edl");
  writeFileSync(
    edlPath,
    [
      "TITLE: MAPLE LEAF RAG V2",
      "FCM: NON-DROP FRAME",
      "",
      "001  MAPLELEA AA     C        00:00:00:00 00:00:06:00 01:00:00:00 01:00:06:00",
      "* FROM CLIP NAME: Maple Leaf Rag - T2.wav",
      "002  MAPLELEA AA     C        00:00:01:00 00:00:09:00 01:00:06:00 01:00:14:00",
      "* FROM CLIP NAME: Maple Leaf Rag - T3.wav",
      "003  PICKUP   AA     C        00:00:00:00 00:00:03:00 01:00:14:00 01:00:17:00",
      "* FROM CLIP NAME: Pick-up, bar 17.wav",
      "004  T4       AA     C        00:00:02:00 00:00:10:00 01:00:17:00 01:00:25:00",
      "",
    ].join("\n"),
  );
  await upload(owner, music.id, [edlPath], sessionFolder.id);
  const edlFile = (await settled(owner, music.id)).find((f) => f.name.endsWith("V2.edl"));
  const v2 = withTwo.versions.at(-1);
  if (!edlFile || !v2) throw new Error("The edit decision list did not upload");
  await owner.api("PUT", `/api/versions/${v2.id}/edl`, { fileId: edlFile.id });
  // From here on a version needs an edit decision list (#131): the next one is refused.
  await owner.api("PATCH", `/api/projects/${music.id}`, { requireEdl: true });
  // Its set-up, saved for the next recording to start from (#240).
  await owner.api("POST", `/api/projects/${music.id}/template`, { name: "Solo recital" });
  const { track: entertainer } = await owner.api<{ track: { id: string } }>(
    "POST",
    `/api/projects/${music.id}/tracks`,
    { name: "The Entertainer" },
  );

  // Workspace tags on two files, and the owner's own pin and favourite.
  type Made = { tag: { id: string } };
  const { tag: masters } = await owner.api<Made>("POST", "/api/tags", { name: "Masters" });
  const { tag: print } = await owner.api<Made>("POST", "/api/tags", { name: "For print" });
  await owner.api<Made>("POST", "/api/tags", { name: "Reference" });
  await owner.api("PUT", `/api/files/${dry}/tags`, { tagIds: [masters.id] });
  await owner.api("PUT", `/api/files/${score}/tags`, { tagIds: [print.id, masters.id] });
  for (const body of [
    { items: [{ kind: "track", id: entertainer.id }], pinned: true },
    { items: [{ kind: "file", id: score }], favourite: true },
  ]) {
    const marked = await owner.fetch(`/api/projects/${music.id}/marks`, {
      method: "POST",
      headers: json,
      body: JSON.stringify(body),
    });
    await check(marked, `POST /api/projects/${music.id}/marks`, 204);
  }

  // Comments of every kind.
  type Created = { comment: { id: string } };
  const comment = (fileId: string, body: string, anchor?: unknown, parentId?: string) =>
    owner.api<Created>("POST", `/api/files/${fileId}/comments`, { body, anchor, parentId });
  // About the left channel alone (#74).
  const pedal = await owner.api<Created>("POST", `/api/files/${dry}/comments`, {
    body: "Pedal noise on the left, just before the downbeat.",
    anchor: { kind: "time", start: 6.2, end: 6.2 },
    channel: 0,
  });
  const drop = await comment(dry, "The bass drops out here for half a bar. Intentional?", {
    kind: "time",
    start: 21.4,
    end: 23,
  });
  await comment(dry, "Yes, it is in the score. Leaving it.", undefined, drop.comment.id);
  const lift = await comment(dry, "Lovely lift into the trio.", {
    kind: "time",
    start: 33,
    end: 33,
  });
  await owner.api("POST", `/api/comments/${lift.comment.id}/resolve`, { resolved: true });
  const rushes = await comment(dry, "The left hand rushes through these bars.", {
    kind: "bar",
    from: { bar: 9 },
    to: { bar: 12 },
    at: 14.2,
  });
  // The opening takes, shared on that thread for whoever reviews it to hear (#133).
  await owner.api("POST", `/api/comments/${rushes.comment.id}/takes`, {
    takeIds: takes.slice(0, 1).map((t) => t.id),
  });
  // A mention from the picker (#133): Alex notes it for himself.
  await owner.api("POST", `/api/files/${dry}/comments`, {
    body: "Overall balance is great; @Alex Rivera, the reverb tail could be a touch shorter.",
    mentions: [user.id],
  });
  // A photo of the bass part, attached to the thread about it (#133).
  const attached = await owner.fetch(`/api/files/${dry}/comments/${drop.comment.id}/attachments`, {
    method: "POST",
    headers: {
      "content-type": "image/png",
      "x-file-name": encodeURIComponent("Bass part, bar 11.png"),
    },
    body: Buffer.from("a picture of the bass part, marked"),
  });
  await check(attached, "POST attachment", 201);
  // Triage (#36): the pedal noise waits for noise reduction; the rushing is someone's to fix.
  const { categories } = await owner.api<{ categories: { id: string; name: string }[] }>(
    "GET",
    `/api/projects/${music.id}/categories`,
  );
  const categoryId = (name: string) => categories.find((c) => c.name === name)?.id;
  await owner.api("POST", `/api/files/${dry}/comments/triage`, {
    commentIds: [pedal.comment.id],
    categoryId: categoryId("Noise"),
  });
  await owner.api("POST", `/api/files/${dry}/comments/triage`, {
    commentIds: [rushes.comment.id],
    categoryId: categoryId("Performance"),
    assigneeId: user.id,
  });
  // And it is a task (#133).
  await owner.api("POST", `/api/comments/${rushes.comment.id}/todo`, { todo: true });
  // The project's tasks (#140): by hand, one late, one waiting for approval, one done.
  const task = (body: Record<string, unknown>) =>
    owner
      .api<{ task: { id: string } }>("POST", `/api/projects/${music.id}/tasks`, body)
      .then((r) => r.task.id);
  const moveTask = (id: string, status: string) =>
    owner.api("PATCH", `/api/tasks/${id}`, { status });
  const lateTask = await task({
    title: "Re-export the stems at 96 kHz",
    priority: "high",
    assigneeId: user.id,
    dueOn: "2026-10-12",
    trackId: track.id,
    notes: "The label's mastering engineer asked for the higher rate.",
  });
  await moveTask(lateTask, "in_progress");
  await task({
    title: "Check the page turns in the score",
    dueOn: "2026-10-21",
    trackId: track.id,
  });
  // The track's own deadline (#505), already past: late on its card, the calendar and the
  // timeline. And what is booked around it: a meeting over two days and a delivery.
  await owner.api("PATCH", `/api/tracks/${track.id}`, { dueAt: "2026-10-12T17:00:00Z" });
  await owner.api("POST", `/api/projects/${music.id}/calendar/entries`, {
    kind: "meeting",
    title: "Listening meeting with the label",
    startsOn: "2026-10-20",
    endsOn: "2026-10-21",
    trackId: track.id,
    attendees: [user.id],
  });
  await owner.api("POST", `/api/projects/${music.id}/calendar/entries`, {
    kind: "delivery",
    title: "Masters to the label",
    startsOn: "2026-10-30",
  });
  const cover = await task({
    title: "Approve the cover artwork",
    priority: "low",
    assigneeId: user.id,
  });
  await moveTask(cover, "needs_approval");
  const notes = await task({ title: "Send the session notes to the label", assigneeId: user.id });
  await moveTask(notes, "done");
  await comment(score, "This dynamic is printed as mp in the parts.", {
    kind: "region",
    page: 1,
    x: 0.1,
    y: 0.12,
    width: 0.5,
    height: 0.08,
  });
  await comment(cutFile.id, "The title card holds a beat too long.", {
    kind: "time",
    start: 4,
    end: 6,
  });
  // Drawn on the frame (#146): a box round the logo.
  await comment(cutFile.id, "Logo sits too close to the edge here.", {
    kind: "region",
    at: 8,
    x: 0.7,
    y: 0.75,
    width: 0.25,
    height: 0.2,
    drawing: {
      tool: "box",
      colour: "signal",
      points: [
        [0.7, 0.75],
        [0.95, 0.95],
      ],
    },
  });

  // An approval review, with a guest.
  const { review } = await owner.api<{ review: { id: string } }>(
    "POST",
    `/api/projects/${music.id}/reviews`,
    {
      kind: "approval",
      title: "Album masters",
      message: "Final masters for the album. Listen on headphones and on speakers, please.",
      dueAt: "2026-10-30T17:00:00Z",
      order: "parallel",
      items: [{ trackId: track.id }, { fileId: score }],
      reviewers: [user.id, { name: "Mira Solberg", email: "mira@example.test" }],
    },
  );

  // A group of guests the request form can ask together (#130).
  const soloists = await owner.api<{ group: { id: string } }>(
    "POST",
    `/api/projects/${music.id}/groups`,
    {
      name: "Soloists",
      members: [
        { name: "Mira Solberg", email: "mira@example.test", label: "Violin" },
        { name: "Ines Arlow", email: "ines@example.test", label: "Piano" },
      ],
    },
  );
  // Their own player tools in this project (decision 258): the score, compare and loops.
  await owner.api("POST", `/api/projects/${music.id}/tool-exceptions`, {
    groupId: soloists.group.id,
    tools: ["score", "compare", "loops"],
  });

  // The repertoire and venues (#48): the rags as one work, numbered as the score prints them.
  await owner.api("POST", `/api/projects/${music.id}/works`, {
    title: "Rags",
    composer: "Scott Joplin",
    forces: "Piano trio",
    abbreviation: "RAGS",
    notes: "Two rags in the trio arrangement; more to follow.",
    scoreFileId: score,
    tracks: [
      { trackId: track.id, number: "1", pageFrom: 1, pageTo: 2 },
      { trackId: entertainer.id, number: "2", pageFrom: 3 },
    ],
  });
  const venueIds: string[] = [];
  for (const venue of [
    {
      name: "Endless Hall",
      address: "Mill Lane\nBristol",
      notes: "Get-in by the north door; the piano is tuned on the morning of day 1.",
    },
    { name: "Endless Hall Studio 2", address: "Unit 4, Mill Lane\nBristol", notes: "" },
  ])
    venueIds.push(
      (
        await owner.api<{ venue: { id: string } }>(
          "POST",
          `/api/projects/${music.id}/venues`,
          venue,
        )
      ).venue.id,
    );

  // The schedule (#50): two days, the first worked through and ticked off, the second ahead.
  for (const [day, rows] of [
    [
      { label: "Day 1", date: "2026-09-12", venueId: venueIds[0], start: "09:00" },
      [
        {
          kind: "get-in",
          minutes: 60,
          label: "Get-in and rig",
          personnel: "Engineer, producer",
          done: true,
        },
        {
          kind: "slot",
          minutes: 90,
          trackIds: [track.id],
          personnel: "Trio",
          notes: "Sections A and B first.",
          done: true,
        },
        { kind: "break", minutes: 20, label: "Coffee", done: true },
        { kind: "slot", minutes: 70, trackIds: [entertainer.id], personnel: "Trio" },
        { kind: "break", start: "13:00", minutes: 60, label: "Lunch" },
        {
          kind: "slot",
          minutes: 120,
          allRepertoire: true,
          personnel: "Trio",
          notes: "Pick-ups at the end if time.",
        },
      ],
    ],
    [
      { label: "Day 2", date: "2026-09-13", venueId: venueIds[1], start: "10:00" },
      [
        { kind: "venue", minutes: 30, label: "Move to Studio 2" },
        { kind: "slot", minutes: 150, workIds: [], trackIds: [entertainer.id], personnel: "Trio" },
      ],
    ],
  ] as const) {
    const made = await owner.api<{ day: { id: string } }>(
      "POST",
      `/api/projects/${music.id}/schedule-days`,
      day,
    );
    for (const { done, ...row } of rows as readonly ({ done?: boolean } & Record<
      string,
      unknown
    >)[]) {
      const added = await owner.api<{ row: { id: string } }>(
        "POST",
        `/api/schedule-days/${made.day.id}/rows`,
        row,
      );
      if (done) await owner.api("PATCH", `/api/schedule-rows/${added.row.id}/done`, { done: true });
    }
  }

  // Personnel (#49), as the prototype lists it: linked to the project's members and guests.
  const { people } = await owner.api<{ people: { kind: string; id: string; name: string }[] }>(
    "GET",
    `/api/projects/${music.id}/personnel`,
  );
  const known = (name: string) => {
    const p = people.find((x) => x.name === name);
    if (!p) return null;
    return p.kind === "member"
      ? { kind: "member", userId: p.id }
      : { kind: "guest", guestId: p.id };
  };
  for (const entry of [
    {
      name: "Mira Solberg",
      kind: "artist",
      role: "Conductor",
      agreement: true,
      link: known("Mira Solberg"),
    },
    {
      name: "Ines Arlow",
      kind: "artist",
      role: "Piano",
      agreement: true,
      headphones: true,
      link: known("Ines Arlow"),
    },
    {
      name: "Alex Rivera",
      kind: "staff",
      role: "Producer",
      agreement: true,
      headphones: true,
      link: known("Alex Rivera"),
    },
    {
      name: "Endless Hall Strings",
      kind: "ensemble",
      role: "Strings",
      sections: [
        {
          name: "Violin I",
          count: 4,
          divisi: "2 + 2",
          members: [{ name: "Tomas Varga", agreement: true, headphones: true }],
        },
        { name: "Violin II", count: 3 },
        { name: "Viola", count: 2 },
        { name: "Cello", count: 2 },
        { name: "Bass", count: 1 },
      ],
      seating: "Antiphonal violins; basses behind the cellos.",
    },
    { name: "Piano technician", kind: "other", role: "Tuning" },
  ])
    await owner.api("POST", `/api/projects/${music.id}/personnel`, entry);
  // The pianist on the stage plan is Ines Arlow on the personnel, and named by it.
  const { personnel: listed } = await owner.api<{ personnel: { id: string; name: string }[] }>(
    "GET",
    `/api/projects/${music.id}/personnel`,
  );
  await owner.api("POST", `/api/stage-plans/${plan.id}/edits`, {
    change: [{ id: itemId(4), personnelId: listed.find((p) => p.name === "Ines Arlow")?.id }],
  });

  // Alex hears when a guest opens a review they asked for.
  await owner.api("PUT", "/api/notifications/preferences", {
    mailMode: "instant",
    digest: "daily",
    kinds: { guest_opened: { app: true, mail: false } },
  });

  // The label's branding (#185): a logo and an accent, which every guest page then shows.
  const logoPath = join(media, "endless-hall-logo.png");
  execFileSync("ffmpeg", [
    ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi"],
    "-i",
    [
      "color=c=black@0.0:s=480x128",
      "format=rgba",
      "drawbox=x=0:y=24:w=80:h=80:color=0x4fb3a9@1:t=fill",
      "drawbox=x=104:y=40:w=360:h=18:color=0xf4f4f5@1:t=fill",
      "drawbox=x=104:y=72:w=220:h=14:color=0xa1a1aa@1:t=fill",
      // drawbox leaves the ground's alpha as it was: what it drew is made opaque here.
      "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(r(X,Y)+g(X,Y)+b(X,Y),255,0)'",
    ].join(","),
    ...["-frames:v", "1", "-c:v", "png", "-f", "image2", "-update", "1", logoPath],
  ]);
  const branded = await owner.fetch("/api/organisation/branding/logo", {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: readFileSync(logoPath),
  });
  await check(branded, "POST /api/organisation/branding/logo");
  const { branding } = await owner.api<{
    branding: { logo: { blobId: string; width: number; height: number } };
  }>("PUT", "/api/organisation/branding/accent", { accent: "#4fb3a9" });
  const { activeOrganisationId: labelId } = await owner.api<{ activeOrganisationId: string }>(
    "GET",
    "/api/me",
  );
  const brandLogo = {
    url: `/api/branding/${labelId}/logo/${branding.logo.blobId}`,
    width: branding.logo.width,
    height: branding.logo.height,
  };

  // An invitation waiting to be accepted.
  const { link: invitation } = await owner.api<{ link: string }>(
    "POST",
    "/api/organisation/invitations",
    {
      email: "tomas@example.test",
      role: "member",
    },
  );

  // An upload request (#139) for someone outside to send the string stems, nothing arrived yet.
  const { link: uploadLink } = await owner.api<{ link: string }>(
    "POST",
    `/api/projects/${music.id}/upload-requests`,
    {
      name: "String stems",
      wanted: "The string stems of Maple Leaf Rag, 96 kHz, one file per section.",
      folderId: sessionFolder.id,
      fileLimit: 5,
      expiresOn: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
    },
  );
  // And one (#425) whose file becomes Maple Leaf Rag's next version once measured.
  await owner.api("POST", `/api/projects/${music.id}/upload-requests`, {
    name: "Next mix",
    wanted: "The next mix of Maple Leaf Rag, with the piano brought forward.",
    folderId: null,
    trackId: track.id,
    fileLimit: 1,
    expiresOn: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
  });

  // The guest signs in from the link they were sent, which only the mail holds (the server's
  // log, without a mail server): where nothing can read it, the guest's visit is left out.
  const guestLink = await options.guestLink?.();
  const usedGuestPath = guestLink
    ? guestLink.startsWith("http")
      ? new URL(guestLink).pathname
      : guestLink
    : "";
  if (usedGuestPath) {
    const guest = await client.session();
    await guest.api("POST", "/api/guest/sessions", { token: usedGuestPath.split("/").at(-1) });
    // The guest has looked, and answers Alex by name: two notifications for the bell.
    await guest.api("POST", `/api/reviews/${review.id}/viewed`, {});
    await guest.api("POST", `/api/files/${dry}/comments`, {
      body: "@Alex Rivera the pedal noise is gone in the wet mix.",
    });
    await options.afterGuest?.(guest);
    await guest.close?.();
  }

  // A review in each state its page shows (#129), made after the guest's link was read.
  const ask = async (title: string, body: Record<string, unknown>) =>
    (
      await owner.api<{ review: { id: string } }>("POST", `/api/projects/${music.id}/reviews`, {
        kind: "approval",
        title,
        order: "parallel",
        items: [{ trackId: track.id }],
        reviewers: [user.id],
        ...body,
      })
    ).review.id;
  const decide = (id: string, decision: string, note?: string) =>
    owner.api("POST", `/api/reviews/${id}/decisions`, { decision, ...(note ? { note } : {}) });
  const decided = await ask("Edit points", {
    reviewers: [user.id, { name: "Ines Arlow", email: "ines@example.test" }],
    dueAt: "2026-10-28T17:00:00Z",
  });
  await decide(decided, "approved", "The splice at 2:14 is clean now.");
  const changes = await ask("Rough mix", {});
  await decide(changes, "changes_requested", "The left hand is buried under the pedal.");
  const approved = await ask("Running order", { rule: "any" });
  await decide(approved, "approved");
  const cancelled = await ask("First masters", { dueAt: "2026-10-20T17:00:00Z" });
  await owner.api("POST", `/api/reviews/${cancelled}/cancel`, {
    reason: "Superseded by the album masters.",
  });
  // In steps, each named (#500): the engineer listens first, then the producer.
  const waiting = await ask("Producer's listen", {
    order: "sequence",
    reviewers: [
      {
        name: "Engineer",
        reviewers: [{ name: "Tomas Varga", email: "tomas.varga@example.test" }],
      },
      { name: "Producer", reviewers: [user.id] },
    ],
    dueAt: "2026-10-24T17:00:00Z",
  });
  // Alex has looked at what is asked of them, as anyone opening the inbox would have.
  await owner.api("POST", `/api/reviews/${review.id}/viewed`, {});
  const overdue = await ask("Sleeve notes", {
    kind: "feedback",
    rule: undefined,
    items: [{ fileId: score }],
    dueAt: "2026-10-10T17:00:00Z",
  });
  // A share (#138): the track for a guest to listen to, with nothing asked of her.
  const shared = await ask("Rehearsal takes", {
    kind: "share",
    reviewers: [{ name: "Mira Solberg", email: "mira@example.test", label: "Violin" }],
    message: "The rehearsal from Tuesday, for listening on the train.",
    permissions: { download: "proxy", expiresAt: "2026-10-31T23:59:59Z" },
  });

  // A general project (#149): the album's booklet in two proofs, the second replacing the
  // first, its cover as a picture and its print files as something with no viewer. The
  // second proof goes through an approval with comments on regions of its pages.
  const { project: general } = await owner.api<{ project: { id: string } }>(
    "POST",
    "/api/projects",
    {
      name: "Joplin Rags booklet",
      profile: "general",
      description: "The album's booklet, cover and print files, for sign-off.",
    },
  );
  writeFileSync(file("Booklet - proof 1.pdf"), samplePdf(3));
  writeFileSync(file("Booklet - proof 2.pdf"), samplePdf(4));
  writeFileSync(
    file("Print files.zip"),
    Buffer.from("PK\u0005\u0006".padEnd(22, "\u0000"), "latin1"),
  );
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "smptehdbars=size=1200x1200",
    "-frames:v",
    "1",
    file("Cover.png"),
  ]);
  await upload(owner, general.id, [file("Booklet - proof 1.pdf"), file("Cover.png")]);
  await upload(owner, general.id, [file("Booklet - proof 2.pdf"), file("Print files.zip")]);
  const generalFiles = await settled(owner, general.id);
  const booklet = (part: string) => {
    const found = generalFiles.find((f) => f.name.includes(part));
    if (!found) throw new Error(`No file named like ${part}`);
    return found.id;
  };
  const proof = booklet("proof 2");
  await owner.api("POST", `/api/files/${booklet("proof 1")}/next`, { fileId: proof });
  await comment(booklet("proof 1"), "The track list runs onto the fold.");
  const { review: signOff } = await owner.api<{ review: { id: string } }>(
    "POST",
    `/api/projects/${general.id}/reviews`,
    {
      kind: "approval",
      title: "Booklet sign-off",
      message: "The second proof, with the corrected track list. Approve it for print.",
      dueAt: "2026-10-29T17:00:00Z",
      order: "parallel",
      items: [{ fileId: proof }, { fileId: booklet("Cover") }],
      reviewers: [user.id],
    },
  );
  await comment(proof, "Kern the title a little tighter.", {
    kind: "region",
    page: 1,
    x: 0.1,
    y: 0.08,
    width: 0.62,
    height: 0.1,
  });
  await comment(proof, "This paragraph should match the label copy.", {
    kind: "region",
    page: 2,
    x: 0.1,
    y: 0.06,
    width: 0.5,
    height: 0.12,
  });
  await comment(booklet("Cover"), "The bars read well at thumbnail size.", {
    kind: "region",
    x: 0.05,
    y: 0.6,
    width: 0.9,
    height: 0.35,
  });
  await comment(booklet("Print files"), "These are the printer's final files.");
  await decide(signOff.id, "approved", "Good to print.");

  // Other workspaces on the instance (#174), one of them suspended: its owner is told why.
  const invited: Record<string, { id: string; link: string }> = {};
  for (const [name, slug, ownerEmail] of [
    ["North Choir Collective", "north-choir", "owner@north-choir.example"],
    [accounts.tomas.workspace, "saltmarsh", accounts.tomas.email],
  ] as const)
    invited[slug] = await owner.api<{ id: string; link: string }>(
      "POST",
      "/api/instance/workspaces",
      { name, slug, ownerEmail },
    );
  const saltmarshId = invited.saltmarsh?.id ?? "";
  // Saltmarsh Films' owner keeps a score there, for its quota (#175) to be measured against.
  const saltmarsh = await client.session();
  await saltmarsh.api(
    "POST",
    `/api/invitations/${invited.saltmarsh?.link.split("/invite/")[1]}/accept`,
    { name: accounts.tomas.name, password: PASSWORD },
  );
  const { user: tomas } = await saltmarsh.api<{ user: { id: string } }>("GET", "/api/me");
  const titles = await saltmarsh.api<{ project: { id: string } }>("POST", "/api/projects", {
    name: "Opening titles",
    profile: "video",
  });
  await upload(saltmarsh, titles.project.id, [file("Maple Leaf Rag - Score.pdf")]);
  await settled(saltmarsh, titles.project.id);
  await saltmarsh.close?.();
  const lanternMade = await owner.api<{ id: string; link: string }>(
    "POST",
    "/api/instance/workspaces",
    { name: accounts.mira.workspace, slug: "lantern", ownerEmail: accounts.mira.email },
  );
  const lantern = await client.session();
  await lantern.api("POST", `/api/invitations/${lanternMade.link.split("/invite/")[1]}/accept`, {
    name: accounts.mira.name,
    password: PASSWORD,
  });
  await owner.api("POST", `/api/instance/workspaces/${lanternMade.id}/suspend`, {
    reason: "The invoice for October is unpaid.",
  });
  await options.afterSuspended?.(lantern);
  await lantern.close?.();

  // Registration (#184): invite-only, with one invitation to make a workspace waiting.
  const { settings: instanceSettings } = await owner.api<{ settings: Record<string, unknown> }>(
    "GET",
    "/api/instance/settings",
  );
  await owner.api("PUT", "/api/instance/settings", {
    ...instanceSettings,
    registration: { mode: "invite" },
  });
  const { link: signUpLink } = await owner.api<{ link: string }>(
    "POST",
    "/api/instance/sign-up-invitations",
    { email: "owner@hollow-reed.example" },
  );

  // The project's workflows (#25, #26), made last so no version arrives to start them: the
  // album's review, switched on, and a delivery still a draft, with something to look at.
  const step = (
    id: string,
    type: string,
    name: string,
    x: number,
    y = 0,
    config: Record<string, string> = {},
  ) => ({ id, type, name, x: x * 320, y: y * 120, config });
  const { workflow: albumReview } = await owner.api<{ workflow: { id: string } }>(
    "POST",
    `/api/projects/${music.id}/workflows`,
    {
      name: "Album review",
      definition: {
        groups: [],
        nodes: [
          step("start", "upload", "A version is uploaded", 0),
          step("notes", "feedback", "Soloists' notes", 1, 0, {
            who: "Soloists",
            order: "In turn",
            status: "With the soloists",
            due: "3",
          }),
          step("edit", "task", "Engineer edits", 2, 0, { who: "Producer", status: "Editing" }),
          step("label", "approval", "Label approval", 3, 0, {
            who: "Reviewer",
            rule: "Everyone approves",
            status: "With the label",
            due: "5",
          }),
          step("done", "finish", "Approved", 4, 0, { status: "Approved" }),
          step("tell", "notify", "Tell the producer", 4, 1, {
            to: "Producer",
            message: "Some approved: decide.",
          }),
        ],
        connectors: [
          { id: "c1", from: "start", outcome: "happened", to: "notes" },
          { id: "c2", from: "notes", outcome: "done", to: "edit" },
          { id: "c3", from: "notes", outcome: "overdue", to: "edit" },
          { id: "c4", from: "edit", outcome: "done", to: "label" },
          { id: "c5", from: "edit", outcome: "overdue", to: "label" },
          { id: "c6", from: "label", outcome: "approved", to: "done" },
          { id: "c7", from: "label", outcome: "changes", to: "notes", until: { times: 3 } },
          { id: "c8", from: "label", outcome: "mixed", to: "tell" },
          { id: "c9", from: "tell", outcome: "sent", to: "done" },
        ],
      },
    },
  );
  await owner.api("PATCH", `/api/workflows/${albumReview.id}`, { active: true });
  await owner.api("POST", `/api/projects/${music.id}/workflows`, {
    name: "Delivery",
    definition: {
      groups: [],
      nodes: [
        step("start", "upload", "A version is uploaded", 0),
        step("qa", "checks", "Delivery checks", 1),
        step("file", "move", "File the master", 2, 0, { folder: "Masters" }),
        step("done", "finish", "Delivered", 3, 0, { status: "Delivered" }),
        step("tell", "notify", "Ask for a new export", 2, 1, {
          to: "Producer",
          message: "The master failed its checks.",
        }),
      ],
      connectors: [
        { id: "c1", from: "start", outcome: "happened", to: "qa" },
        { id: "c2", from: "qa", outcome: "passed", to: "file" },
        { id: "c3", from: "file", outcome: "moved", to: "done" },
        { id: "c4", from: "qa", outcome: "failed", to: "tell" },
        { id: "c5", from: "tell", outcome: "sent", to: "done" },
      ],
    },
  });
  // One started by hand on the track and moved on, so its page has a history of transitions
  // (#25): the run's start, which set a status, and a step ended by hand.
  const { workflow: mastering } = await owner.api<{ workflow: { id: string } }>(
    "POST",
    `/api/projects/${music.id}/workflows`,
    {
      name: "Mastering",
      definition: {
        groups: [],
        nodes: [
          // Below the album review's two rows, as the project's canvas draws its workflows together.
          step("start", "manual", "Started by hand", 0, 3),
          step("status", "status", "Mastering", 1, 3, { status: "Mastering" }),
          step("settle", "wait", "Let it settle", 2, 3, { days: "2" }),
          step("done", "finish", "Mastered", 3, 3, { status: "Mastered" }),
        ],
        connectors: [
          { id: "c1", from: "start", outcome: "happened", to: "status" },
          { id: "c2", from: "status", outcome: "set", to: "settle" },
          { id: "c3", from: "settle", outcome: "elapsed", to: "done" },
        ],
      },
    },
  );
  await owner.api("PATCH", `/api/workflows/${mastering.id}`, { active: true });
  const { run: masteringRun } = await owner.api<{ run: { id: string } }>(
    "POST",
    `/api/tracks/${track.id}/workflow-runs`,
    { workflowId: mastering.id },
  );
  await owner.api("POST", `/api/workflow-runs/${masteringRun.id}/steps`, {
    nodeId: "settle",
    outcome: "elapsed",
  });
  // Its run finished, it goes back off: the album review stays the project's one workflow
  // running, as the screens of a new version's restart and the canvas expect.
  await owner.api("PATCH", `/api/workflows/${mastering.id}`, { active: false });

  // API tokens (#198): two of the owner's own (one since run out) and a service token for the
  // release pipeline, whose calls, one of them refused for want of a scope, fill the API log.
  const { secret: pipeline } = await owner.api<{ secret: string }>(
    "POST",
    "/api/organisation/tokens",
    { name: "Release pipeline", scopes: ["files:read", "reviews:read"], expiresInDays: 365 },
  );
  await owner.api("POST", "/api/me/tokens", {
    name: "Logic Pro export",
    scopes: ["files:write"],
    expiresInDays: null,
  });
  await owner.api("POST", "/api/me/tokens", {
    name: "Old laptop",
    scopes: ["files:read", "files:write", "comments", "downloads"],
    expiresInDays: 30,
  });
  for (const [method, path] of [
    ["GET", "/api/projects"],
    ["GET", `/api/projects/${music.id}/files`],
    ["GET", `/api/projects/${music.id}/reviews`],
    ["POST", `/api/projects/${music.id}/folders`],
  ] as const) {
    const call = await owner.fetch(path, {
      method,
      headers: { authorization: `Bearer ${pipeline}`, ...(method === "POST" ? json : {}) },
      ...(method === "POST" ? { body: JSON.stringify({ name: "Refused" }) } : {}),
    });
    await check(call, `${method} ${path} with the pipeline's token`, method === "POST" ? 403 : 200);
  }

  // OAuth (#447): a chat integration the owner connected, a desktop tool nobody has yet, and a
  // delivery service whose consent screen waits for the owner's answer.
  type MadeClient = { client: { clientId: string }; secret: string | null };
  const slackCallback = "https://slack.endlesshall.example/oauth/callback";
  const slack = await owner.api<MadeClient>("POST", "/api/organisation/oauth-clients", {
    name: "Hekate for Slack",
    kind: "confidential",
    redirectUris: [slackCallback],
    scopes: ["reviews:read", "comments"],
  });
  await owner.api("POST", "/api/organisation/oauth-clients", {
    name: "Hekate for Logic Pro",
    kind: "public",
    redirectUris: ["hekate-logic://callback", "http://127.0.0.1/callback"],
    scopes: ["files:write", "comments"],
  });
  const deliveries = await owner.api<MadeClient>("POST", "/api/organisation/oauth-clients", {
    name: "Lantern Deliveries",
    kind: "confidential",
    redirectUris: ["https://deliveries.lantern.example/hekate/callback"],
    scopes: ["files:read", "downloads"],
  });
  const verifier = "endless-hall-seed-verifier-".padEnd(64, "0");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const asked = {
    response_type: "code",
    client_id: slack.client.clientId,
    redirect_uri: slackCallback,
    scope: "reviews:read comments",
    state: "seed",
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  const { redirect: back } = await owner.api<{ redirect: string }>("POST", "/api/oauth/authorize", {
    ...asked,
    approve: true,
  });
  const exchanged = await owner.fetch("/api/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: new URL(back).searchParams.get("code") ?? "",
      redirect_uri: slackCallback,
      code_verifier: verifier,
      client_id: slack.client.clientId,
      client_secret: slack.secret ?? "",
    }).toString(),
  });
  await check(exchanged, "POST /api/oauth/token", 200);
  const { access_token: slackToken } = (await exchanged.json()) as { access_token: string };
  const slackCall = await owner.fetch(`/api/projects/${music.id}/reviews`, {
    headers: { authorization: `Bearer ${slackToken}` },
  });
  await check(slackCall, "GET reviews with Slack's token", 200);
  const consentPath = `/oauth/authorize?${new URLSearchParams({
    ...asked,
    client_id: deliveries.client.clientId,
    redirect_uri: "https://deliveries.lantern.example/hekate/callback",
    scope: "files:read downloads",
    state: "lantern",
  }).toString()}`;

  // What failed (#159): a request, a job and a job of no workspace, each under its reference.
  if (sql) {
    const reports = [
      {
        reference: "HK-9D44-11",
        source: "api",
        location: "POST /api/comments",
        message: "Connection terminated unexpectedly",
        stack:
          "Error: Connection terminated unexpectedly\n    at Connection.<anonymous> (pg/lib/client.js:132:73)\n    at comments.ts:214:19",
        status: 500,
        request_id: "req_0199e3a1-7c2f-7b40-9a51-4f2d8c1e09aa",
        job_id: null,
        trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
        context: null,
        organisation_id: labelId,
        user_id: user.id,
      },
      {
        reference: "HK-2B91-E0",
        source: "worker",
        location: "notifications-mail",
        message: "421 4.7.0 Try again later, closing connection",
        stack:
          "Error: 421 4.7.0 Try again later, closing connection\n    at SMTPConnection._formatError (smtp-connection/index.js:798:19)",
        status: null,
        request_id: null,
        job_id: "0199e3a4-12c0-7d1e-b3f0-6a2e91c4d7f1",
        trace_id: null,
        context: null,
        organisation_id: null,
        user_id: null,
      },
      {
        reference: "HK-7F3A-2C",
        source: "worker",
        location: "document-render",
        message:
          "Could not render page 3 of Maple Leaf Rag - Score.pdf: damaged cross-reference table.",
        stack:
          "PdfError: xref entry 41 points outside the file\n    at parseXref (media/pages.ts:188:11)\n    at renderPage (media/pages.ts:262:9)\n    at runJob (jobs.ts:140:17)",
        status: null,
        request_id: null,
        job_id: "0199e3a6-8f1c-7a02-8e44-2b7d0c9f3a15",
        trace_id: "7d1e0c4a9b2f48e1a3c5f60b2e8d9a17",
        context: { organisationId: labelId, fileId: score },
        organisation_id: labelId,
        user_id: null,
      },
    ];
    for (const r of reports)
      await sql`insert into error_reports (id, reference, source, location, message, stack, status, request_id, job_id, trace_id, context, organisation_id, user_id)
        values (gen_random_uuid(), ${r.reference}, ${r.source}, ${r.location}, ${r.message}, ${r.stack}, ${r.status}, ${r.request_id}, ${r.job_id}, ${r.trace_id}, ${r.context ? JSON.stringify(r.context) : null}::text::jsonb, ${r.organisation_id}, ${r.user_id})`;
  }

  // Usage and quotas (#175): Endless Hall Records within its limits, with the month counted
  // so far; Saltmarsh Films at 92% of a quota an operator set by hand, which the overview
  // warns of.
  await owner.api("PUT", `/api/instance/workspaces/${labelId}/limits`, {
    storageQuota: 1e12,
    memberLimit: 25,
  });
  if (sql)
    await sql`insert into workspace_usage (id, organisation_id, month, storage_bytes, storage_peak, members, guests, projects, plays, downloads, measured_at)
      select gen_random_uuid(), ${labelId}, date_trunc('month', ${FIXED_TIME}::timestamptz)::date,
        coalesce(sum(byte_size), 0), coalesce(sum(byte_size), 0), 0, 0, 0, 184, 12, ${FIXED_TIME}::timestamptz
      from blobs where organisation_id = ${labelId}
      on conflict (organisation_id, month) do update set storage_bytes = excluded.storage_bytes,
        storage_peak = excluded.storage_peak, members = excluded.members, guests = excluded.guests,
        projects = excluded.projects, plays = excluded.plays, downloads = excluded.downloads,
        measured_at = excluded.measured_at`;
  if (sql) {
    const [stored] = await sql<
      { bytes: string }[]
    >`select coalesce(sum(byte_size), 0)::text as bytes from blobs where organisation_id = ${saltmarshId}`;
    await owner.api("PUT", `/api/instance/workspaces/${saltmarshId}/limits`, {
      storageQuota: Math.ceil(Number(stored?.bytes ?? 0) / 0.92),
      memberLimit: 10,
    });
  }

  // Billing (#179): Endless Hall Records on Studio, with the limits it already had and every
  // feature, its next invoice due, and two invoices made by hand, one of them paid.
  const plans = await owner.api<{ plans: { id: string; key: string }[] }>(
    "POST",
    "/api/instance/plans",
    {
      key: "studio",
      name: "Studio",
      price: { amount: 4900, currency: "GBP", interval: "month" },
      storageQuota: 1e12,
      memberLimit: 25,
      projectLimit: null,
      features: ["sso", "directory", "forensicMarking", "namedOperator"],
      severities: ["low", "normal", "high"],
    },
  );
  const studio = plans.plans.find((p) => p.key === "studio");
  await owner.api("PUT", `/api/instance/workspaces/${labelId}/plan`, {
    planId: studio?.id,
    status: "active",
    renewsAt: "2026-11-01T00:00:00Z",
  });
  for (const [description, settle] of [
    ["Studio, October 2026", true],
    ["Studio, November 2026", false],
  ] as const) {
    const made = await owner.api<{ invoice: { id: string } }>(
      "POST",
      `/api/instance/workspaces/${labelId}/invoices`,
      { amount: 4900, currency: "GBP", description },
    );
    if (settle)
      await owner.api(
        "POST",
        `/api/instance/workspaces/${labelId}/invoices/${made.invoice.id}/settle`,
        { outcome: "paid" },
      );
  }

  // The instance's Billing (#180): more plans, one by agreement; Saltmarsh Films on Label
  // with an invoice by hand overdue (put on it beneath the API, so it keeps the quota set by
  // hand above), Lantern Pictures on a Studio trial, and three promo codes, one ended.
  const priced = (key: string, name: string, amount: number, extra: object = {}) =>
    owner.api<{ plans: { id: string; key: string }[] }>("POST", "/api/instance/plans", {
      key,
      name,
      price: amount < 0 ? null : { amount, currency: "GBP", interval: "month" },
      storageQuota: null,
      memberLimit: null,
      projectLimit: null,
      features: [],
      severities: ["low", "normal"],
      ...extra,
    });
  await priced("solo", "Solo", 0, { storageQuota: 1e11, memberLimit: 3, projectLimit: 1 });
  await priced("label", "Label", 19_000, {
    storageQuota: 5e12,
    features: ["sso", "directory", "forensicMarking", "namedOperator", "ownStorage"],
    severities: ["low", "normal", "high", "urgent", "emergency"],
  });
  const all = await priced("custom", "Custom", -1, {
    features: ["sso", "directory", "forensicMarking", "namedOperator", "ownStorage"],
    severities: ["low", "normal", "high", "urgent", "emergency"],
    hidden: true,
  });
  const labelPlan = all.plans.find((p) => p.key === "label");
  if (sql)
    await sql`insert into workspace_plans (id, organisation_id, plan_id, status, renews_at)
      values (gen_random_uuid(), ${saltmarshId}, ${labelPlan?.id ?? null}, 'active', '2026-11-01T00:00:00Z')`;
  await owner.api("POST", `/api/instance/workspaces/${saltmarshId}/invoices`, {
    amount: 19_000,
    currency: "GBP",
    description: "Label, September 2026",
    dueAt: "2026-09-20T00:00:00Z",
  });
  // A credit held for the next invoice by hand to Endless Hall Records (#445).
  await owner.api("POST", `/api/instance/workspaces/${labelId}/credits`, {
    amount: 2500,
    currency: "GBP",
    reason: "Stems for Joplin Rags delivered late",
  });
  await owner.api("PUT", `/api/instance/workspaces/${lanternMade.id}/plan`, {
    planId: studio?.id,
    status: "trial",
    trialEndsAt: "2026-10-26T00:00:00Z",
  });
  // A year of Stripe's invoices, paid, for the Reports tab (#180): Endless Hall Records on
  // Studio since last November, Saltmarsh Films on Label since May.
  if (sql)
    for (let back = 11; back >= 1; back -= 1) {
      const start = new Date(Date.UTC(2026, 9 - back, 1));
      const end = new Date(Date.UTC(2026, 10 - back, 1));
      const rows: [string | undefined, number, string][] = [[labelId, 4900, "endless"]];
      if (back <= 5) rows.push([saltmarshId, 19_000, "saltmarsh"]);
      for (const [organisationId, amount, who] of rows)
        await sql`insert into invoices (id, organisation_id, source, gateway_id, number, status, currency, amount_due, amount_paid, period_start, period_end, issued_at, paid_at)
          values (gen_random_uuid(), ${organisationId ?? null}, 'stripe', ${`in_seed_${who}_${back}`}, ${`INV-${String(400 - back * 2 - (who === "saltmarsh" ? 1 : 0)).padStart(4, "0")}`}, 'paid', 'GBP', ${amount}, ${amount}, ${start}, ${end}, ${start}, ${start})`;
    }

  // Newest first, as the list shows them: LAUNCH50 at the top.
  for (const code of [
    { code: "BETA", percentOff: 100, months: 6, maxUses: 3, planIds: [studio?.id] },
    {
      code: "CHOIR2026",
      amountOff: 2000,
      currency: "GBP",
      months: 1,
      maxUses: 20,
      until: "2026-11-30T23:59:59Z",
    },
    {
      code: "LAUNCH50",
      percentOff: 50,
      months: 3,
      maxUses: 50,
      until: "2026-12-31T23:59:59Z",
      planIds: [studio?.id, labelPlan?.id],
    },
  ]) {
    const { promo } = await owner.api<{ promo: { id: string } }>(
      "POST",
      "/api/instance/promos",
      code,
    );
    if (code.code === "BETA") await owner.api("POST", `/api/instance/promos/${promo.id}/end`);
  }

  // Support (#181, #182): Endless Hall Records asks about a score that will not render, with
  // the error it saw, and the desk has answered; an idea of theirs is resolved; Saltmarsh
  // Films waits on the desk at High. The desk keeps two canned replies.
  type Sent = { ticket: { id: string } };
  const score7 = await owner.api<Sent>("POST", "/api/organisation/support/tickets", {
    subject: "Score page 7 will not render",
    kind: "problem",
    severity: "normal",
    message:
      "Maple Leaf Rag - Score.pdf shows pages 1 to 6 and then a blank. The file opens fine elsewhere.",
    errorReference: "HK-7F3A-2C",
  });
  await owner.api("POST", `/api/instance/support/tickets/${score7.ticket.id}/messages`, {
    body: "The PDF has a damaged cross-reference table at page 7, which the viewer refuses where other readers repair it. Re-exporting it from the engraver fixes it now; the next release repairs it too.",
  });
  const idea = await owner.api<Sent>("POST", "/api/organisation/support/tickets", {
    subject: "Can we have a second delivery profile?",
    kind: "idea",
    severity: "low",
    message: "Streaming and vinyl need different loudness targets; one profile is not enough.",
  });
  await owner.api("POST", `/api/organisation/support/tickets/${idea.ticket.id}/resolve`);
  if (sql) {
    const quota = uuidv7();
    await sql`insert into tickets (id, organisation_id, reference, subject, kind, severity, state,
        requester_id, requester_name)
      values (${quota}, ${saltmarshId}, 'T-62B3-41', 'Raise our quota before Friday''s delivery',
        'billing', 'high', 'waiting', ${tomas.id}, 'Tomas Varga')`;
    await sql`insert into ticket_messages (id, organisation_id, ticket_id, author, author_id,
        author_name, body)
      values (${uuidv7()}, ${saltmarshId}, ${quota}, 'member', ${tomas.id},
        'Tomas Varga', 'We are at 92% of our storage with the delivery due Friday. Can the quota go up this week? Happy to move to the next plan.')`;
  }
  for (const reply of [
    { title: "Fixed in the next patch", body: "This is fixed in the next release." },
    { title: "Quota raised", body: "Your storage quota is raised; it applies at once." },
  ])
    await owner.api("POST", "/api/instance/support/replies", reply);

  // The status page (#183): playback slow to start, identified and being worked on, and an
  // outage of uploads in September, posted and resolved. Their times are set against the
  // fixed clock below.
  type Posted = { id: string };
  const slow = await owner.api<Posted>("POST", "/api/instance/incidents", {
    title: "Playback is slow to start",
    impact: "degraded",
    services: ["storage"],
    body: "Some files take up to half a minute to start playing. Uploads and comments are not affected.",
  });
  await owner.api("POST", `/api/instance/incidents/${slow.id}/updates`, {
    state: "identified",
    body: "The storage provider is answering slowly in one region. Files play once started; we are moving reads to the other region.",
  });
  await owner.api("POST", "/api/instance/incidents", {
    title: "Uploads stop at 99%",
    impact: "partial",
    services: ["storage", "worker"],
    state: "resolved",
    body: "Every upload since 14:02 is in and measured. A full disk on the worker held them back; it has more room now.",
    startedAt: new Date(Date.now() - 41 * 86_400_000).toISOString(),
    resolvedAt: new Date(Date.now() - 41 * 86_400_000 + 30 * 60_000).toISOString(),
  });
  // 90 days measured, to the database's today: the September outage, and a slow day in July.
  if (sql)
    await sql`insert into service_days (id, day, service, minutes, down, last_minute)
      select gen_random_uuid(), d::date, s, 1440,
        case when s in ('storage', 'worker') and d::date = current_date - 41 then 30
             when s = 'api' and d::date = current_date - 58 then 18 else 0 end,
        d + interval '1439 minutes'
      from generate_series(current_date - 89, current_date - 1, interval '1 day') as d,
        unnest(array['api', 'database', 'storage', 'worker']) as s
      on conflict (day, service) do nothing`;

  if (sql) {
    // Where the workspace's events go (#161): a Slack channel, a Teams one and a webhook that
    // kept failing and paused, with a few deliveries for the webhook log. Their addresses are
    // never opened here: the events are dispatched already, and the webhook stays paused.
    const channel = async (
      kind: string,
      name: string,
      target: string,
      events: string[],
      extra: { failures?: number; pausedUntil?: string; delivered?: boolean } = {},
    ) => {
      const [row] = await sql<{ id: string }[]>`
        insert into channels (id, organisation_id, kind, name, target, config_sealed, key_version,
          events, failures, paused_until, last_delivered_at)
        values (gen_random_uuid(), ${labelId}, ${kind}, ${name}, ${target}, 'sealed', 1,
          ${events}, ${extra.failures ?? 0}, ${extra.pausedUntil ?? null},
          ${extra.delivered ? new Date(Date.parse(FIXED_TIME) - 2 * 60 * 60_000) : null})
        returning id`;
      return row?.id ?? "";
    };
    const slack = await channel(
      "slack",
      "#masters",
      "hooks.slack.com",
      ["decision.recorded", "version.arrived"],
      { delivered: true },
    );
    await channel("teams", "Mastering", "prod-01.westeurope.logic.azure.com", [
      "review.requested",
      "processing.failed",
    ]);
    const hook = await channel(
      "webhook",
      "Release desk",
      "https://hooks.endlesshall.example/hekate",
      [
        "review.requested",
        "decision.recorded",
        "feedback.submitted",
        "version.arrived",
        "stage.started",
        "comment.mentioned",
        "guest.signed_in",
        "file.downloaded",
        "processing.failed",
      ],
      { failures: 5, pausedUntil: "2099-01-01T18:00:00Z" },
    );
    const deliveries: [string, string, string, string | null, number][] = [
      [slack, "decision.recorded", "delivered", "200", 1],
      [hook, "decision.recorded", "pending", "503", 5],
      [slack, "version.arrived", "delivered", "200", 1],
      [hook, "version.arrived", "failed", "503", 6],
    ];
    for (const [channelId, kind, status, result, attempts] of deliveries) {
      const [event] = await sql<{ id: string }[]>`
        insert into events (id, organisation_id, kind, data, dispatched_at)
        values (${uuidv7()}, ${labelId}, ${kind},
          ${JSON.stringify({ project: null, actor: { name: "Mira Solberg", guest: false }, path: "/" })}::text::jsonb,
          now())
        returning id`;
      await sql`insert into event_deliveries (id, organisation_id, channel_id, event_id, status,
          attempts, last_result, next_attempt_at, delivered_at)
        values (${uuidv7()}, ${labelId}, ${channelId}, ${event?.id ?? null},
          ${status}, ${attempts}, ${result},
          ${status === "pending" ? "2099-01-01T18:00:00Z" : sql`now()`},
          ${status === "delivered" ? sql`now()` : null})`;
    }

    // A day of the machine measured, a minute a row (#156), before the database's own clock:
    // the page reads the minutes before now, whatever the browser's clock says.
    await sql`insert into health_samples (id, replica, at, requests, errors, p95_seconds,
        jobs_waiting, lanes, lanes_busy, upload_bytes, cpu, cores, memory_used, memory_total)
      select gen_random_uuid(), '0199e3a0-0000-7000-8000-000000000156',
        date_trunc('minute', now()) - n * interval '1 minute',
        (420 + 120 * sin(n / 90.0))::int, round(1 + sin(n / 80.0))::int,
        0.13 + 0.03 * sin(n / 60.0), greatest(0, round(3 + 3 * sin(n / 120.0)))::int, 4,
        greatest(0, least(4, round(2 + 1.5 * sin(n / 75.0))))::int,
        (18000000 + 15000000 * sin(n / 100.0))::bigint, 0.38, 8, 10500000000, 17179869184
      from generate_series(1, 1440) as n`;

    // The tokens' uses and ends, against the fixed clock: one used two hours ago, one
    // yesterday, and the old laptop's six weeks ago and run out since.
    const at = (hours: number) => new Date(Date.parse(FIXED_TIME) + hours * 60 * 60_000);
    await sql`update api_tokens set last_used_at = ${at(-2)}, expires_at = ${at(80 * 24)}
      where name = 'Release pipeline'`;
    await sql`update api_tokens set last_used_at = ${at(-26)} where name = 'Logic Pro export'`;
    await sql`update api_tokens set last_used_at = ${at(-41 * 24)}, expires_at = ${at(-13 * 24)}
      where name = 'Old laptop'`;
    // Slack's last call for the owner (#447), three hours ago.
    await sql`update api_tokens set last_used_at = ${at(-3)} where kind = 'oauth'`;

    const columns = await sql<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and data_type like 'timestamp%'
        and column_name in ('created_at', 'updated_at', 'decided_at', 'viewed_at', 'submitted_at', 'resolved_at', 'occurred_at', 'opened_at', 'completed_at', 'suspended_at')`;
    for (const { table_name: table, column_name: column } of columns) {
      // The decision log and the access log refuse changes (migrations 0006 and 0016); the
      // seed owns its tables, and lets its fixed clock through by pausing their triggers.
      const appendOnly = table === "review_decisions" || table === "access_events";
      if (appendOnly) await sql.unsafe(`alter table "${table}" disable trigger user`);
      // One minute apart, in the order they happened: an hour or so before the fixed time.
      await sql.unsafe(
        `with ordered as (
           select ctid, row_number() over (order by "${column}", ctid) as n
           from "${table}" where "${column}" is not null
         )
         update "${table}" t set "${column}" = $1::timestamptz - interval '2 hours' + ordered.n * interval '1 minute'
         from ordered where t.ctid = ordered.ctid`,
        [FIXED_TIME],
      );
      if (appendOnly) await sql.unsafe(`alter table "${table}" enable trigger user`);
    }
    // The desk's first reply, as long after its ticket as on a good day (#182).
    await sql`update tickets set first_reply_at = created_at + interval '108 minutes'
      where first_reply_at is not null`;
    // The incidents against the fixed clock (#183): the open one began 50 minutes before it and
    // was last updated 19 minutes before; the September one lasted half an hour, 41 days before.
    const clock = Date.parse(FIXED_TIME);
    const before = (minutes: number) => new Date(clock - minutes * 60_000);
    await sql`update incidents set started_at = ${before(50)}, updated_at = ${before(19)}
      where title = 'Playback is slow to start'`;
    await sql`update incident_updates set created_at = case when state = 'investigating'
        then ${before(50)}::timestamptz else ${before(19)}::timestamptz end
      where incident_id = (select id from incidents where title = 'Playback is slow to start')`;
    await sql`update incidents set started_at = ${before(41 * 1440)},
        resolved_at = ${before(41 * 1440 - 30)}, updated_at = ${before(41 * 1440 - 30)}
      where title = 'Uploads stop at 99%'`;
    await sql`update incident_updates set created_at = ${before(41 * 1440 - 30)}
      where incident_id = (select id from incidents where title = 'Uploads stop at 99%')`;
  }

  const seeded: Seeded = {
    musicProjectId: music.id,
    videoProjectId: video.id,
    trackId: track.id,
    sessionId: dayTwo.id,
    takeId: takes[2]?.id ?? "",
    dryFileId: dry,
    scoreFileId: score,
    cutFileId: cutFile.id,
    deliverableId: deliverable.id,
    cutTwoFileId: rendition("Cut 2"),
    reviewId: review.id,
    reviewStates: { decided, changes, approved, cancelled, waiting, overdue },
    shareId: shared,
    taskId: lateTask,
    invitationPath: new URL(invitation).pathname,
    signUpPath: new URL(signUpLink).pathname,
    uploadLinkPath: new URL(uploadLink).pathname,
    usedGuestPath,
    generalProjectId: general.id,
    bookletFileId: proof,
    printFileId: booklet("Print files"),
    signOffId: signOff.id,
    brandLogo,
    consentPath,
  };
  if (!options.media) rmSync(media, { recursive: true, force: true });
  return seeded;
}
