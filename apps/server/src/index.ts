import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { boot } from "./boot.ts";
import { createInstallApp } from "./install-app.ts";
import { needsInstall, readSettingsFile, settingsPath, withSettings } from "./settings-file.ts";
import { createSetupGate, setupMessage } from "./setup-code.ts";
import { version } from "./version.ts";

// The environment, with the settings the installer wrote beneath it (decision 061).
const settingsFile = settingsPath(process.env);
const settings = () => withSettings(process.env, readSettingsFile(settingsFile));
const gate = createSetupGate({ code: process.env.HEKATE_SETUP_CODE });

type Handler = (request: Request) => Response | Promise<Response>;
let handler: Handler;
let stop = async () => {};

/** The configured server: from the start, or once the installer has finished. */
async function start() {
  const booted = await boot(settings(), { gate });
  handler = (request) => booted.app.fetch(request);
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

const server = serve({ fetch: (request) => handler(request), port }, (info) => {
  console.log(`Hekate ${version} listening on :${info.port}`);
});

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close();
    void stop().then(() => process.exit(0));
  });
}
