import { describe, expect, it } from "vitest";
import { shortAgent } from "./agent";

describe("shortAgent", () => {
  it("names the browser and the system", () => {
    expect(
      shortAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      ),
    ).toBe("Safari on macOS");
    expect(
      shortAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0",
      ),
    ).toBe("Edge on Windows");
    expect(
      shortAgent("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0"),
    ).toBe("Firefox on Linux");
    expect(
      shortAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Chrome on iOS");
  });

  it("falls back to what it has", () => {
    expect(shortAgent(null)).toBeNull();
    expect(shortAgent("curl/8.9.1")).toBe("curl/8.9.1");
  });
});
