// Folds the built page into one file for publishing as a claude.ai artifact: the artifact
// service wraps the page in its own document skeleton, so this keeps only what goes inside
// it (title, font links, styles and the script), with the stylesheet and script inlined.
import { mkdir, readFile, writeFile } from "node:fs/promises";

const dist = new URL("../dist/", import.meta.url);
const html = await readFile(new URL("index.html", dist), "utf8");

const out = [];
for (const tag of html.matchAll(
  /<title>[^<]*<\/title[^>]*>|<link[^>]*>|<script[^>]*><\/script[^>]*>/gi,
)) {
  const text = tag[0];
  const local = text.match(/(?:href|src)="\.\/([^"]+)"/)?.[1];
  if (/^<title/i.test(text)) out.push(text);
  else if (/rel="stylesheet"/.test(text) && local) {
    const css = await readFile(new URL(local, dist), "utf8");
    out.push(`<style>${css.replaceAll("</style", "<\\/style")}</style>`);
  } else if (/^<script/i.test(text) && local) {
    const js = await readFile(new URL(local, dist), "utf8");
    out.push(`<script type="module">${js.replaceAll("</script", "<\\/script")}</script>`);
  } else if (/rel="(preconnect|stylesheet)"/.test(text)) out.push(text.replace(/\s+/g, " "));
  // The icon and any preloads are left out: the artifact has its own icon, and the files are inline.
}

const dir = new URL("../artifact/", import.meta.url);
await mkdir(dir, { recursive: true });
await writeFile(
  new URL("index.html", dir),
  `${out.join("\n")}\n<meta name="claude:viewport-fit-sides" content="cover">\n<div id="root"></div>\n`,
);
console.log("artifact/index.html written");
