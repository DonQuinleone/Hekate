import { emailTemplateIds } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { type Email, render, renderText, wrap } from "./render.ts";
import { sampleData, workspaceEmail } from "./templates.ts";

const base = "https://review.endlesshall.example";

describe("email layout", () => {
  it("wraps plain text at 72 characters without breaking a link", () => {
    const url = `${base}/guest/${"x".repeat(80)}`;
    const lines = wrap(`Open this: ${url} and then listen to the whole of the second take.`);
    expect(lines.every((l) => l.length <= 72 || l === url)).toBe(true);
    expect(lines).toContain(url);
  });

  it("sets the plain-text part as text: heading, body, the action, then the foot", () => {
    const email: Email = {
      workspace: "Endless Hall Records",
      subject: "Album masters: your approval is asked",
      heading: "Alex Rivera asks for your approval",
      body: ["Three tracks are ready."],
      action: { label: "Open the review", url: `${base}/reviews/r` },
      foot: "You get this because you were asked to review.",
      settingsUrl: `${base}/account/notifications`,
    };
    expect(renderText(email)).toBe(
      [
        "Endless Hall Records",
        "",
        "Alex Rivera asks for your approval",
        "",
        "Three tracks are ready.",
        "",
        "Open the review:",
        `${base}/reviews/r`,
        "",
        "-- ",
        "You get this because you were asked to review.",
        "",
        "Change what you are told about:",
        `${base}/account/notifications`,
        "",
      ].join("\n"),
    );
  });

  it("escapes what people wrote, and fetches nothing", () => {
    const { html } = render({
      workspace: "Endless <Hall>",
      subject: "s",
      heading: 'Mira said "<script>"',
      body: ["a & b"],
      action: { label: "Open", url: `${base}/reviews/r?a=1&b=2` },
      foot: "f",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("Endless &lt;Hall&gt;");
    expect(html).toContain("a &amp; b");
    expect(html).toContain(`href="${base}/reviews/r?a=1&amp;b=2"`);
    // No images or remote styles: nothing to block and nothing that reports an open.
    expect(html).not.toMatch(/<img|url\(|<link/i);
  });

  it("serves both light and dark clients, and previews either", () => {
    const email: Email = { subject: "s", heading: "h", body: [], foot: "f" };
    const sent = render(email).html;
    expect(sent).toContain('name="color-scheme" content="light dark"');
    expect(sent).toContain("@media (prefers-color-scheme: dark)");
    const dark = render(email, "dark").html;
    expect(dark).not.toContain("@media");
    expect(dark).toContain("background:#0e0e10");
    // The mark is mono on light, its point in the signal colour on dark.
    expect(render(email, "light").html).toMatch(/hk-point" style="[^"]*background:#0a0a0b/);
    expect(dark).toMatch(/hk-point" style="[^"]*background:#f0762e/);
  });
});

describe("templates", () => {
  const samples = sampleData("Endless Hall Records", base);

  for (const id of emailTemplateIds) {
    it(`renders ${id} from its fixture, with one action into the app`, () => {
      const email = workspaceEmail(id, samples[id], {});
      const { subject, text, html } = render(email);
      expect(subject.length).toBeGreaterThan(0);
      expect(subject).not.toMatch(/[{}]/);
      expect(text).toContain(email.heading);
      expect(text).toContain("\n-- \n");
      expect(html.match(/<a /g)?.length).toBe(email.settingsUrl ? 2 : 1);
      expect([...html.matchAll(/href="([^"]+)"/g)].every((m) => m[1]?.startsWith(base))).toBe(true);
    });
  }

  it("takes the workspace's subject lines", () => {
    const email = workspaceEmail("review_requested", samples.review_requested, {
      review_requested: "For {requester}: {review} ({project})",
    });
    expect(email.subject).toBe("For Alex Rivera: Album masters (Joplin Rags)");
    expect(workspaceEmail("review_requested", samples.review_requested, {}).subject).toBe(
      "Album masters: your approval is asked",
    );
  });

  it("tells a guest how long their link lasts", () => {
    const guest = workspaceEmail(
      "review_requested",
      { ...samples.review_requested, guestLinkDays: 14 },
      {},
    );
    expect(guest.foot).toContain("works once, for 14 days");
  });
});
