import { defaultPlayerViewSettings, defaultPreferences } from "@hekate/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePlayerView } from "./player-view";
import { meQuery } from "./queries";
import { ViewerProvider } from "./viewer";

/** Two readers of the view on one page: the player, and the line under it. */
function both(guest: boolean, client: QueryClient) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ViewerProvider viewer={{ guest }}>{children}</ViewerProvider>
    </QueryClientProvider>
  );
  return renderHook(() => ({ player: usePlayerView(), line: usePlayerView() }), { wrapper });
}

describe("the player's view on a page (#135)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("is a guest's own, in this browser, and every reader sees a change at once", async () => {
    const { result } = both(true, new QueryClient());
    act(() => result.current.player.setView({ ...result.current.player.view, loudness: false }));
    await waitFor(() => expect(result.current.line.view.loudness).toBe(false));
    act(() => result.current.player.setSplit(true));
    await waitFor(() => expect(result.current.line.split).toBe(true));
    expect(JSON.parse(localStorage.getItem("hekate.player.view") ?? "{}")).toMatchObject({
      loudness: false,
      split: true,
    });
  });

  it("shows a member's change at once, and what the account holds when the save fails", async () => {
    const me = { user: { preferences: defaultPreferences } };
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      return method === "PATCH"
        ? new Response(JSON.stringify({ error: { message: "Down" } }), { status: 503 })
        : new Response(JSON.stringify(me), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    const client = new QueryClient();
    client.setQueryData(meQuery.queryKey, me as never);
    const { result } = both(false, client);
    act(() =>
      result.current.player.setView({ ...defaultPlayerViewSettings, spectrogram: "behind" }),
    );
    await waitFor(() => expect(result.current.line.view.spectrogram).toBe("behind"));
    // Saved a moment later, refused, and put back from the account.
    await waitFor(() => expect(result.current.line.view.spectrogram).toBe("off"), {
      timeout: 2000,
    });
    expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true);
  });
});
