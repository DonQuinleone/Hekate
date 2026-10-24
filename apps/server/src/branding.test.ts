import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  brandedMailer,
  emailBrandOf,
  LogoRefused,
  pngSize,
  sanitiseLogo,
  sniffImage,
} from "./branding.ts";
import { render } from "./email/render.ts";
import { memoryMailer, sendEmail } from "./mail.ts";
import { run } from "./media/ffmpeg.ts";

/** An image of a colour, made by ffmpeg, as the given kind. */
async function picture(
  dir: string,
  size: string,
  codec: "png" | "mjpeg" | "libwebp",
  name: string,
) {
  const out = join(dir, name);
  await run("ffmpeg", [
    ...["-hide_banner", "-v", "error", "-nostdin"],
    ...["-f", "lavfi", "-i", `color=c=0x4fb3a9:s=${size}`],
    ...["-frames:v", "1", "-c:v", codec, "-f", "image2", "-update", "1", "-y", out],
  ]);
  return readFile(out);
}

describe("a logo", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "hekate-logo-test-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is drawn again as a PNG no larger than 512 pixels a side", async () => {
    const logo = await sanitiseLogo(await picture(dir, "1024x256", "png", "wide.png"), dir);
    expect(sniffImage(logo.png)).toBe("png_pipe");
    expect({ width: logo.width, height: logo.height }).toEqual({ width: 512, height: 128 });
    expect(pngSize(logo.png)).toEqual({ width: 512, height: 128 });
  });

  it("is made from a JPEG or a WebP too, and a small one keeps its size", async () => {
    const jpeg = await sanitiseLogo(await picture(dir, "200x80", "mjpeg", "logo.jpg"), dir);
    expect(sniffImage(jpeg.png)).toBe("png_pipe");
    expect({ width: jpeg.width, height: jpeg.height }).toEqual({ width: 200, height: 80 });
    const webp = await sanitiseLogo(await picture(dir, "300x300", "libwebp", "logo.webp"), dir);
    expect({ width: webp.width, height: webp.height }).toEqual({ width: 300, height: 300 });
  });

  it("keeps nothing of the upload but its pixels", async () => {
    const png = await picture(dir, "64x64", "png", "tagged.png");
    const tail = Buffer.from("<script>alert('kept')</script>");
    const logo = await sanitiseLogo(Buffer.concat([png, tail]), dir);
    expect(logo.png.includes(tail)).toBe(false);
  });

  it("refuses SVG, anything else, an empty file and one too large", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>');
    await expect(sanitiseLogo(svg, dir)).rejects.toThrow(/PNG, JPEG or WebP/);
    await expect(sanitiseLogo(Buffer.from("GIF89a"), dir)).rejects.toBeInstanceOf(LogoRefused);
    await expect(sanitiseLogo(Buffer.alloc(0), dir)).rejects.toThrow(/empty/);
    const huge = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(2 * 1024 * 1024),
    ]);
    await expect(sanitiseLogo(huge, dir)).rejects.toThrow(/2 MB/);
  });

  it("refuses what only looks like an image", async () => {
    const fake = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("not an image at all"),
    ]);
    await expect(sanitiseLogo(fake, dir)).rejects.toThrow(/could not be read/);
  });
});

describe("a workspace's mail", () => {
  const branding = {
    logo: { url: "https://review.example/api/branding/o/logo/b", width: 400, height: 100 },
    accent: { dark: "#4fb3a9", light: "#1f6d66" },
  };

  it("leads with its logo and acts in its accent", () => {
    const html = render({
      workspace: "Endless Hall Records",
      subject: "Album masters",
      heading: "Mira Solberg asked you to review Album masters",
      body: [],
      action: { label: "Open the review", url: "https://review.example/r/1" },
      foot: "You get this because a review was sent to this address.",
      brand: emailBrandOf(branding),
    }).html;
    expect(html).toContain(
      '<img src="https://review.example/api/branding/o/logo/b" width="128" height="32" alt="Endless Hall Records"',
    );
    expect(html).toContain("background:#4fb3a9");
    expect(html).not.toContain("background:#f0762e");
    // Hekate still signs it.
    expect(html).toContain("Sent by Hekate for Endless Hall Records");
  });

  it("is Hekate's own without branding, and never takes an accent it cannot trust", () => {
    const plain = {
      workspace: "Endless Hall Records",
      subject: "Album masters",
      heading: "Album masters",
      body: [],
      action: { label: "Open", url: "https://review.example/r/1" },
      foot: "Foot.",
    };
    expect(render(plain).html).toContain("background:#f0762e");
    expect(render(plain).html).not.toContain("<img");
    const odd = render({ ...plain, brand: { accent: "red;background:url(x)" } }).html;
    expect(odd).toContain("background:#f0762e");
    expect(odd).not.toContain("url(x)");
  });

  it("is branded by the mailer for the workspace it is sent for", async () => {
    const memory = memoryMailer();
    const lookedUp: string[] = [];
    const mailer = {
      ...memory,
      brand: async (organisationId: string) => {
        lookedUp.push(organisationId);
        return emailBrandOf(branding);
      },
    };
    const email = {
      workspace: "Endless Hall Records",
      subject: "Album masters",
      heading: "Album masters",
      body: [],
      foot: "Foot.",
    };
    await sendEmail(mailer, "ines@example.test", email, "org-1");
    await sendEmail(mailer, "ines@example.test", email);
    expect(lookedUp).toEqual(["org-1"]);
    expect(memory.sent[0]?.html).toContain("api/branding/o/logo/b");
    expect(memory.sent[1]?.html).not.toContain("<img");
  });

  it("is still sent when its branding cannot be read", async () => {
    const memory = memoryMailer();
    const failing = brandedMailer(memory, {} as never, "https://review.example");
    await sendEmail(
      failing,
      "ines@example.test",
      { subject: "S", heading: "H", body: [], foot: "F" },
      "org-1",
    );
    expect(memory.sent).toHaveLength(1);
  });
});
