/**
 * Every message Hekate sends has one shape (who did what, one action, a line about why you got
 * it) and goes as a multipart mail: a plain-text part written to be read as it is, and an HTML
 * part laid out in tables for light and dark mail clients. No tracking: the mark is drawn in
 * table cells and every link goes to the app. The one image is a workspace's own logo (#185),
 * at one public address for every reader, so loading it says nothing about who opened what.
 */
import { logoBox } from "@hekate/shared";

/** A workspace's branding as its mail shows it (#185, decision 226). */
export interface EmailBrand {
  /** Its logo, at an absolute address, in place of Hekate's lockup at the top. */
  logo?: { url: string; width: number; height: number };
  /** Its accent, legible on the dark ground, for the action in place of the signal. */
  accent?: string;
}

export interface Email {
  /** The workspace it comes from, at the top and in the foot; none for a message about an account. */
  workspace?: string;
  /** The subject line, also the HTML title. */
  subject: string;
  /** Who did what, as one sentence. */
  heading: string;
  /** What to know, a paragraph each. Quoted words from a person may run to several lines. */
  body: string[];
  /** Items listed under the body, such as the updates in a digest. */
  list?: string[];
  /** The one thing to do. */
  action?: { label: string; url: string };
  /** Why this came, and how to change it. */
  foot: string;
  /** Where to change what reaches you, when the reader is a member. */
  settingsUrl?: string;
  /** The workspace's logo and accent, where it has set them. */
  brand?: EmailBrand;
}

export interface Rendered {
  subject: string;
  text: string;
  html: string;
}

type Scheme = "light" | "dark";

const palettes: Record<
  Scheme,
  {
    outer: string;
    card: string;
    border: string;
    ink: string;
    ink2: string;
    ink3: string;
    stem: string;
    point: string;
  }
> = {
  light: {
    outer: "#f4f4f2",
    card: "#e9e8e3",
    border: "#d6d5cf",
    ink: "#0a0a0b",
    ink2: "#3b3b3e",
    ink3: "#5e5e62",
    stem: "#0a0a0b",
    // The mark is mono on light.
    point: "#0a0a0b",
  },
  dark: {
    outer: "#050506",
    card: "#0e0e10",
    border: "#1f1f23",
    ink: "#f4f4f5",
    ink2: "#a1a1aa",
    ink3: "#8a8a94",
    stem: "#f4f4f5",
    point: "#f0762e",
  },
};
const SIGNAL = "#f0762e";
const ON_SIGNAL = "#0a0a0b";
const WIDTH = 72;

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** Lines of at most 72 characters, broken at spaces; a word longer than that (a link) stands alone. */
export function wrap(paragraph: string, width = WIDTH, indent = ""): string[] {
  const lines: string[] = [];
  for (const source of paragraph.split("\n")) {
    let line = "";
    for (const word of source.split(/\s+/).filter(Boolean)) {
      if (line && (indent + line).length + 1 + word.length > width) {
        lines.push(indent + line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(indent + line);
  }
  return lines;
}

/** The plain-text part: the same message, set as text rather than squeezed out of HTML. */
export function renderText(email: Email): string {
  const blocks: string[][] = [
    ...(email.workspace ? [[email.workspace]] : []),
    wrap(email.heading),
    ...email.body.map((p) => wrap(p)),
  ];
  if (email.list?.length) blocks.push(email.list.flatMap((item) => wrap(`- ${item}`, WIDTH)));
  if (email.action) blocks.push([`${email.action.label}:`, email.action.url]);
  const foot = [
    ...wrap(email.foot),
    ...(email.settingsUrl ? ["", "Change what you are told about:", email.settingsUrl] : []),
  ];
  // "-- " starts the signature, so mail programs can tell the foot from the message.
  return `${blocks.map((b) => b.join("\n")).join("\n\n")}\n\n-- \n${foot.join("\n")}\n`;
}

/** Two stems and a point, as table cells: no image to block or fetch. */
function mark(p: (typeof palettes)[Scheme]) {
  const stem = `<td class="hk-stem" width="3" height="18" style="width:3px;height:18px;background:${p.stem};font-size:0;line-height:0">&nbsp;</td>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" aria-hidden="true"><tr>${stem}<td width="7" align="center" valign="middle" style="width:7px"><div class="hk-point" style="width:4px;height:4px;margin:0 auto;border-radius:2px;background:${p.point};font-size:0;line-height:0">&nbsp;</div></td>${stem}</tr></table>`;
}

/**
 * The top of the card: Hekate's lockup and the workspace's name, or the workspace's own logo
 * where it has one (#185), named for those whose client holds images back. The foot still says
 * Hekate sent it.
 */
function header(email: Email, p: (typeof palettes)[Scheme]) {
  const logo = email.brand?.logo;
  if (logo) {
    const box = logoBox(logo, 32, 200);
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="middle"><img src="${escapeHtml(logo.url)}" width="${box.width}" height="${box.height}" alt="${escapeHtml(email.workspace ?? "")}" style="display:block;border:0;outline:none;text-decoration:none;width:${box.width}px;height:${box.height}px;max-width:100%;font-size:15px;font-weight:600;color:${p.ink}"></td>
</tr></table>`;
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="20" valign="middle">${mark(p)}</td>
<td class="hk-ink" valign="middle" style="padding-left:8px;font-size:15px;font-weight:600;color:${p.ink}">Hekate</td>
<td class="hk-ink3" align="right" valign="middle" style="font-size:13px;color:${p.ink3}">${escapeHtml(email.workspace ?? "")}</td>
</tr></table>`;
}

/**
 * The HTML part. Light colours are inline; dark clients get theirs from a media query. A
 * preview asks for one scheme and gets it inline, without the query, whatever its viewer's own.
 */
export function renderHtml(email: Email, preview?: Scheme): string {
  const p = palettes[preview ?? "light"];
  const dark = palettes.dark;
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
  const paragraph = (text: string) =>
    `<p class="hk-ink2" style="margin:12px 0 0;font-size:15px;line-height:23px;color:${p.ink2}">${escapeHtml(text).replaceAll("\n", "<br>")}</p>`;
  const list = email.list?.length
    ? `<ul class="hk-ink2" style="margin:12px 0 0;padding:0 0 0 18px;font-size:14px;line-height:22px;color:${p.ink2}">${email.list.map((i) => `<li style="margin:0 0 4px">${escapeHtml(i)}</li>`).join("")}</ul>`
    : "";
  // The accent was checked for contrast when it was set; anything else here is ignored.
  const signal =
    email.brand?.accent && /^#[0-9a-f]{6}$/i.test(email.brand.accent) ? email.brand.accent : SIGNAL;
  const action = email.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0"><tr><td style="border-radius:8px;background:${signal}"><a href="${escapeHtml(email.action.url)}" style="display:inline-block;padding:11px 18px;font-family:${font};font-size:15px;font-weight:600;line-height:18px;color:${ON_SIGNAL};text-decoration:none;border-radius:8px">${escapeHtml(email.action.label)}</a></td></tr></table>`
    : "";
  const settings = email.settingsUrl
    ? ` · <a class="hk-ink3" href="${escapeHtml(email.settingsUrl)}" style="color:${p.ink3};text-decoration:underline">Change what you are told about</a>`
    : "";
  const darkStyles = preview
    ? ""
    : `<style>
@media (prefers-color-scheme: dark) {
  .hk-outer { background: ${dark.outer} !important; }
  .hk-card { background: ${dark.card} !important; border-color: ${dark.border} !important; }
  .hk-ink { color: ${dark.ink} !important; }
  .hk-ink2 { color: ${dark.ink2} !important; }
  .hk-ink3 { color: ${dark.ink3} !important; }
  .hk-rule { border-color: ${dark.border} !important; }
  .hk-stem { background: ${dark.stem} !important; }
  .hk-point { background: ${dark.point} !important; }
}
</style>`;
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(email.subject)}</title>
${darkStyles}
</head>
<body class="hk-outer" style="margin:0;padding:0;background:${p.outer}">
<table role="presentation" class="hk-outer" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${p.outer}">
<tr><td align="center" style="padding:32px 12px">
<table role="presentation" class="hk-card" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:${p.card};border:1px solid ${p.border};border-radius:12px;font-family:${font}">
<tr><td style="padding:28px 28px 0">
${header(email, p)}
</td></tr>
<tr><td style="padding:24px 28px 28px">
<h1 class="hk-ink" style="margin:0;font-size:21px;line-height:27px;font-weight:600;color:${p.ink}">${escapeHtml(email.heading)}</h1>
${email.body.map(paragraph).join("\n")}
${list}
${action}
<p class="hk-ink3" style="margin:24px 0 0;font-size:13px;line-height:19px;color:${p.ink3}">${escapeHtml(email.foot)}</p>
</td></tr>
<tr><td class="hk-ink3 hk-rule" style="padding:16px 28px;border-top:1px solid ${p.border};font-size:12px;line-height:18px;color:${p.ink3}">Sent by Hekate${email.workspace ? ` for ${escapeHtml(email.workspace)}` : ""}${settings}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
}

export function render(email: Email, preview?: Scheme): Rendered {
  return { subject: email.subject, text: renderText(email), html: renderHtml(email, preview) };
}
