// Folds the built page into one file for publishing as a claude.ai artifact: the artifact
// service wraps the page in its own document skeleton, so this keeps only what goes inside
// it (title, font links, styles and the script), with the stylesheet and script inlined.
import { mkdir, readFile, writeFile } from "node:fs/promises";

const dist = new URL("../dist/", import.meta.url);
const html = await readFile(new URL("index.html", dist), "utf8");

const out = [];
// Only Vite's own output is read, so opening tags are enough (a script's source is in its src),
// taken in document order and told apart by name.
const title = html.match(/<title>[^<]*<\/title>/)?.[0];
for (const tag of html.matchAll(/<([a-z]+)\b[^>]*>/gi)) {
  const text = tag[0];
  const name = tag[1]?.toLowerCase();
  const local = text.match(/(?:href|src)="\.\/([^"]+)"/)?.[1];
  if (name === "title" && title) out.push(title);
  if (name !== "link" && name !== "script") continue;
  if (name === "link" && /rel="stylesheet"/.test(text) && local) {
    const css = await readFile(new URL(local, dist), "utf8");
    out.push(`<style>${css.replaceAll("</style", "<\\/style")}</style>`);
  } else if (name === "script" && local) {
    const js = await readFile(new URL(local, dist), "utf8");
    out.push(`<script type="module">${js.replaceAll("</script", "<\\/script")}</script>`);
  } else if (name === "link" && /rel="(preconnect|stylesheet)"/.test(text))
    out.push(text.replace(/\s+/g, " "));
  // The icon and any preloads are left out: the artifact has its own icon, and the files are inline.
}

const dir = new URL("../artifact/", import.meta.url);
await mkdir(dir, { recursive: true });
await writeFile(
  new URL("index.html", dir),
  `${out.join("\n")}\n<meta name="claude:viewport-fit-sides" content="cover">\n<div id="root"></div>\n`,
);
console.log("artifact/index.html written");
