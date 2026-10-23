/**
 * What the instance was started with. In the product these are environment variables read once at
 * boot; the prototype keeps them here so the screens can show what each one does.
 */
export const env = {
  /** HEKATE_DOCS_URL: where "View documentation" goes. */
  docsUrl: "https://docs.hekate.studio",
  /** HEKATE_BILLING: off, or a gateway (stripe, paddle, manual). Off by default. */
  billing: "stripe" as "off" | "stripe" | "paddle" | "manual",
  /** HEKATE_SUPPORT: off, app (tickets in the application), link (a desk of yours) or mail. Off by default. */
  support: "app" as "off" | "app" | "link" | "mail",
  supportUrl: "",
  /** HEKATE_STATUS_URL: another status page to link; unset, the instance's own at /status (#183). */
  statusUrl: "https://review.endlesshall.example/status",
};
