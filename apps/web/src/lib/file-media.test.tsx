import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useFileMedia } from "./file-media";

/** A media element as far as starting it goes: its metadata, its position, its events. */
const element = (readyState: number) =>
  Object.assign(new EventTarget(), {
    readyState,
    duration: 40,
    currentTime: 0,
  }) as unknown as HTMLMediaElement & { readyState: number };

describe("useFileMedia (#15)", () => {
  it("starts the new version where the last one was, not the old source", () => {
    const onStarted = vi.fn();
    const { result, rerender } = renderHook(
      ({ fileId, startAt }: { fileId: string; startAt?: number }) =>
        useFileMedia(fileId, startAt, onStarted),
      { initialProps: { fileId: "v1" } as { fileId: string; startAt?: number } },
    );
    // Version 1 is playing, its metadata long loaded.
    const player = element(4);
    act(() => result.current.onMedia(player));
    expect(result.current.media).toBe(player);

    // On to version 2 at 12 seconds: the element announced for version 1 is not version 2's.
    rerender({ fileId: "v2", startAt: 12 });
    expect(result.current.media).toBeNull();
    expect(player.currentTime).toBe(0);
    expect(onStarted).not.toHaveBeenCalled();

    // The player lets version 1 go and announces the same element for version 2.
    player.readyState = 0;
    act(() => result.current.onMedia(null));
    act(() => result.current.onMedia(player));
    expect(result.current.media).toBe(player);
    expect(onStarted).not.toHaveBeenCalled();
    // Once version 2 can seek, it starts there, once.
    act(() => {
      player.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(player.currentTime).toBe(12);
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("never seeks past the end, and starts at once where it already can", () => {
    const onStarted = vi.fn();
    const { result } = renderHook(() => useFileMedia("v2", 90, onStarted));
    const player = element(1);
    act(() => result.current.onMedia(player));
    expect(player.currentTime).toBe(40);
    expect(onStarted).toHaveBeenCalledTimes(1);
  });
});
