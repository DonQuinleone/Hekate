// The load test (#196): k6 scenarios against one Hekate instance, with the targets the docs
// record (docs/site/src/content/docs/operate/load-testing.md) as its thresholds.
//
//   k6 run -e HEKATE_URL=https://localhost -e HEKATE_SETUP_CODE=… -e HEKATE_MEDIA=… load/hekate.js
//
// Against a fresh instance it sets itself up with the setup code; against one already set up,
// give the owner's HEKATE_EMAIL and HEKATE_PASSWORD instead. Either way it works in a project of
// its own, so run it against a test instance, never one people use: it leaves what it made.
import { check, fail, sleep } from "k6";
import crypto from "k6/crypto";
import exec from "k6/execution";
import { open, SeekMode } from "k6/experimental/fs";
import http from "k6/http";
import { Counter, Rate, Trend } from "k6/metrics";

const base = (__ENV.HEKATE_URL || "https://localhost").replace(/\/$/, "");
const email = __ENV.HEKATE_EMAIL || "producer@example.test";
const password = __ENV.HEKATE_PASSWORD || "correct horse battery";
// Each session may fetch 30 stream keys a minute, so playback is spread over several; sign-in
// allows 10 a minute from one address.
const sessionCount = Number(__ENV.HEKATE_SESSIONS || 6);
const duration = __ENV.HEKATE_DURATION || "2m";
// Scales every arrival rate together, for a bigger machine or several replicas.
const scale = Number(__ENV.HEKATE_SCALE || 1);
const rate = (perSecond) => Math.max(1, Math.round(perSecond * scale));

// A minute or so of audio (ffmpeg makes one; see the docs), read once and shared by every VU.
const media = await open(__ENV.HEKATE_MEDIA || "media.flac");
const mediaSize = (await media.stat()).size;

export const options = {
  insecureSkipTLSVerify: __ENV.HEKATE_INSECURE === "1",
  setupTimeout: "10m",
  scenarios: {
    // People listening: a stream started, its playlists, key and every segment.
    playback: {
      executor: "constant-arrival-rate",
      exec: "playback",
      rate: rate(2),
      timeUnit: "1s",
      duration,
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
    // Comments posted in bursts, and the list each poster reads back.
    comments: {
      executor: "constant-arrival-rate",
      exec: "comments",
      rate: rate(5),
      timeUnit: "1s",
      duration,
      preAllocatedVUs: 10,
      maxVUs: 50,
    },
    // Reviewers opening the review page: the review, its file and its comments.
    review: {
      executor: "constant-arrival-rate",
      exec: "review",
      rate: rate(5),
      timeUnit: "1s",
      duration,
      preAllocatedVUs: 10,
      maxVUs: 50,
    },
    // Uploads in parts: started, every part sent, completed.
    uploads: {
      executor: "constant-arrival-rate",
      exec: "uploads",
      rate: rate(12),
      timeUnit: "1m",
      duration,
      preAllocatedVUs: 4,
      maxVUs: 20,
    },
    // Audio uploaded while all of that goes on, timed until it streams.
    transcodes: {
      executor: "per-vu-iterations",
      exec: "transcodes",
      vus: 2,
      iterations: 2,
      maxDuration: "10m",
    },
  },
  // The targets (see the docs): what the image meets on a GitHub-hosted runner with k6,
  // PostgreSQL and Caddy on the same four cores, with room for a noisy neighbour.
  thresholds: {
    http_req_failed: ["rate<0.01"],
    checks: ["rate>0.99"],
    "http_req_duration{scenario:playback,step:start}": ["p(95)<1000"],
    "http_req_duration{scenario:playback,step:key}": ["p(95)<500"],
    "http_req_duration{scenario:playback,step:segment}": ["p(95)<500"],
    "http_req_duration{scenario:comments}": ["p(95)<750"],
    "http_req_duration{scenario:review}": ["p(95)<1000"],
    "http_req_duration{scenario:uploads,step:part}": ["p(95)<2000"],
    // Over the whole run, the setup included: what two streams a second come to.
    segments: [`rate>${15 * scale}`],
    transcode_seconds: ["p(95)<30"],
    transcodes_failed: ["rate==0"],
  },
};

const segments = new Counter("segments");
const transcodeSeconds = new Trend("transcode_seconds");
const transcodesFailed = new Rate("transcodes_failed");

const json = { "Content-Type": "application/json", Origin: base };
const as = (cookie, step, headers = json) => ({
  headers: { ...headers, Cookie: cookie },
  tags: { step },
  // Keys and segments are bytes, read as they are rather than as text.
  responseType: step === "key" || step === "segment" ? "binary" : "text",
});

/** Fails the test with what the server said, for a step it cannot go on without. */
function must(res, status, what) {
  if (res.status !== status) fail(`${what}: ${res.status} ${res.body}`);
  return res.status === 204 ? null : res.json();
}

function signIn() {
  const res = http.post(`${base}/api/auth/sign-in/email`, JSON.stringify({ email, password }), {
    headers: json,
  });
  must(res, 200, "Signing in");
  const name = Object.keys(res.cookies).find((n) => n.endsWith("session_token"));
  if (!name) fail("Signing in set no session cookie");
  return `${name}=${res.cookies[name][0].value}`;
}

/** Sends `bytes` as an upload in parts and completes it, returning the file. */
function upload(cookie, projectId, name, contentType, bytes) {
  const started = must(
    http.post(
      `${base}/api/uploads`,
      JSON.stringify({ projectId, name, size: bytes.byteLength, contentType }),
      as(cookie, "start"),
    ),
    201,
    "Starting an upload",
  ).upload;
  for (let index = 0; index < started.chunkCount; index++) {
    const from = index * started.chunkSize;
    const part = bytes.slice(from, Math.min(from + started.chunkSize, bytes.byteLength));
    const res = http.put(
      `${base}/api/uploads/${started.id}/chunks/${index}`,
      part,
      as(cookie, "part", { "Content-Type": "application/octet-stream", Origin: base }),
    );
    check(res, { "a part is taken": (r) => r.status === 204 });
  }
  const done = http.post(
    `${base}/api/uploads/${started.id}/complete`,
    null,
    as(cookie, "complete"),
  );
  check(done, { "an upload completes": (r) => r.status === 201 });
  return done.status === 201 ? done.json().file : null;
}

async function readMedia() {
  const bytes = new Uint8Array(mediaSize);
  await media.seek(0, SeekMode.Start);
  let read = 0;
  while (read < mediaSize) {
    const n = await media.read(bytes.subarray(read));
    if (n === null) break;
    read += n;
  }
  return bytes.buffer;
}

/** Waits until a file streams; the seconds it took, or null if it failed or never did. */
function untilStreaming(cookie, fileId, limitSeconds) {
  const from = Date.now();
  while ((Date.now() - from) / 1000 < limitSeconds) {
    const res = http.get(`${base}/api/files/${fileId}`, as(cookie, "status"));
    const status = res.status === 200 ? res.json().file.streamStatus : null;
    if (status === "ready") return (Date.now() - from) / 1000;
    if (status === "failed") return null;
    sleep(1);
  }
  return null;
}

export async function setup() {
  const code = __ENV.HEKATE_SETUP_CODE;
  if (code && http.get(`${base}/api/setup`).json().needed) {
    must(
      http.post(
        `${base}/api/setup`,
        JSON.stringify({
          name: "Alex Rivera",
          email,
          password,
          organisation: "Endless Hall Records",
        }),
        { headers: { ...json, "x-hekate-setup-code": code } },
      ),
      201,
      "Setting up",
    );
  }
  const sessions = Array.from({ length: sessionCount }, signIn);
  const owner = sessions[0];
  const project = must(
    http.post(
      `${base}/api/projects`,
      JSON.stringify({ name: `Load test ${new Date().toISOString()}`, profile: "music" }),
      as(owner, "setup"),
    ),
    201,
    "Making the project",
  ).project;
  const file = upload(
    owner,
    project.id,
    "Maple Leaf Rag - Mix v1.flac",
    "audio/flac",
    await readMedia(),
  );
  if (!file) fail("The audio could not be uploaded");
  if (untilStreaming(owner, file.id, 300) === null) fail("The audio never streamed");
  const review = must(
    http.post(
      `${base}/api/projects/${project.id}/reviews`,
      JSON.stringify({
        kind: "feedback",
        items: [{ fileId: file.id }],
        reviewers: [{ name: "Mira Solberg", email: "mira@example.test" }],
      }),
      as(owner, "setup"),
    ),
    201,
    "Asking for a review",
  ).review;
  return { sessions, projectId: project.id, fileId: file.id, reviewId: review.id };
}

/** Each iteration takes the next session, so none fetches more keys than it may. */
const sessionFor = (data) => data.sessions[exec.scenario.iterationInTest % data.sessions.length];

export function playback(data) {
  const cookie = sessionFor(data);
  const started = http.post(`${base}/api/files/${data.fileId}/playback`, null, as(cookie, "start"));
  if (!check(started, { "a stream starts": (r) => r.status === 201 })) return;
  const master = `${base}${started.json().url}`;
  const root = master.slice(0, master.lastIndexOf("/") + 1);
  const variants = http.get(master, as(cookie, "playlist"));
  const variant = variants.body.split("\n").find((line) => line && !line.startsWith("#"));
  if (!check(variant, { "the stream has a rendition": (v) => Boolean(v) })) return;
  const playlistUrl = root + variant;
  const dir = playlistUrl.slice(0, playlistUrl.lastIndexOf("/") + 1);
  const playlist = http.get(playlistUrl, as(cookie, "playlist")).body;
  const key = http.get(`${dir}key`, as(cookie, "key"));
  check(key, { "the key is issued": (r) => r.status === 200 && r.body.byteLength === 16 });
  http.get(`${dir}init.mp4`, as(cookie, "segment"));
  for (const line of playlist.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const res = http.get(dir + line, as(cookie, "segment"));
    if (check(res, { "a segment arrives": (r) => r.status === 200 })) segments.add(1);
  }
}

export function comments(data) {
  const cookie = sessionFor(data);
  const start = Math.round(Math.random() * 500) / 10;
  const res = http.post(
    `${base}/api/files/${data.fileId}/comments`,
    JSON.stringify({
      body: "The left hand drags in the second strain; take it a touch lighter.",
      anchor: { kind: "time", start, end: start + 2 },
    }),
    as(cookie, "post"),
  );
  check(res, { "a comment is posted": (r) => r.status === 201 });
  check(http.get(`${base}/api/files/${data.fileId}/comments`, as(cookie, "list")), {
    "comments are listed": (r) => r.status === 200,
  });
}

export function review(data) {
  const cookie = sessionFor(data);
  const responses = http.batch([
    ["GET", `${base}/api/reviews/${data.reviewId}`, null, as(cookie, "review")],
    ["GET", `${base}/api/files/${data.fileId}`, null, as(cookie, "file")],
    ["GET", `${base}/api/files/${data.fileId}/comments`, null, as(cookie, "list")],
  ]);
  check(responses, { "the review page loads": (rs) => rs.every((r) => r.status === 200) });
}

// Uploads send random bytes, a little over two parts, made once for each VU that uploads.
let payload;

export function uploads(data) {
  payload ??= crypto.randomBytes(17 * 1024 * 1024);
  const cookie = sessionFor(data);
  upload(
    cookie,
    data.projectId,
    `Stems ${exec.scenario.iterationInTest}.bin`,
    "application/octet-stream",
    payload,
  );
}

export async function transcodes(data) {
  const cookie = sessionFor(data);
  const file = upload(
    cookie,
    data.projectId,
    `Maple Leaf Rag - Take ${exec.scenario.iterationInTest + 1}.flac`,
    "audio/flac",
    await readMedia(),
  );
  const seconds = file ? untilStreaming(cookie, file.id, 300) : null;
  transcodesFailed.add(seconds === null);
  if (seconds !== null) transcodeSeconds.add(seconds);
}
