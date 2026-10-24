import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  alignmentsQuery,
  type FileDetail,
  fileQuery,
  projectQuery,
  type Track,
  trackQuery,
} from "~/lib/queries";
import { FileContext, positionIn, VersionNote } from "./tracks";

const variation = (fileId: string, name: string, isPrimary: boolean, versionId: string) => ({
  id: `${fileId}-variation`,
  versionId,
  fileId,
  name,
  isPrimary,
  position: isPrimary ? 0 : 1,
  fileName: `${fileId}.wav`,
  kind: "audio" as const,
  streamStatus: "ready" as const,
  subtitled: null,
  graded: null,
  video: null,
});

const track = {
  id: "track",
  projectId: "project",
  name: "Maple Leaf Rag",
  scoreFileId: "score",
  versions: [
    {
      id: "v1",
      number: 1,
      createdByName: "Alex Rivera",
      edlFileId: null,
      letThroughBy: null,
      notes: null,
      createdAt: "2026-10-12T09:00:00Z",
      variations: [variation("v1-dry", "Dry", true, "v1"), variation("v1-wet", "Wet", false, "v1")],
    },
    {
      id: "v2",
      number: 2,
      createdByName: "Alex Rivera",
      edlFileId: null,
      letThroughBy: null,
      notes: "Bars 12 to 16 replaced with take 7.",
      createdAt: "2026-10-14T10:12:00Z",
      variations: [variation("v2-dry", "Dry", true, "v2"), variation("v2-wet", "Wet", false, "v2")],
    },
  ],
} as unknown as Track;

const file = {
  id: "v2-wet",
  projectId: "project",
  name: "Maple Leaf Rag - Wet v2.wav",
  profile: "music",
  variation: {
    id: "v2-wet-variation",
    name: "Wet",
    isPrimary: false,
    versionId: "v2",
    versionNumber: 2,
    trackId: "track",
    trackName: "Maple Leaf Rag",
    scoreFileId: "score",
  },
} as unknown as FileDetail;

/** V1 runs a little slower: 10 seconds of V2 is 12 of V1. */
const alignments = [
  {
    fileId: "v1-wet",
    points: [
      [0, 0],
      [20, 24],
    ],
  },
];

function client() {
  const c = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  c.setQueryData(trackQuery("track").queryKey, track);
  c.setQueryData(alignmentsQuery(file.id).queryKey, alignments as never);
  c.setQueryData(projectQuery("project").queryKey, { id: "project", profile: "music" } as never);
  c.setQueryData(fileQuery("score").queryKey, { id: "score", name: "Score.pdf" } as never);
  return c;
}

function Strip({ guest, media }: { guest: boolean; media: HTMLMediaElement | null }) {
  const [shown, setShown] = useState(false);
  return (
    <>
      <FileContext
        file={file}
        media={media}
        guest={guest}
        score={{ shown, onToggle: () => setShown((on) => !on) }}
      />
      {!guest && <VersionNote file={file} />}
    </>
  );
}

async function show({ guest = false, at }: { guest?: boolean; at?: number } = {}) {
  const media = at === undefined ? null : ({ currentTime: at } as HTMLMediaElement);
  const root = createRootRoute({ component: () => <Outlet /> });
  const page = (path: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      validateSearch: (search: Record<string, unknown>) => search,
      component: () => <Strip guest={guest} media={media} />,
    });
  const router = createRouter({
    routeTree: root.addChildren([page("/files/$fileId"), page("/tracks/$trackId")]),
    history: createMemoryHistory({ initialEntries: [`/files/${file.id}?review=r1`] }),
  });
  render(
    <QueryClientProvider client={client()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  await screen.findByText(guest ? "V2 is under review" : "Score");
  return router;
}

describe("the strip above the player (#15)", () => {
  beforeEach(() => {
    // Nothing reaches the network: every answer the strip needs is already known.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
    // The router restores the scroll on each move; jsdom has no scrolling to do.
    vi.stubGlobal("scrollTo", vi.fn());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("names the version heard in a menu of every version, newest first", async () => {
    await show();
    const menu = await screen.findByRole("button", { name: /^Version V2/ });
    expect(menu.textContent).toContain("latest");
    fireEvent.click(menu);
    const items = screen.getAllByRole("menuitemradio").map((i) => i.textContent);
    expect(items[0]).toMatch(/^V2/);
    expect(items[1]).toMatch(/^V1/);
    expect(screen.getByRole("menuitem", { name: "All versions and notes" })).toBeTruthy();
  });

  it("opens another version's variation of the same name at the same music", async () => {
    const router = await show({ at: 10 });
    fireEvent.click(await screen.findByRole("button", { name: /^Version V2/ }));
    await act(async () => fireEvent.click(screen.getByRole("menuitemradio", { name: /^V1/ })));
    await waitFor(() => expect(router.state.location.pathname).toBe("/files/v1-wet"));
    expect(router.state.location.search).toMatchObject({
      review: "r1",
      t: positionIn("v1-wet", 10, alignments as never),
    });
    expect(positionIn("v1-wet", 10, alignments as never)).toBe(12);
  });

  it("switches variation within the version, pressed where it is heard", async () => {
    const router = await show({ at: 3 });
    const wet = screen.getByRole("button", { name: "Wet" });
    expect(wet.getAttribute("aria-pressed")).toBe("true");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Dry" })));
    await waitFor(() => expect(router.state.location.pathname).toBe("/files/v2-dry"));
    expect(router.state.location.search).toMatchObject({ review: "r1", t: 3 });
  });

  it("shows the score only when asked, from its switch", async () => {
    await show();
    const score = screen.getByRole("button", { name: "Score" });
    expect(score.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(score);
    expect(score.getAttribute("aria-pressed")).toBe("true");
  });

  it("says who left the version's note, and what it says", async () => {
    await show();
    expect(screen.getByText("Bars 12 to 16 replaced with take 7.")).toBeTruthy();
    expect(screen.getByText("Alex Rivera")).toBeTruthy();
  });

  it("tells a guest which version their review holds, with no way to the others", async () => {
    await show({ guest: true });
    expect(screen.queryByRole("button", { name: /^Version/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Score" })).toBeTruthy();
  });
});
