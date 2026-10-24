import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test as setup } from "@playwright/test";
import postgres from "postgres";
import { uuidv7 } from "../../../packages/db/src/id.ts";
import { textPdfOf } from "../../server/src/media/pdf.ts";
import { samplePdf } from "../../server/src/media/sample-pdf.ts";
import { SETUP_CODE } from "../constants.ts";
import { checkScreen } from "./checks.ts";
import { FIXED_TIME, type Seeded, saveScreen, state } from "./fixtures.ts";

/**
 * Seeds one organisation as a studio would have it: a music project with a track in two
 * versions (a dry and a wet mix in the second), its score, comments of every kind and a
 * review; a video project with a cut. Everything is made here, so every run sees the same.
 */

const media = join(state, "media");

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

async function api<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  const response = await page.request.fetch(path, {
    method,
    data: body === undefined ? undefined : body,
  });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
  // A 204 says it is done and carries nothing to read.
  if (response.status() === 204) return undefined as T;
  return (await response.json()) as T;
}

interface SeededFile {
  id: string;
  name: string;
  kind: string;
  streamStatus: string;
  analysisStatus: string;
}

async function upload(page: Page, projectId: string, paths: string[], folderId?: string) {
  await page.goto(`/projects/${projectId}/files${folderId ? `?folder=${folderId}` : ""}`);
  await page.setInputFiles("input[type=file]", paths);
  await expect(page.locator("ul[aria-label='Uploads in progress']")).toBeHidden({
    timeout: 120_000,
  });
}

/** Every file measured, drawn and analysed, as far as it will go. */
async function settled(page: Page, projectId: string): Promise<SeededFile[]> {
  const done = (s: string) => s === "ready" || s === "failed" || s === "none";
  for (let tries = 0; tries < 120; tries++) {
    const { files } = await api<{ files: SeededFile[] }>(
      page,
      "GET",
      `/api/projects/${projectId}/files`,
    );
    if (files.every((f) => done(f.streamStatus) && done(f.analysisStatus))) return files;
    await page.waitForTimeout(1000);
  }
  throw new Error("The media worker did not finish in time");
}

setup("seed", async ({ page, browser }) => {
  setup.setTimeout(300_000);
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

  // The first person sets up the organisation; the form is only there once, so it is
  // captured here, at both widths.
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto("/setup");
  await expect(page.getByLabel("Workspace")).toBeVisible();
  for (const [name, viewport] of [
    ["setup", { width: 1440, height: 900 }],
    ["setup-phone", { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(viewport);
    await checkScreen(page);
    await saveScreen(page, name);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel("Setup code").fill(SETUP_CODE);
  await page.getByLabel("Workspace").fill("Endless Hall Records");
  await page.getByLabel("Your name").fill("Alex Rivera");
  await page.getByLabel("Email").fill("producer@example.test");
  await page.getByLabel(/^Password/).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create and finish" }).click();
  await page.getByRole("button", { name: "Open Hekate" }).click();
  // A new workspace lands on an empty home that says what to do first.
  await expect(page.getByText("Nothing here yet")).toBeVisible();
  for (const [name, viewport] of [
    ["home-empty", { width: 1440, height: 900 }],
    ["home-empty-phone", { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(viewport);
    await checkScreen(page);
    await saveScreen(page, name);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const { user } = await api<{ user: { id: string } }>(page, "GET", "/api/me");

  const { project: music } = await api<{ project: { id: string } }>(page, "POST", "/api/projects", {
    name: "Joplin Rags",
    profile: "music",
    description: "Six rags for solo piano, recorded over two days in the hall.",
  });
  const { project: video } = await api<{ project: { id: string } }>(page, "POST", "/api/projects", {
    name: "Opening titles",
    profile: "video",
    description: "The title sequence and its cuts, for picture lock.",
  });

  await upload(page, music.id, [
    file("Maple Leaf Rag - Mix v1.wav"),
    file("Maple Leaf Rag - Dry v2.wav"),
    file("Maple Leaf Rag - Wet v2.wav"),
    file("Maple Leaf Rag - Dry v3.wav"),
    file("Maple Leaf Rag - Score.pdf"),
  ]);
  await upload(page, video.id, [
    file("Opening titles - Cut 3.mp4"),
    file("Title sequence - Cut 1 - 16x9.mp4"),
    file("Title sequence - Cut 1 - 9x16.mp4"),
    file("Title sequence - Cut 2 - 16x9.mp4"),
  ]);
  const musicFiles = await settled(page, music.id);
  const videoFiles = await settled(page, video.id);
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
    const added = await page.request.fetch(`/api/files/${cutFile.id}/captions?${query}`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(name),
      },
      data: Buffer.from(text),
    });
    expect(added.ok(), await added.text()).toBe(true);
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
  const { track: deliverable } = await api<{ track: { id: string } }>(
    page,
    "POST",
    `/api/projects/${video.id}/tracks`,
    { name: "Title sequence" },
  );
  const rendition = (part: string) => {
    const found = videoFiles.find((f) => f.name.includes(part));
    if (!found) throw new Error(`No rendition named like ${part}`);
    return found.id;
  };
  const { track: withCut } = await api<{
    track: { versions: { variations: { id: string }[] }[] };
  }>(page, "POST", `/api/tracks/${deliverable.id}/versions`, {
    notes: "Picture lock candidate.",
    variations: [
      { fileId: rendition("16x9"), name: "Main" },
      { fileId: rendition("9x16"), name: "Social" },
    ],
  });
  const main = withCut.versions[0]?.variations[0];
  if (main) {
    await api(page, "PATCH", `/api/variations/${main.id}`, { subtitled: false, graded: true });
  }
  // Its second cut, to compare with the first frame by frame (#147).
  await api(page, "POST", `/api/tracks/${deliverable.id}/versions`, {
    notes: "Titles moved up a second.",
    variations: [{ fileId: rendition("Cut 2"), name: "Main" }],
  });

  // A track in two versions, and one not yet started.
  const { track } = await api<{ track: { id: string } }>(
    page,
    "POST",
    `/api/projects/${music.id}/tracks`,
    { name: "Maple Leaf Rag", scoreFileId: score },
  );
  await api(page, "POST", `/api/tracks/${track.id}/versions`, {
    notes: "First edit from the Tuesday sessions.",
    variations: [{ fileId: named("Mix v1"), name: "Mix" }],
  });
  const { track: withTwo } = await api<{ track: { versions: { id: string }[] } }>(
    page,
    "POST",
    `/api/tracks/${track.id}/versions`,
    {
      notes: "Bars 12 to 16 replaced with take 7.",
      variations: [
        { fileId: dry, name: "Dry" },
        { fileId: named("Wet v2"), name: "Wet" },
      ],
    },
  );
  // Four takes of it from the sessions (#21), in a folder of their own: three with bars, rated
  // and noted, leaving bars 17 to 24 uncovered, and one without bars.
  const { folder: sessionFolder } = await api<{ folder: { id: string } }>(
    page,
    "POST",
    `/api/projects/${music.id}/folders`,
    { name: "Session takes" },
  );
  await upload(page, music.id, takeFiles, sessionFolder.id);
  const takeIds = (await settled(page, music.id))
    .filter((f) => /T\d\.wav$/.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => f.id);
  const { takes } = await api<{ takes: { id: string }[] }>(
    page,
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
    },
    {
      barFrom: 1,
      barTo: 16,
      page: 1,
      rating: 4,
      starred: true,
      notes: "Good opening, pedal noise at bar 5.",
    },
    {
      barFrom: 25,
      barTo: 48,
      page: 2,
      rating: 5,
      starred: true,
      label: "Insert",
      notes: "Keeper into the trio. Lovely rubato.",
    },
    { rating: 3, notes: "Safety through the coda." },
  ];
  for (const [i, change] of takeDetails.entries()) {
    const take = takes[i];
    if (take) await api(page, "PATCH", `/api/takes/${take.id}`, change);
  }
  // The day they were recorded (#21, #45): three of the takes, the fourth from another day.
  const { session: dayTwo } = await api<{ session: { id: string } }>(
    page,
    "POST",
    `/api/projects/${music.id}/sessions`,
    {
      name: "Day 2",
      recordedOn: "2026-10-13",
      venue: "Endless Hall, studio 2",
      trackIds: [track.id],
    },
  );
  await api(page, "POST", `/api/projects/${music.id}/sessions`, {
    name: "Day 3",
    recordedOn: "2026-10-14",
    venue: "Endless Hall, studio 2",
  });
  for (const take of takes.slice(0, 3))
    await api(page, "PATCH", `/api/takes/${take.id}`, { sessionId: dayTwo.id });
  // What the room kept beside the take log on the day (#51).
  await api(page, "PATCH", `/api/sessions/${dayTwo.id}`, {
    notes: "Piano a touch bright after lunch; room pair up 1 dB.",
    reference: "Trio from bar 25, repeat taken. Keep T2's opening.",
  });
  const tuner = await api<{ todo: { id: string } }>(
    page,
    "POST",
    `/api/sessions/${dayTwo.id}/todos`,
    { text: "Tell the tuner about the A" },
  );
  await api(page, "PATCH", `/api/sessions/${dayTwo.id}/todos/${tuner.todo.id}`, { done: true });
  await api(page, "POST", `/api/sessions/${dayTwo.id}/todos`, {
    text: "Pick-ups for bars 17 to 19",
  });
  // The producer's marks on its score (#52): an edit plot through takes 2, 3 and 4, an issue
  // fixed by take 3, a wrong note, a dynamic and a note.
  const marking = await api<{ categories: { id: string; name: string }[] }>(
    page,
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
    await api(page, "POST", `/api/tracks/${track.id}/score-marks`, mark);
  // The patch list (#54): one stage box, as the prototype has it.
  const patched: Record<string, string> = {};
  const { box } = await api<{ box: { id: string } }>(
    page,
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
    const { row: made } = await api<{ row: { id: string } }>(
      page,
      "POST",
      `/api/stage-boxes/${box.id}/rows`,
      row,
    );
    patched[row.source] = made.id;
  }
  // The stage plan (#53), as the prototype draws it: its microphones on the patch above.
  const { plan } = await api<{ plan: { id: string } }>(
    page,
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
  await api(page, "POST", `/api/stage-plans/${plan.id}/edits`, {
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
  const { folder: venueFolder } = await api<{ folder: { id: string } }>(
    page,
    "POST",
    `/api/projects/${music.id}/folders`,
    { name: "Venue" },
  );
  await upload(page, music.id, [file("Endless Hall - Floor plan.pdf")], venueFolder.id);
  const floorPlan = (await settled(page, music.id)).find(
    (f) => f.name === "Endless Hall - Floor plan.pdf",
  );
  await api(page, "PATCH", `/api/stage-plans/${plan.id}`, {
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
  await upload(page, music.id, [edlPath], sessionFolder.id);
  const edlFile = (await settled(page, music.id)).find((f) => f.name.endsWith("V2.edl"));
  const v2 = withTwo.versions.at(-1);
  if (!edlFile || !v2) throw new Error("The edit decision list did not upload");
  await api(page, "PUT", `/api/versions/${v2.id}/edl`, { fileId: edlFile.id });
  // From here on a version needs an edit decision list (#131): the next one is refused.
  await api(page, "PATCH", `/api/projects/${music.id}`, { requireEdl: true });
  // Its set-up, saved for the next recording to start from (#240).
  await api(page, "POST", `/api/projects/${music.id}/template`, { name: "Solo recital" });
  const { track: entertainer } = await api<{ track: { id: string } }>(
    page,
    "POST",
    `/api/projects/${music.id}/tracks`,
    { name: "The Entertainer" },
  );

  // Workspace tags on two files, and the owner's own pin and favourite.
  type Made = { tag: { id: string } };
  const { tag: masters } = await api<Made>(page, "POST", "/api/tags", { name: "Masters" });
  const { tag: print } = await api<Made>(page, "POST", "/api/tags", { name: "For print" });
  await api<Made>(page, "POST", "/api/tags", { name: "Reference" });
  await api(page, "PUT", `/api/files/${dry}/tags`, { tagIds: [masters.id] });
  await api(page, "PUT", `/api/files/${score}/tags`, { tagIds: [print.id, masters.id] });
  for (const body of [
    { items: [{ kind: "track", id: entertainer.id }], pinned: true },
    { items: [{ kind: "file", id: score }], favourite: true },
  ]) {
    const marked = await page.request.post(`/api/projects/${music.id}/marks`, { data: body });
    expect(marked.status()).toBe(204);
  }

  // Comments of every kind.
  type Created = { comment: { id: string } };
  const comment = (fileId: string, body: string, anchor?: unknown, parentId?: string) =>
    api<Created>(page, "POST", `/api/files/${fileId}/comments`, { body, anchor, parentId });
  // About the left channel alone (#74).
  const pedal = await api<Created>(page, "POST", `/api/files/${dry}/comments`, {
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
  await api(page, "POST", `/api/comments/${lift.comment.id}/resolve`, { resolved: true });
  const rushes = await comment(dry, "The left hand rushes through these bars.", {
    kind: "bar",
    from: { bar: 9 },
    to: { bar: 12 },
    at: 14.2,
  });
  // The opening takes, shared on that thread for whoever reviews it to hear (#133).
  await api(page, "POST", `/api/comments/${rushes.comment.id}/takes`, {
    takeIds: takes.slice(0, 1).map((t) => t.id),
  });
  // A mention from the picker (#133): Alex notes it for himself.
  await api(page, "POST", `/api/files/${dry}/comments`, {
    body: "Overall balance is great; @Alex Rivera, the reverb tail could be a touch shorter.",
    mentions: [user.id],
  });
  // A photo of the bass part, attached to the thread about it (#133).
  const attached = await page.request.post(
    `/api/files/${dry}/comments/${drop.comment.id}/attachments`,
    {
      headers: {
        "content-type": "image/png",
        "x-file-name": encodeURIComponent("Bass part, bar 11.png"),
      },
      data: Buffer.from("a picture of the bass part, marked"),
    },
  );
  expect(attached.status()).toBe(201);
  // Triage (#36): the pedal noise waits for noise reduction; the rushing is someone's to fix.
  const { categories } = await api<{ categories: { id: string; name: string }[] }>(
    page,
    "GET",
    `/api/projects/${music.id}/categories`,
  );
  const categoryId = (name: string) => categories.find((c) => c.name === name)?.id;
  await api(page, "POST", `/api/files/${dry}/comments/triage`, {
    commentIds: [pedal.comment.id],
    categoryId: categoryId("Noise"),
  });
  await api(page, "POST", `/api/files/${dry}/comments/triage`, {
    commentIds: [rushes.comment.id],
    categoryId: categoryId("Performance"),
    assigneeId: user.id,
  });
  // And it is a task (#133).
  await api(page, "POST", `/api/comments/${rushes.comment.id}/todo`, { todo: true });
  // The project's tasks (#140): by hand, one late, one waiting for approval, one done.
  const task = (body: Record<string, unknown>) =>
    api<{ task: { id: string } }>(page, "POST", `/api/projects/${music.id}/tasks`, body).then(
      (r) => r.task.id,
    );
  const moveTask = (id: string, status: string) =>
    api(page, "PATCH", `/api/tasks/${id}`, { status });
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
  const { review } = await api<{ review: { id: string } }>(
    page,
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
  await api(page, "POST", `/api/projects/${music.id}/groups`, {
    name: "Soloists",
    members: [
      { name: "Mira Solberg", email: "mira@example.test", label: "Violin" },
      { name: "Ines Arlow", email: "ines@example.test", label: "Piano" },
    ],
  });

  // The repertoire and venues (#48): the rags as one work, numbered as the score prints them.
  await api(page, "POST", `/api/projects/${music.id}/works`, {
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
        await api<{ venue: { id: string } }>(
          page,
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
    const made = await api<{ day: { id: string } }>(
      page,
      "POST",
      `/api/projects/${music.id}/schedule-days`,
      day,
    );
    for (const { done, ...row } of rows as readonly ({ done?: boolean } & Record<
      string,
      unknown
    >)[]) {
      const added = await api<{ row: { id: string } }>(
        page,
        "POST",
        `/api/schedule-days/${made.day.id}/rows`,
        row,
      );
      if (done) await api(page, "PATCH", `/api/schedule-rows/${added.row.id}/done`, { done: true });
    }
  }

  // Personnel (#49), as the prototype lists it: linked to the project's members and guests.
  const { people } = await api<{ people: { kind: string; id: string; name: string }[] }>(
    page,
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
    await api(page, "POST", `/api/projects/${music.id}/personnel`, entry);
  // The pianist on the stage plan is Ines Arlow on the personnel, and named by it.
  const { personnel: listed } = await api<{ personnel: { id: string; name: string }[] }>(
    page,
    "GET",
    `/api/projects/${music.id}/personnel`,
  );
  await api(page, "POST", `/api/stage-plans/${plan.id}/edits`, {
    change: [{ id: itemId(4), personnelId: listed.find((p) => p.name === "Ines Arlow")?.id }],
  });

  // Alex hears when a guest opens a review they asked for.
  await api(page, "PUT", "/api/notifications/preferences", {
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
    ].join(","),
    ...["-frames:v", "1", "-c:v", "png", "-f", "image2", "-update", "1", logoPath],
  ]);
  const branded = await page.request.post("/api/organisation/branding/logo", {
    headers: { "content-type": "image/png" },
    data: readFileSync(logoPath),
  });
  expect(branded.ok(), await branded.text()).toBe(true);
  const { branding } = await api<{
    branding: { logo: { blobId: string; width: number; height: number } };
  }>(page, "PUT", "/api/organisation/branding/accent", { accent: "#4fb3a9" });
  const { activeOrganisationId: label } = await api<{ activeOrganisationId: string }>(
    page,
    "GET",
    "/api/me",
  );
  const brandLogo = {
    url: `/api/branding/${label}/logo/${branding.logo.blobId}`,
    width: branding.logo.width,
    height: branding.logo.height,
  };

  // An invitation waiting to be accepted.
  const { link: invitation } = await api<{ link: string }>(
    page,
    "POST",
    "/api/organisation/invitations",
    {
      email: "tomas@example.test",
      role: "member",
    },
  );

  // An upload request (#139) for someone outside to send the string stems, nothing arrived yet.
  const { link: uploadLink } = await api<{ link: string }>(
    page,
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
  await api(page, "POST", `/api/projects/${music.id}/upload-requests`, {
    name: "Next mix",
    wanted: "The next mix of Maple Leaf Rag, with the piano brought forward.",
    folderId: null,
    trackId: track.id,
    fileLimit: 1,
    expiresOn: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
  });

  // The guest signs in from the link they were sent, which the log holds without a mail server.
  let guestLink: string | undefined;
  for (let tries = 0; tries < 30 && !guestLink; tries++) {
    guestLink = readFileSync(join(state, "server.log"), "utf8")
      .match(/\/guest\/[A-Za-z0-9_-]{16,}/g)
      ?.at(-1);
    if (!guestLink) await page.waitForTimeout(500);
  }
  if (!guestLink) throw new Error("No guest link in the server log");
  const guest = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const guestPage = await guest.newPage();
  await guestPage.goto(guestLink);
  await guestPage.waitForURL(/\/g\/reviews\//);
  // The guest has looked, and answers Alex by name: two notifications for the bell.
  await api(guestPage, "POST", `/api/reviews/${review.id}/viewed`, {});
  await api(guestPage, "POST", `/api/files/${dry}/comments`, {
    body: "@Alex Rivera the pedal noise is gone in the wet mix.",
  });
  await guest.storageState({ path: join(state, "guest.json") });
  await guest.close();

  // A review in each state its page shows (#129), made after the guest's link was read.
  const ask = async (title: string, body: Record<string, unknown>) =>
    (
      await api<{ review: { id: string } }>(page, "POST", `/api/projects/${music.id}/reviews`, {
        kind: "approval",
        title,
        order: "parallel",
        items: [{ trackId: track.id }],
        reviewers: [user.id],
        ...body,
      })
    ).review.id;
  const decide = (id: string, decision: string, note?: string) =>
    api(page, "POST", `/api/reviews/${id}/decisions`, { decision, ...(note ? { note } : {}) });
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
  await api(page, "POST", `/api/reviews/${cancelled}/cancel`, {
    reason: "Superseded by the album masters.",
  });
  const waiting = await ask("Producer's listen", {
    order: "sequence",
    reviewers: [{ name: "Tomas Varga", email: "tomas.varga@example.test" }, user.id],
    dueAt: "2026-10-24T17:00:00Z",
  });
  // Alex has looked at what is asked of them, as anyone opening the inbox would have.
  await api(page, "POST", `/api/reviews/${review.id}/viewed`, {});
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
  const { project: general } = await api<{ project: { id: string } }>(
    page,
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
  await upload(page, general.id, [file("Booklet - proof 1.pdf"), file("Cover.png")]);
  await upload(page, general.id, [file("Booklet - proof 2.pdf"), file("Print files.zip")]);
  const generalFiles = await settled(page, general.id);
  const booklet = (part: string) => {
    const found = generalFiles.find((f) => f.name.includes(part));
    if (!found) throw new Error(`No file named like ${part}`);
    return found.id;
  };
  const proof = booklet("proof 2");
  await api(page, "POST", `/api/files/${booklet("proof 1")}/next`, { fileId: proof });
  await comment(booklet("proof 1"), "The track list runs onto the fold.");
  const { review: signOff } = await api<{ review: { id: string } }>(
    page,
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
  const invited: Record<string, string> = {};
  for (const [name, slug] of [
    ["North Choir Collective", "north-choir"],
    ["Saltmarsh Films", "saltmarsh"],
  ] as const)
    invited[slug] = (
      await api<{ link: string }>(page, "POST", "/api/instance/workspaces", {
        name,
        slug,
        ownerEmail: `owner@${slug}.example`,
      })
    ).link;
  // Saltmarsh Films' owner keeps a score there, for its quota (#175) to be measured against.
  const saltmarshOwner = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const saltmarshPage = await saltmarshOwner.newPage();
  await api(
    saltmarshPage,
    "POST",
    `/api/invitations/${invited.saltmarsh?.split("/invite/")[1]}/accept`,
    { name: "Tomas Varga", password: "correct horse battery" },
  );
  const titles = await api<{ project: { id: string } }>(saltmarshPage, "POST", "/api/projects", {
    name: "Opening titles",
    profile: "video",
  });
  await upload(saltmarshPage, titles.project.id, [file("Maple Leaf Rag - Score.pdf")]);
  await settled(saltmarshPage, titles.project.id);
  await saltmarshOwner.close();
  const lantern = await api<{ id: string; link: string }>(
    page,
    "POST",
    "/api/instance/workspaces",
    { name: "Lantern Pictures", slug: "lantern", ownerEmail: "mira@lantern.example" },
  );
  const lanternOwner = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const lanternPage = await lanternOwner.newPage();
  await api(lanternPage, "POST", `/api/invitations/${lantern.link.split("/invite/")[1]}/accept`, {
    name: "Mira Solberg",
    password: "correct horse battery",
  });
  await api(page, "POST", `/api/instance/workspaces/${lantern.id}/suspend`, {
    reason: "The invoice for October is unpaid.",
  });
  await lanternPage.clock.setFixedTime(FIXED_TIME);
  await lanternPage.goto("/");
  await lanternPage.waitForURL(/\/suspended$/);
  await expect(lanternPage.getByText("Lantern Pictures is suspended")).toBeVisible();
  for (const [name, viewport] of [
    ["suspended", { width: 1440, height: 900 }],
    ["suspended-phone", { width: 390, height: 844 }],
  ] as const) {
    await lanternPage.setViewportSize(viewport);
    await checkScreen(lanternPage);
    await saveScreen(lanternPage, name);
  }
  await lanternOwner.close();

  // Registration (#184): invite-only, with one invitation to make a workspace waiting.
  const { settings: instanceSettings } = await api<{ settings: Record<string, unknown> }>(
    page,
    "GET",
    "/api/instance/settings",
  );
  await api(page, "PUT", "/api/instance/settings", {
    ...instanceSettings,
    registration: { mode: "invite" },
  });
  const { link: signUpLink } = await api<{ link: string }>(
    page,
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
  const { workflow: albumReview } = await api<{ workflow: { id: string } }>(
    page,
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
  await api(page, "PATCH", `/api/workflows/${albumReview.id}`, { active: true });
  await api(page, "POST", `/api/projects/${music.id}/workflows`, {
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

  // API tokens (#198): two of the owner's own (one since run out) and a service token for the
  // release pipeline, whose calls, one of them refused for want of a scope, fill the API log.
  const { secret: pipeline } = await api<{ secret: string }>(
    page,
    "POST",
    "/api/organisation/tokens",
    { name: "Release pipeline", scopes: ["files:read", "reviews:read"], expiresInDays: 365 },
  );
  await api(page, "POST", "/api/me/tokens", {
    name: "Logic Pro export",
    scopes: ["files:write"],
    expiresInDays: null,
  });
  await api(page, "POST", "/api/me/tokens", {
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
    const call = await page.request.fetch(path, {
      method,
      headers: { authorization: `Bearer ${pipeline}` },
      ...(method === "POST" ? { data: { name: "Refused" } } : {}),
    });
    expect(call.status(), `${method} ${path}`).toBe(method === "POST" ? 403 : 200);
  }

  // OAuth (#447): a chat integration the owner connected, a desktop tool nobody has yet, and a
  // delivery service whose consent screen waits for the owner's answer.
  type MadeClient = { client: { clientId: string }; secret: string | null };
  const slackCallback = "https://slack.endlesshall.example/oauth/callback";
  const slack = await api<MadeClient>(page, "POST", "/api/organisation/oauth-clients", {
    name: "Hekate for Slack",
    kind: "confidential",
    redirectUris: [slackCallback],
    scopes: ["reviews:read", "comments"],
  });
  await api(page, "POST", "/api/organisation/oauth-clients", {
    name: "Hekate for Logic Pro",
    kind: "public",
    redirectUris: ["hekate-logic://callback", "http://127.0.0.1/callback"],
    scopes: ["files:write", "comments"],
  });
  const deliveries = await api<MadeClient>(page, "POST", "/api/organisation/oauth-clients", {
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
  const { redirect: back } = await api<{ redirect: string }>(page, "POST", "/api/oauth/authorize", {
    ...asked,
    approve: true,
  });
  const exchanged = await page.request.fetch("/api/oauth/token", {
    method: "POST",
    form: {
      grant_type: "authorization_code",
      code: new URL(back).searchParams.get("code") ?? "",
      redirect_uri: slackCallback,
      code_verifier: verifier,
      client_id: slack.client.clientId,
      client_secret: slack.secret ?? "",
    },
  });
  expect(exchanged.status(), await exchanged.text()).toBe(200);
  const { access_token: slackToken } = (await exchanged.json()) as { access_token: string };
  const slackCall = await page.request.fetch(`/api/projects/${music.id}/reviews`, {
    headers: { authorization: `Bearer ${slackToken}` },
  });
  expect(slackCall.status()).toBe(200);
  const consentPath = `/oauth/authorize?${new URLSearchParams({
    ...asked,
    client_id: deliveries.client.clientId,
    redirect_uri: "https://deliveries.lantern.example/hekate/callback",
    scope: "files:read downloads",
    state: "lantern",
  }).toString()}`;

  // The same moment for every run, so dates and "ago" read the same in every capture.
  const sql = postgres(process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "", {
    onnotice: () => undefined,
  });
  try {
    // What failed (#159): a request, a job and a job of no workspace, each under its reference.
    const [label] = await sql<
      { id: string }[]
    >`select id from organisations where name = 'Endless Hall Records'`;
    const [alex] = await sql<{ id: string }[]>`select id from users where name = 'Alex Rivera'`;
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
        organisation_id: label?.id ?? null,
        user_id: alex?.id ?? null,
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
        context: { organisationId: label?.id, fileId: score },
        organisation_id: label?.id ?? null,
        user_id: null,
      },
    ];
    for (const r of reports)
      await sql`insert into error_reports (id, reference, source, location, message, stack, status, request_id, job_id, trace_id, context, organisation_id, user_id)
        values (gen_random_uuid(), ${r.reference}, ${r.source}, ${r.location}, ${r.message}, ${r.stack}, ${r.status}, ${r.request_id}, ${r.job_id}, ${r.trace_id}, ${r.context ? sql.json(r.context) : null}, ${r.organisation_id}, ${r.user_id})`;

    // Usage and quotas (#175): Endless Hall Records within its limits, with the month counted
    // so far; Saltmarsh Films at 92% of a quota an operator set by hand, which the overview
    // warns of.
    await api(page, "PUT", `/api/instance/workspaces/${label?.id}/limits`, {
      storageQuota: 1e12,
      memberLimit: 25,
    });
    await sql`insert into workspace_usage (id, organisation_id, month, storage_bytes, storage_peak, members, guests, projects, plays, downloads, measured_at)
      select gen_random_uuid(), ${label?.id ?? null}, date_trunc('month', ${FIXED_TIME}::timestamptz)::date,
        coalesce(sum(byte_size), 0), coalesce(sum(byte_size), 0), 0, 0, 0, 184, 12, ${FIXED_TIME}::timestamptz
      from blobs where organisation_id = ${label?.id ?? null}
      on conflict (organisation_id, month) do update set storage_bytes = excluded.storage_bytes,
        storage_peak = excluded.storage_peak, members = excluded.members, guests = excluded.guests,
        projects = excluded.projects, plays = excluded.plays, downloads = excluded.downloads,
        measured_at = excluded.measured_at`;
    const [saltmarsh] = await sql<
      { id: string }[]
    >`select id from organisations where name = 'Saltmarsh Films'`;
    const [stored] = await sql<
      { bytes: string }[]
    >`select coalesce(sum(byte_size), 0)::text as bytes from blobs where organisation_id = ${saltmarsh?.id ?? null}`;
    await api(page, "PUT", `/api/instance/workspaces/${saltmarsh?.id}/limits`, {
      storageQuota: Math.ceil(Number(stored?.bytes ?? 0) / 0.92),
      memberLimit: 10,
    });

    // Billing (#179): Endless Hall Records on Studio, with the limits it already had and every
    // feature, its next invoice due, and two invoices made by hand, one of them paid.
    const plans = await api<{ plans: { id: string; key: string }[] }>(
      page,
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
    await api(page, "PUT", `/api/instance/workspaces/${label?.id}/plan`, {
      planId: studio?.id,
      status: "active",
      renewsAt: "2026-11-01T00:00:00Z",
    });
    for (const [description, settle] of [
      ["Studio, October 2026", true],
      ["Studio, November 2026", false],
    ] as const) {
      const made = await api<{ invoice: { id: string } }>(
        page,
        "POST",
        `/api/instance/workspaces/${label?.id}/invoices`,
        { amount: 4900, currency: "GBP", description },
      );
      if (settle)
        await api(
          page,
          "POST",
          `/api/instance/workspaces/${label?.id}/invoices/${made.invoice.id}/settle`,
          { outcome: "paid" },
        );
    }

    // The instance's Billing (#180): more plans, one by agreement; Saltmarsh Films on Label
    // with an invoice by hand overdue (put on it beneath the API, so it keeps the quota set by
    // hand above), Lantern Pictures on a Studio trial, and three promo codes, one ended.
    const priced = (key: string, name: string, amount: number, extra: object = {}) =>
      api<{ plans: { id: string; key: string }[] }>(page, "POST", "/api/instance/plans", {
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
      features: ["sso", "directory", "forensicMarking", "namedOperator"],
      severities: ["low", "normal", "high", "urgent", "emergency"],
    });
    const all = await priced("custom", "Custom", -1, {
      features: ["sso", "directory", "forensicMarking", "namedOperator"],
      severities: ["low", "normal", "high", "urgent", "emergency"],
      hidden: true,
    });
    const labelPlan = all.plans.find((p) => p.key === "label");
    await sql`insert into workspace_plans (id, organisation_id, plan_id, status, renews_at)
      values (gen_random_uuid(), ${saltmarsh?.id ?? null}, ${labelPlan?.id ?? null}, 'active', '2026-11-01T00:00:00Z')`;
    await api(page, "POST", `/api/instance/workspaces/${saltmarsh?.id}/invoices`, {
      amount: 19_000,
      currency: "GBP",
      description: "Label, September 2026",
      dueAt: "2026-09-20T00:00:00Z",
    });
    // A credit held for the next invoice by hand to Endless Hall Records (#445).
    await api(page, "POST", `/api/instance/workspaces/${label?.id}/credits`, {
      amount: 2500,
      currency: "GBP",
      reason: "Stems for Joplin Rags delivered late",
    });
    const [lanternRow] = await sql<
      { id: string }[]
    >`select id from organisations where name = 'Lantern Pictures'`;
    await api(page, "PUT", `/api/instance/workspaces/${lanternRow?.id}/plan`, {
      planId: studio?.id,
      status: "trial",
      trialEndsAt: "2026-10-26T00:00:00Z",
    });
    // A year of Stripe's invoices, paid, for the Reports tab (#180): Endless Hall Records on
    // Studio since last November, Saltmarsh Films on Label since May.
    for (let back = 11; back >= 1; back -= 1) {
      const start = new Date(Date.UTC(2026, 9 - back, 1));
      const end = new Date(Date.UTC(2026, 10 - back, 1));
      const rows: [string | undefined, number, string][] = [[label?.id, 4900, "endless"]];
      if (back <= 5) rows.push([saltmarsh?.id, 19_000, "saltmarsh"]);
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
      const { promo } = await api<{ promo: { id: string } }>(
        page,
        "POST",
        "/api/instance/promos",
        code,
      );
      if (code.code === "BETA") await api(page, "POST", `/api/instance/promos/${promo.id}/end`);
    }

    // Support (#181, #182): Endless Hall Records asks about a score that will not render, with
    // the error it saw, and the desk has answered; an idea of theirs is resolved; Saltmarsh
    // Films waits on the desk at High. The desk keeps two canned replies.
    type Sent = { ticket: { id: string } };
    const score7 = await api<Sent>(page, "POST", "/api/organisation/support/tickets", {
      subject: "Score page 7 will not render",
      kind: "problem",
      severity: "normal",
      message:
        "Maple Leaf Rag - Score.pdf shows pages 1 to 6 and then a blank. The file opens fine elsewhere.",
      errorReference: "HK-7F3A-2C",
    });
    await api(page, "POST", `/api/instance/support/tickets/${score7.ticket.id}/messages`, {
      body: "The PDF has a damaged cross-reference table at page 7, which the viewer refuses where other readers repair it. Re-exporting it from the engraver fixes it now; the next release repairs it too.",
    });
    const idea = await api<Sent>(page, "POST", "/api/organisation/support/tickets", {
      subject: "Can we have a second delivery profile?",
      kind: "idea",
      severity: "low",
      message: "Streaming and vinyl need different loudness targets; one profile is not enough.",
    });
    await api(page, "POST", `/api/organisation/support/tickets/${idea.ticket.id}/resolve`);
    const [tomas] = await sql<{ id: string }[]>`select id from users where name = 'Tomas Varga'`;
    const quota = uuidv7();
    await sql`insert into tickets (id, organisation_id, reference, subject, kind, severity, state,
        requester_id, requester_name)
      values (${quota}, ${saltmarsh?.id ?? null}, 'T-62B3-41', 'Raise our quota before Friday''s delivery',
        'billing', 'high', 'waiting', ${tomas?.id ?? null}, 'Tomas Varga')`;
    await sql`insert into ticket_messages (id, organisation_id, ticket_id, author, author_id,
        author_name, body)
      values (${uuidv7()}, ${saltmarsh?.id ?? null}, ${quota}, 'member', ${tomas?.id ?? null},
        'Tomas Varga', 'We are at 92% of our storage with the delivery due Friday. Can the quota go up this week? Happy to move to the next plan.')`;
    for (const reply of [
      { title: "Fixed in the next patch", body: "This is fixed in the next release." },
      { title: "Quota raised", body: "Your storage quota is raised; it applies at once." },
    ])
      await api(page, "POST", "/api/instance/support/replies", reply);

    // The status page (#183): playback slow to start, identified and being worked on, and an
    // outage of uploads in September, posted and resolved. Their times are set against the
    // fixed clock below.
    type Posted = { id: string };
    const slow = await api<Posted>(page, "POST", "/api/instance/incidents", {
      title: "Playback is slow to start",
      impact: "degraded",
      services: ["storage"],
      body: "Some files take up to half a minute to start playing. Uploads and comments are not affected.",
    });
    await api(page, "POST", `/api/instance/incidents/${slow.id}/updates`, {
      state: "identified",
      body: "The storage provider is answering slowly in one region. Files play once started; we are moving reads to the other region.",
    });
    await api(page, "POST", "/api/instance/incidents", {
      title: "Uploads stop at 99%",
      impact: "partial",
      services: ["storage", "worker"],
      state: "resolved",
      body: "Every upload since 14:02 is in and measured. A full disk on the worker held them back; it has more room now.",
      startedAt: new Date(Date.now() - 41 * 86_400_000).toISOString(),
      resolvedAt: new Date(Date.now() - 41 * 86_400_000 + 30 * 60_000).toISOString(),
    });
    // 90 days measured, to the database's today: the September outage, and a slow day in July.
    await sql`insert into service_days (id, day, service, minutes, down, last_minute)
      select gen_random_uuid(), d::date, s, 1440,
        case when s in ('storage', 'worker') and d::date = current_date - 41 then 30
             when s = 'api' and d::date = current_date - 58 then 18 else 0 end,
        d + interval '1439 minutes'
      from generate_series(current_date - 89, current_date - 1, interval '1 day') as d,
        unnest(array['api', 'database', 'storage', 'worker']) as s
      on conflict (day, service) do nothing`;

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
        values (gen_random_uuid(), ${label?.id ?? null}, ${kind}, ${name}, ${target}, 'sealed', 1,
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
        values (${uuidv7()}, ${label?.id ?? null}, ${kind},
          ${sql.json({ project: null, actor: { name: "Mira Solberg", guest: false }, path: "/" })},
          now())
        returning id`;
      await sql`insert into event_deliveries (id, organisation_id, channel_id, event_id, status,
          attempts, last_result, next_attempt_at, delivered_at)
        values (${uuidv7()}, ${label?.id ?? null}, ${channelId}, ${event?.id ?? null},
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
  } finally {
    await sql.end();
  }

  const seeded: Seeded = {
    musicProjectId: music.id,
    videoProjectId: video.id,
    trackId: track.id,
    sessionId: dayTwo.id,
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
    usedGuestPath: guestLink,
    generalProjectId: general.id,
    bookletFileId: proof,
    printFileId: booklet("Print files"),
    signOffId: signOff.id,
    brandLogo,
    consentPath,
  };
  writeFileSync(join(state, "seeded.json"), JSON.stringify(seeded, null, 2));
  await page.context().storageState({ path: join(state, "owner.json") });
});
