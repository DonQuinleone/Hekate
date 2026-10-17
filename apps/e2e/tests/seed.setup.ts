import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test as setup } from "@playwright/test";
import postgres from "postgres";
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
    "-c:a",
    "pcm_s16le",
    path,
  ]);
}

function cut(path: string) {
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1280x720:rate=25:duration=12",
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
  return (await response.json()) as T;
}

interface SeededFile {
  id: string;
  name: string;
  kind: string;
  streamStatus: string;
  analysisStatus: string;
}

async function upload(page: Page, projectId: string, paths: string[]) {
  await page.goto(`/projects/${projectId}/files`);
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
  writeFileSync(file("Maple Leaf Rag - Score.pdf"), samplePdf(3));
  cut(file("Opening titles - Cut 3.mp4"));

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
  await upload(page, video.id, [file("Opening titles - Cut 3.mp4")]);
  const musicFiles = await settled(page, music.id);
  const [cutFile] = await settled(page, video.id);
  const named = (part: string) => {
    const found = musicFiles.find((f) => f.name.includes(part));
    if (!found) throw new Error(`No file named like ${part}`);
    return found.id;
  };
  const score = named("Score");
  const dry = named("Dry v2");
  if (!cutFile) throw new Error("The cut did not upload");

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
  await api(page, "POST", `/api/tracks/${track.id}/versions`, {
    notes: "Bars 12 to 16 replaced with take 7.",
    variations: [
      { fileId: dry, name: "Dry" },
      { fileId: named("Wet v2"), name: "Wet" },
    ],
  });
  // From here on a version needs an edit decision list (#131): the next one is refused.
  await api(page, "PATCH", `/api/projects/${music.id}`, { requireEdl: true });
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
  const pedal = await comment(dry, "Pedal noise on the left, just before the downbeat.", {
    kind: "time",
    start: 6.2,
    end: 6.2,
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
  await comment(dry, "Overall balance is great; the reverb tail could be a touch shorter.");
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
  await comment(cutFile.id, "Logo sits too close to the edge here.", {
    kind: "region",
    at: 8,
    x: 0.7,
    y: 0.75,
    width: 0.25,
    height: 0.2,
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

  // Alex hears when a guest opens a review they asked for.
  await api(page, "PUT", "/api/notifications/preferences", {
    mailMode: "instant",
    digest: "daily",
    kinds: { guest_opened: { app: true, mail: false } },
  });

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

  // The same moment for every run, so dates and "ago" read the same in every capture.
  const sql = postgres(process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "", {
    onnotice: () => undefined,
  });
  try {
    const columns = await sql<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and data_type like 'timestamp%'
        and column_name in ('created_at', 'updated_at', 'decided_at', 'viewed_at', 'submitted_at', 'resolved_at', 'occurred_at', 'opened_at', 'completed_at')`;
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
  } finally {
    await sql.end();
  }

  const seeded: Seeded = {
    musicProjectId: music.id,
    videoProjectId: video.id,
    trackId: track.id,
    dryFileId: dry,
    scoreFileId: score,
    cutFileId: cutFile.id,
    reviewId: review.id,
    reviewStates: { decided, changes, approved, cancelled, waiting, overdue },
    invitationPath: new URL(invitation).pathname,
    usedGuestPath: guestLink,
  };
  writeFileSync(join(state, "seeded.json"), JSON.stringify(seeded, null, 2));
  await page.context().storageState({ path: join(state, "owner.json") });
});
