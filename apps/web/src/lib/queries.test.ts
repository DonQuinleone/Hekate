import { describe, expect, it } from "vitest";
import { ApiError, json, quoting } from "./queries";

describe("a failure's reference", () => {
  it("asks them to quote it, once", () => {
    expect(quoting("Something went wrong", "HK-7F3A-2C")).toBe(
      "Something went wrong. Quote HK-7F3A-2C to support.",
    );
    expect(quoting("That file is gone.", "HK-7F3A-2C")).toBe(
      "That file is gone. Quote HK-7F3A-2C to support.",
    );
    expect(quoting("That file is gone.")).toBe("That file is gone.");
  });

  it("reaches the error every page shows", async () => {
    const res = new Response(
      JSON.stringify({
        error: { code: "internal", message: "Something went wrong", reference: "HK-7F3A-2C" },
      }),
      { status: 500 },
    );
    const error = await json(res).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: "internal",
      reference: "HK-7F3A-2C",
      message: "Something went wrong. Quote HK-7F3A-2C to support.",
    });
  });
});
