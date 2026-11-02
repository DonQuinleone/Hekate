/**
 * Which of an open project's sections holds the page at this address (#612): the one sidebar
 * item marked as current. A project's own pages say it in their address; a file or a track is
 * in Files, a review in Reviews, a session or a take in Production, and the workflow builder in
 * Settings. Nothing else in the sidebar lights up beside it.
 */
export function sectionAt(pathname: string): string | null {
  const [, head = "", id = "", section = ""] = pathname.split("/");
  if (!id) return null;
  if (head === "projects") return sectionOf[section] ?? section;
  if (head === "files" || head === "tracks") return "files";
  if (head === "reviews") return "reviews";
  if (head === "sessions" || head === "takes") return "sessions";
  return null;
}

/** The pages each section holds beside its own. */
const sectionOf: Record<string, string> = {
  // The production tools (#21, #45, #47), import among them.
  repertoire: "sessions",
  schedule: "sessions",
  "score-marking": "sessions",
  stage: "sessions",
  patch: "sessions",
  personnel: "sessions",
  venues: "sessions",
  import: "sessions",
  // The workflow builder opens from the settings, and is shown as part of them.
  workflow: "settings",
};

/** Whether the sidebar's own list of Reviews waiting on you would repeat the page (#613). */
export const listsNeedsYou = (pathname: string) => pathname === "/" || pathname === "/inbox";
