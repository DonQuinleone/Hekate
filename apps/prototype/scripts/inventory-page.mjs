// Renders docs/inventory.md as a dark, commentable page (artifact/inventory.html) for review.
// A deliberately small markdown subset: headings, paragraphs, bullet lists, numbered lists,
// tables, bold, italic and code.
import { mkdir, readFile, writeFile } from "node:fs/promises";

const src = await readFile(new URL("../docs/inventory.md", import.meta.url), "utf8");

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/#(\d+)/g, '<a href="https://github.com/DonQuinleone/Hekate/issues/$1">#$1</a>');

const lines = src.split("\n");
const out = [];
let i = 0;
let title = "Screen inventory";
const slug = (t) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
const toc = [];
while (i < lines.length) {
  const line = lines[i];
  if (line.startsWith("# ")) {
    title = line.slice(2);
    out.push(`<h1>${inline(title)}</h1>`);
    i++;
  } else if (line.startsWith("## ")) {
    const t = line.slice(3);
    toc.push({ level: 2, t, id: slug(t) });
    out.push(`<h2 id="${slug(t)}">${inline(t)}</h2>`);
    i++;
  } else if (line.startsWith("### ")) {
    const t = line.slice(4);
    toc.push({ level: 3, t, id: slug(t) });
    out.push(`<h3 id="${slug(t)}">${inline(t)}</h3>`);
    i++;
  } else if (line.startsWith("|")) {
    const rows = [];
    while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
    const cells = (r) =>
      r
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
    const head = cells(rows[0]);
    const body = rows.slice(2).map(cells);
    out.push(
      `<div class="table"><table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>${body
        .map((r) => `<tr>${r.map((c, k) => `<td class="c${k}">${inline(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table></div>`,
    );
  } else if (/^- /.test(line)) {
    const items = [];
    while (i < lines.length && /^- /.test(lines[i])) items.push(lines[i++].slice(2));
    out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</ul>`);
  } else if (/^\d+\. /.test(line)) {
    const items = [];
    while (i < lines.length && /^\d+\. /.test(lines[i]))
      items.push(lines[i++].replace(/^\d+\. /, ""));
    out.push(`<ol>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</ol>`);
  } else if (line.trim() === "") {
    i++;
  } else {
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(#|\||- |\d+\. )/.test(lines[i]))
      para.push(lines[i++]);
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
}

const nav = `<nav class="toc" aria-label="Contents"><ol>${toc
  .map((t) => `<li class="l${t.level}"><a href="#${t.id}">${esc(t.t)}</a></li>`)
  .join("")}</ol></nav>`;

const page = `<title>Hekate screen inventory</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500&family=DM+Mono:wght@400;500&display=swap">
<style>
/* Layout: one reading column with a contents rail on wide screens; the brand's dark Signal tokens. */
:root { --ground:#0a0a0b; --surface:#111113; --raised:#18181b; --hairline:#222226; --hairline-soft:#1c1c20; --edge:#2e2e33; --ink:#f4f4f5; --ink-2:#a1a1aa; --ink-3:#80808b; --signal:#f0762e; --sans:"Schibsted Grotesk","Helvetica Neue",Arial,sans-serif; --mono:"DM Mono","SF Mono",Menlo,monospace; color-scheme: dark; }
html { background: var(--ground); }
body { margin:0; background:var(--ground); color:var(--ink); font-family:var(--sans); font-size:14px; line-height:22px; -webkit-font-smoothing:antialiased; padding-block: 32px 80px; padding-left:max(16px, env(safe-area-inset-left, 0px)); padding-right:max(16px, env(safe-area-inset-right, 0px)); }
.wrap { max-width: 1180px; margin: 0 auto; display:grid; grid-template-columns: minmax(0,1fr); gap: 32px; }
@media (min-width: 1000px) { .wrap { grid-template-columns: 220px minmax(0,1fr); } .toc { position: sticky; top: 24px; align-self: start; } }
main { min-width: 0; }
h1 { font-size: 28px; line-height: 34px; font-weight: 500; letter-spacing: -0.02em; margin: 0 0 12px; text-wrap: balance; }
h2 { font-size: 20px; line-height: 28px; font-weight: 500; letter-spacing: -0.015em; margin: 44px 0 10px; padding-top: 20px; border-top: 1px solid var(--hairline); }
h3 { font-size: 15px; line-height: 22px; font-weight: 500; margin: 28px 0 8px; }
p { margin: 0 0 12px; max-width: 72ch; color: var(--ink-2); }
h1 + p { color: var(--ink-2); font-size: 15px; }
ul, ol { margin: 0 0 12px; padding-left: 22px; color: var(--ink-2); max-width: 78ch; }
li { margin: 4px 0; }
li::marker { color: var(--ink-3); }
strong { color: var(--ink); font-weight: 500; }
em { font-style: italic; color: var(--ink); }
code { font-family: var(--mono); font-size: 12px; color: var(--ink); background: var(--raised); padding: 1px 5px; border-radius: 4px; }
a { color: var(--ink); text-decoration: none; border-bottom: 1px solid var(--edge); }
a:hover { color: var(--signal); border-color: var(--signal); }
.table { overflow-x: auto; margin: 0 0 16px; border: 1px solid var(--hairline); border-radius: 8px; background: var(--surface); box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.04); }
table { border-collapse: collapse; width: 100%; font-size: 13px; line-height: 19px; }
th { text-align: left; font-family: var(--mono); font-size: 11px; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); padding: 10px 12px; border-bottom: 1px solid var(--hairline); white-space: nowrap; }
td { padding: 9px 12px; vertical-align: top; border-bottom: 1px solid var(--hairline-soft); color: var(--ink-2); }
tr:last-child td { border-bottom: 0; }
td.c0 { color: var(--ink); font-weight: 500; white-space: nowrap; }
td.c1 { min-width: 260px; }
td.c2 { min-width: 200px; }
td.c3 { font-family: var(--mono); font-size: 11px; white-space: nowrap; color: var(--ink-3); }
td a { border-bottom: 0; color: var(--ink-3); }
td a:hover { color: var(--signal); }
.toc ol { list-style: none; padding: 0; margin: 0; font-size: 12px; line-height: 18px; }
.toc li { margin: 0; }
.toc li.l2 { margin-top: 10px; }
.toc li.l2 a { color: var(--ink); font-weight: 500; }
.toc li.l3 { padding-left: 12px; }
.toc a { border: 0; color: var(--ink-3); display: block; padding: 2px 0; }
.toc a:hover { color: var(--signal); }
.meta { font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 20px; }
@media (prefers-reduced-motion: no-preference) { html { scroll-behavior: smooth; } }
</style>
<div class="wrap">
${nav}
<main>
<div class="meta">Hekate · prototype · for approval</div>
${out.join("\n")}
</main>
</div>
`;
const dir = new URL("../artifact/", import.meta.url);
await mkdir(dir, { recursive: true });
await writeFile(new URL("inventory.html", dir), page);
console.log("artifact/inventory.html written");
