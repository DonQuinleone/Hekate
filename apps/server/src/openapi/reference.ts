import type { AppDeps } from "../app.ts";
import { createApi } from "../app.ts";
import { openapiDocument } from "./document.ts";

/**
 * The document the documentation site publishes (`docs/openapi.json`), for no instance in
 * particular: the routes are built with dependencies that are never called (building them
 * reads none), and the server is a placeholder for the reader's own instance's address.
 * `pnpm --filter @hekate/server api:reference` writes it; a test fails when it is out of date.
 */
export function referenceApi() {
  // Never called: building the routes only keeps what it is given for later.
  const inert: unknown = new Proxy(() => inert, {
    get: (_target, key) => (key === "then" ? undefined : inert),
    apply: () => inert,
  });
  const deps = {
    db: inert,
    auth: inert,
    mailer: inert,
    storage: inert,
    audit: inert,
    keyring: inert,
    playbackSecret: Buffer.alloc(32),
    jobs: inert,
    publicUrl: "https://review.endlesshall.example",
  } as unknown as AppDeps;
  return createApi(deps);
}

export function referenceDocument() {
  return openapiDocument(referenceApi(), {
    server: {
      url: "https://{instance}/api/v1",
      description: "Your Hekate instance",
      variables: {
        instance: {
          default: "review.endlesshall.example",
          description: "Your instance's address, as you open it in a browser.",
        },
      },
    },
  });
}

/** The document as `docs/openapi.json` holds it. */
export const referenceText = () => `${JSON.stringify(referenceDocument(), null, 2)}\n`;
