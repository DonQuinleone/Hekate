import type { IconName } from "~/components/icons";
import {
  comments,
  type File,
  fileById,
  files,
  people,
  personById,
  projectById,
  projects,
  reviews,
  tasks,
  tracks,
} from "~/data";
import type { Viewer } from "~/viewer/context";

/** Where a hit goes: a route with its params and query. */
export interface Destination {
  to: string;
  params?: Record<string, string>;
  search?: Record<string, string>;
}

export type HitGroup =
  | "Jump to"
  | "Recent"
  | "Actions"
  | "Projects"
  | "Tracks"
  | "Files"
  | "Reviews"
  | "Tasks"
  | "People"
  | "Comments";

export interface Hit {
  id: string;
  group: HitGroup;
  label: string;
  /** Where it lives, or what it does. */
  hint?: string;
  icon?: IconName;
  personId?: string;
  projectId?: string;
  file?: File;
  /** A key the action also answers to. */
  shortcut?: string;
  /** Text matched against the query, beyond the label. */
  keywords?: string;
  destination?: Destination;
  run?: () => void;
}

export const groupOrder: HitGroup[] = [
  "Jump to",
  "Recent",
  "Actions",
  "Projects",
  "Tracks",
  "Files",
  "Reviews",
  "Tasks",
  "People",
  "Comments",
];

/** How well `text` answers `query`: a prefix beats a word start beats a mention beats scattered letters. */
export function score(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 4;
  if (t.split(/[\s·:,/-]+/).some((w) => w.startsWith(q))) return 3;
  if (t.includes(q)) return 2;
  // Scattered letters count only once the query is long enough to mean something.
  if (q.length < 3) return 0;
  let i = 0;
  for (const ch of t) if (ch === q[i]) i += 1;
  return i === q.length ? 1 : 0;
}

const taskKey = (projectId: string, id: string) =>
  `${projectId === "proj-joplin" ? "JR" : "OT"}-${id.split("-")[1]}`;

/** The three things the viewer opened last. */
export const recentIds = [
  { kind: "file", id: "file-maple-v2-dry" },
  { kind: "review", id: "rev-masters" },
  { kind: "file", id: "file-titles-c3" },
] as const;

/** Everything the viewer may reach, as hits; the palette and the search page both draw on it. */
export function everything(viewer: Viewer): Hit[] {
  const hits: Hit[] = [];
  for (const p of projects) {
    if (!viewer.canSee(p.id)) continue;
    hits.push({
      id: p.id,
      group: "Projects",
      projectId: p.id,
      label: p.name,
      hint: p.description,
      icon: "folder",
      destination: { to: "/projects/$projectId", params: { projectId: p.id } },
    });
  }
  for (const t of tracks) {
    if (!viewer.canSee(t.projectId)) continue;
    hits.push({
      id: t.id,
      group: "Tracks",
      projectId: t.projectId,
      label: t.name,
      hint: `${projectById(t.projectId)?.name} · ${t.versions.length} versions`,
      icon: "track",
      keywords: t.composer ?? "",
      destination: { to: "/tracks/$trackId", params: { trackId: t.id } },
    });
  }
  for (const f of files) {
    if (!viewer.canSee(f.projectId)) continue;
    hits.push({
      id: f.id,
      group: "Files",
      projectId: f.projectId,
      label: f.name,
      hint: projectById(f.projectId)?.name,
      file: f,
      destination: { to: "/files/$fileId", params: { fileId: f.id } },
    });
  }
  for (const r of viewer.reviews()) {
    hits.push({
      id: r.id,
      group: "Reviews",
      projectId: r.projectId,
      label: r.title,
      hint: `${projectById(r.projectId)?.name} · ${r.kind === "approval" ? "approval" : "feedback"}`,
      icon: "review",
      destination: { to: "/reviews/$reviewId", params: { reviewId: r.id } },
    });
  }
  for (const t of tasks) {
    if (!viewer.canSee(t.projectId)) continue;
    hits.push({
      id: t.id,
      group: "Tasks",
      projectId: t.projectId,
      label: t.title,
      hint: `${taskKey(t.projectId, t.id)} · ${t.assigneeId ? personById(t.assigneeId).name : "unassigned"}`,
      icon: "task",
      keywords: taskKey(t.projectId, t.id),
      destination: {
        to: "/projects/$projectId/$view",
        params: { projectId: t.projectId, view: "tasks" },
        search: { task: t.id },
      },
    });
  }
  for (const p of people) {
    hits.push({
      id: p.id,
      group: "People",
      label: p.name,
      hint: p.label ?? p.email,
      personId: p.id,
      keywords: p.email,
      destination: { to: "/members" },
    });
  }
  for (const c of comments) {
    const f = fileById(c.fileId);
    if (!f || !viewer.canSee(f.projectId)) continue;
    hits.push({
      id: c.id,
      group: "Comments",
      projectId: f.projectId,
      label: c.body,
      hint: `${personById(c.authorId).name} · ${f.name}`,
      personId: c.authorId,
      destination: {
        to: "/files/$fileId",
        params: { fileId: c.fileId },
        search: { comment: c.id },
      },
    });
  }
  return hits;
}

/** The recent items the viewer may still open. */
export function recent(viewer: Viewer): Hit[] {
  const out: Hit[] = [];
  for (const r of recentIds) {
    if (r.kind === "file") {
      const f = fileById(r.id);
      if (!f || viewer.fileAccess(r.id) === null) continue;
      out.push({
        id: r.id,
        group: "Recent",
        label: f.name,
        hint: projectById(f.projectId)?.name,
        file: f,
        destination: { to: "/files/$fileId", params: { fileId: r.id } },
      });
    } else {
      const review = reviews.find((x) => x.id === r.id);
      if (!review || !(viewer.canSee(review.projectId) || viewer.reviewerIn(review))) continue;
      out.push({
        id: r.id,
        group: "Recent",
        label: review.title,
        hint: projectById(review.projectId)?.name,
        icon: "review",
        destination: { to: "/reviews/$reviewId", params: { reviewId: r.id } },
      });
    }
  }
  return out;
}

/** Hits that answer the query, best first within each group, at most `limit` per group. */
export function matches(query: string, hits: Hit[], limit = 5): Hit[] {
  const q = query.trim();
  const scored = hits
    .map((h) => ({
      hit: h,
      score: Math.max(score(q, h.label), h.keywords ? score(q, h.keywords) - 0.5 : 0),
    }))
    .filter((s) => s.score > 0);
  const out: Hit[] = [];
  for (const g of groupOrder) {
    const inGroup = scored
      .filter((s) => s.hit.group === g)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.hit);
    out.push(...inGroup);
  }
  return out;
}
