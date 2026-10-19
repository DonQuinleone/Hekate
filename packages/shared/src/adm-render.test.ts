import { describe, expect, it } from "vitest";
import { admRenderTarget, renderOrder } from "./adm-render.ts";
import { layoutChannels } from "./layouts.ts";

describe("rendering an ADM master's objects (#74)", () => {
  it("renders onto the bed's own layout where BS.2051 has it, else onto 7.1.4", () => {
    expect(admRenderTarget("5.1.4")).toMatchObject({ system: "4+5+0", layout: "5.1.4" });
    expect(admRenderTarget("7.1")).toMatchObject({ system: "0+7+0", layout: "7.1" });
    expect(admRenderTarget("7.1.2")).toMatchObject({ system: "4+7+0", layout: "7.1.4" });
    expect(admRenderTarget(undefined)).toMatchObject({ system: "4+7+0", layout: "7.1.4" });
    for (const bed of ["2.0", "5.1", "5.1.2", "5.1.4", "7.1", "7.1.4"]) {
      const target = admRenderTarget(bed);
      expect(target.speakers).toHaveLength(layoutChannels(target.layout));
    }
  });

  it("puts the render's speakers in ffmpeg's order for the layout, sides and rears apart", () => {
    expect(renderOrder(admRenderTarget("7.1.4"))).toBe(
      "pan=7.1.4|FL=c0|FR=c1|FC=c2|LFE=c3|SL=c4|SR=c5|BL=c6|BR=c7|TFL=c8|TFR=c9|TBL=c10|TBR=c11",
    );
    // 5.1's surrounds at 110° are its back pair, as ffmpeg's "5.1" has them.
    expect(renderOrder(admRenderTarget("5.1"))).toBe(
      "pan=5.1|FL=c0|FR=c1|FC=c2|LFE=c3|BL=c4|BR=c5",
    );
    expect(renderOrder(admRenderTarget("2.0"))).toBe("pan=stereo|FL=c0|FR=c1");
  });
});
