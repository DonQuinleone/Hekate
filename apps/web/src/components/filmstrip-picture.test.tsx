import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFilmstripPicture } from "./filmstrip";

describe("a filmstrip's picture (#42)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is fetched once for everything that shows it, and let go after the last", async () => {
    const fetch = vi.fn(async () => ({ ok: true, blob: async () => new Blob(["frames"]) }));
    const revoke = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:frames", revokeObjectURL: revoke });
    const lane = renderHook(() => useFilmstripPicture("/api/play/x/filmstrip"));
    const frames = renderHook(() => useFilmstripPicture("/api/play/x/filmstrip"));
    await waitFor(() => expect(frames.result.current.src).toBe("blob:frames"));
    expect(lane.result.current).toEqual({ src: "blob:frames", failed: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    lane.unmount();
    expect(revoke).not.toHaveBeenCalled();
    frames.unmount();
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:frames"));
  });

  it("says when the picture could not be had", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })),
    );
    const { result } = renderHook(() => useFilmstripPicture("/api/play/y/filmstrip"));
    await waitFor(() => expect(result.current).toEqual({ src: null, failed: true }));
  });
});
