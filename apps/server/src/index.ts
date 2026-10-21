import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { boot } from "./boot.ts";
import { createInstallApp } from "./install-app.ts";
import { servesPath } from "./lanes.ts";
import { shutDown } from "./lifecycle.ts";
import { needsInstall, readSettingsFile, settingsPath, withSettings } from "./settings-file.ts";
import { createSetupGate, setupMessage } from "./setup-code.ts";
import { version } from "./version.ts";

// The environment, with the settings the installer wrote beneath it (decision 061).
const settingsFile = settingsPath(process.env);
const settings = () => withSettings(process.env, readSettingsFile(settingsFile));
const gate = createSetupGate({ code: process.env.HEKATE_SETUP_CODE });

type Handler = (request: Request) => Response | Promise<Response>;
let handler: Handler;
let stop = async (_timeoutMs?: number) => {};

/** The configured server: from the start, or once the installer has finished. */
async function start() {
  const booted = await boot(settings(), { gate });
  // A worker answers only its health and metrics (#189): requests go to the API replicas.
  handler = (request) =>
    servesPath(booted.role, new URL(request.url).pathname)
      ? booted.app.fetch(request)
      : new Response("This process runs background jobs only.", { status: 404 });
  stop = booted.stop;
  if (booted.needsOwner) console.log(setupMessage(gate, booted.publicUrl));
  return booted.port;
}

const port = needsInstall(process.env, readSettingsFile(settingsFile))
  ? (() => {
      const port = Number(process.env.PORT || 3000);
      const installer = createInstallApp({
        env: process.env,
        settingsFile,
        gate,
        nonce: randomBytes(24).toString("base64url"),
        finish: async () => {
          await start();
          console.log("Installed. Hekate is starting.");
        },
        webDist: process.env.WEB_DIST,
        docsUrl: process.env.HEKATE_DOCS_URL || "https://docs.hekate.studio",
      });
      handler = (request) => installer.fetch(request);
      console.log(setupMessage(gate, process.env.PUBLIC_URL || `http://localhost:${port}`));
      return port;
    })()
  : await start();

// HTTP/1.1, as serve makes it by default.
const server = serve({ fetch: (request) => handler(request), port }, (info) => {
  console.log(`Hekate ${version} listening on :${info.port}`);
}) as Server;

// Told to stop, drain and finish what is under way before exiting (#193, lifecycle.ts).
const drainMs = Number(process.env.SHUTDOWN_DRAIN_SECONDS ?? 5) * 1000;
const timeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_SECONDS ?? 30) * 1000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`Stopping: draining for ${drainMs / 1000} s, then finishing what is under way.`);
    void shutDown(
      {
        drain: sleep,
        stopServing: (ms) =>
          new Promise<void>((resolve) => {
            // Connections idle between requests go now; those mid-request at the deadline.
            const late = setTimeout(() => server.closeAllConnections(), ms);
            server.close(() => {
              clearTimeout(late);
              resolve();
            });
            server.closeIdleConnections();
          }),
        stopWork: (ms) => stop(ms),
      },
      { drainMs, timeoutMs },
    )
      .catch((error: unknown) => console.error("Stopping failed:", error))
      .then(() => process.exit(0));
  });
}
