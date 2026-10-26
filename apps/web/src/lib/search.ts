import type { FileKind, SearchKind, SearchRequest, SearchSince } from "@hekate/shared";

/**
 * The search page's one "kind" menu: a kind of thing, or a kind of file (which is a file
 * search narrowed further). Its value is `kind` or `files:fileKind`.
 */
export const kindChoices: { value: string; label: string; indent?: boolean }[] = [
  { value: "", label: "Everything" },
  { value: "projects", label: "Projects" },
  { value: "tracks", label: "Tracks" },
  { value: "files", label: "Files" },
  { value: "files:audio", label: "Audio", indent: true },
  { value: "files:video", label: "Video", indent: true },
  { value: "files:document", label: "Documents", indent: true },
  { value: "files:image", label: "Pictures", indent: true },
  { value: "reviews", label: "Reviews" },
  { value: "people", label: "People" },
  { value: "comments", label: "Comments" },
];

/** The menu value for a search's kind and file kind. */
export function kindChoice(search: Pick<SearchRequest, "kind" | "fileKind">): string {
  if (search.fileKind) return `files:${search.fileKind}`;
  return search.kind ?? "";
}

/** The kind and file kind a menu value stands for. */
export function fromKindChoice(value: string): { kind?: SearchKind; fileKind?: FileKind } {
  const [kind, fileKind] = value.split(":") as [SearchKind | "", FileKind | undefined];
  return { kind: kind || undefined, fileKind: fileKind || undefined };
}

export const sinceLabels: Record<SearchSince, string> = {
  week: "Past week",
  month: "Past month",
  year: "Past year",
};

/**
 * A name for a search, to offer when keeping it: its words, then what narrows it.
 * `names` turns a project, person or tag id into what people call it.
 */
export function describeSearch(search: SearchRequest, names: (id: string) => string | undefined) {
  const parts: string[] = [];
  if (search.q) parts.push(`“${search.q}”`);
  const kind = kindChoices.find((c) => c.value === kindChoice(search));
  if (kind?.value) parts.push(kind.label);
  for (const id of [search.projectId, search.personId, search.tagId]) {
    const name = id && names(id);
    if (name) parts.push(name);
  }
  if (search.since) parts.push(sinceLabels[search.since].toLowerCase());
  for (const chip of fieldChips(search)) parts.push(chip.label.toLowerCase());
  return parts.join(", ").slice(0, 60);
}

/* ---------- Advanced search by field (decision 263) ---------- */

export type FieldKey =
  | "durationMin"
  | "durationMax"
  | "sizeMin"
  | "sizeMax"
  | "frameRate"
  | "commentText";

const MB = 1_000_000;
const GB = 1_000_000_000;

/** A duration in seconds, as the page says it: "90 s", "2 min", "1 h 30 min". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 6) / 10;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes - hours * 60);
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** A size in bytes, as the page says it: "250 MB", "1.5 GB". */
export function formatSize(bytes: number): string {
  if (bytes >= GB) return `${Math.round((bytes / GB) * 10) / 10} GB`;
  return `${Math.round((bytes / MB) * 10) / 10} MB`;
}

/** The fields set, each as a chip that clears what it says. */
export function fieldChips(search: Partial<SearchRequest>): { keys: FieldKey[]; label: string }[] {
  const chips: { keys: FieldKey[]; label: string }[] = [];
  const { durationMin: dMin, durationMax: dMax, sizeMin: sMin, sizeMax: sMax } = search;
  if (dMin && dMax)
    chips.push({
      keys: ["durationMin", "durationMax"],
      label: `${formatDuration(dMin)} to ${formatDuration(dMax)}`,
    });
  else if (dMin)
    chips.push({ keys: ["durationMin"], label: `Longer than ${formatDuration(dMin)}` });
  else if (dMax)
    chips.push({ keys: ["durationMax"], label: `Shorter than ${formatDuration(dMax)}` });
  if (sMin && sMax)
    chips.push({
      keys: ["sizeMin", "sizeMax"],
      label: `${formatSize(sMin)} to ${formatSize(sMax)}`,
    });
  else if (sMin) chips.push({ keys: ["sizeMin"], label: `Over ${formatSize(sMin)}` });
  else if (sMax) chips.push({ keys: ["sizeMax"], label: `Under ${formatSize(sMax)}` });
  if (search.frameRate) chips.push({ keys: ["frameRate"], label: `${search.frameRate} fps` });
  if (search.commentText)
    chips.push({ keys: ["commentText"], label: `Comments say “${search.commentText}”` });
  return chips;
}

/** The fields as typed in the Fields form: minutes and megabytes, as text. */
export interface FieldDraft {
  durationMin: string;
  durationMax: string;
  sizeMin: string;
  sizeMax: string;
  frameRate: string;
  commentText: string;
}

const shown = (value: number | undefined, unit: number) =>
  value ? String(Math.round((value / unit) * 100) / 100) : "";

/** The form's text for the fields a search has. */
export function draftOf(search: Partial<SearchRequest>): FieldDraft {
  return {
    durationMin: shown(search.durationMin, 60),
    durationMax: shown(search.durationMax, 60),
    sizeMin: shown(search.sizeMin, MB),
    sizeMax: shown(search.sizeMax, MB),
    frameRate: search.frameRate ? String(search.frameRate) : "",
    commentText: search.commentText ?? "",
  };
}

const read = (text: string, unit: number) => {
  const value = Number(text.trim().replace(",", "."));
  return text.trim() && Number.isFinite(value) && value > 0 ? Math.round(value * unit) : undefined;
};

/**
 * The fields a form's text stands for, in seconds and bytes; anything that does not read as a
 * positive number is left out. A range typed the wrong way round is turned the right way.
 */
export function fieldsOf(draft: FieldDraft): Pick<SearchRequest, FieldKey> {
  let durationMin = read(draft.durationMin, 60);
  let durationMax = read(draft.durationMax, 60);
  if (durationMin && durationMax && durationMin > durationMax)
    [durationMin, durationMax] = [durationMax, durationMin];
  let sizeMin = read(draft.sizeMin, MB);
  let sizeMax = read(draft.sizeMax, MB);
  if (sizeMin && sizeMax && sizeMin > sizeMax) [sizeMin, sizeMax] = [sizeMax, sizeMin];
  const frameRate = Number(draft.frameRate) || undefined;
  const commentText = draft.commentText.trim() || undefined;
  return { durationMin, durationMax, sizeMin, sizeMax, frameRate, commentText };
}

/** Only what is set, so the address stays short and two equal searches read the same. */
export function compact(search: SearchRequest): SearchRequest {
  return Object.fromEntries(
    Object.entries(search).filter(([key, value]) => key === "q" || value),
  ) as SearchRequest;
}
