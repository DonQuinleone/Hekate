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
 * `names` turns a project or person id into what people call it.
 */
export function describeSearch(search: SearchRequest, names: (id: string) => string | undefined) {
  const parts: string[] = [];
  if (search.q) parts.push(`“${search.q}”`);
  const kind = kindChoices.find((c) => c.value === kindChoice(search));
  if (kind?.value) parts.push(kind.label);
  for (const id of [search.projectId, search.personId]) {
    const name = id && names(id);
    if (name) parts.push(name);
  }
  if (search.since) parts.push(sinceLabels[search.since].toLowerCase());
  return parts.join(", ").slice(0, 60);
}

/** Only what is set, so the address stays short and two equal searches read the same. */
export function compact(search: SearchRequest): SearchRequest {
  return Object.fromEntries(
    Object.entries(search).filter(([key, value]) => key === "q" || value),
  ) as SearchRequest;
}
