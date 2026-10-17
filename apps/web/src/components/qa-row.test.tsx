import type { QaFinding } from "@hekate/shared";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FindingRow } from "./qa";

const finding = (over: Partial<QaFinding>): QaFinding => ({
  check: "loudness",
  severity: "fail",
  summary: "−16.0 LUFS, 2.0 LU below the −14 LUFS target",
  channel: null,
  start: null,
  end: null,
  details: {},
  ...over,
});

describe("a finding's row (#43)", () => {
  it("lets every problem start a comment, timed or about the whole file", () => {
    const onComment = vi.fn();
    const whole = finding({});
    const view = render(
      <ul>
        <FindingRow finding={whole} onSeek={() => {}} onComment={onComment} />
        <FindingRow
          finding={finding({ check: "clipping", summary: "Clipped", start: 12, end: 12.5 })}
          onSeek={() => {}}
          onComment={onComment}
        />
        <FindingRow
          finding={finding({ check: "dc-offset", severity: "pass", summary: "No DC offset" })}
          onSeek={() => {}}
          onComment={onComment}
        />
      </ul>,
    );
    fireEvent.click(view.getByRole("button", { name: "Comment on Loudness" }));
    expect(onComment).toHaveBeenCalledWith(whole);
    expect(view.getByRole("button", { name: /^Comment on 0:12/ })).toBeTruthy();
    // What passed has nothing to comment on.
    expect(view.getAllByRole("button", { name: /^Comment on / })).toHaveLength(2);
  });
});
