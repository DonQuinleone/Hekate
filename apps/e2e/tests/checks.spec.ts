import { expect, test } from "@playwright/test";
import { accessibilityProblems, layoutProblems } from "./checks.ts";

/** The checks themselves: each finds what it is for, and leaves sound layouts alone. */

const page = (body: string) => `<!doctype html><html lang="en"><head><title>Check</title>
<style>body { margin: 0; font: 14px/20px sans-serif; background: #111; color: #eee }</style>
</head><body><main>${body}</main></body></html>`;

test("finds text running into text, and lines through it", async ({ page: p }) => {
  await p.setContent(
    page(`<div style="position:relative;height:40px">
      <span style="position:absolute;left:0;top:0">Bar 12</span>
      <span style="position:absolute;left:10px;top:4px">Bar 13</span>
      <div style="position:absolute;left:20px;top:0;width:1px;height:30px;background:#888"></div>
    </div>
    <div data-e2e-overlap style="position:relative;height:40px">
      <span style="position:absolute;left:0;top:0">Meant</span>
      <span style="position:absolute;left:5px;top:0">to overlap</span>
    </div>`),
  );
  const found = (await layoutProblems(p)).map((x) => x.check);
  expect(found.filter((c) => c === "text-overlap")).toHaveLength(1);
  expect(found).toContain("line-through-text");
});

test("leaves text cut off by an ellipsis alone, but not text cut off without one", async ({
  page: p,
}) => {
  await p.setContent(
    page(`<p style="width:60px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">A long file name.wav</p>
    <span style="display:block;width:60px;overflow:hidden;white-space:nowrap">Another long name</span>
    <span>Beside it</span>`),
  );
  const problems = await layoutProblems(p);
  expect(problems.map((x) => x.check)).toEqual(["clipped-text"]);
  expect(problems[0]?.what).toContain("Another long name");
});

test("finds crowded small targets, a page wider than the window and axe's findings", async ({
  page: p,
}) => {
  await p.setContent(
    page(`<button style="width:16px;height:16px;padding:0">a</button><button style="width:16px;height:16px;padding:0">b</button>
    <div style="margin-top:40px"><button style="width:16px;height:16px;padding:0">alone</button></div>
    <div style="width:5000px;height:4px"></div>
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="10" height="10">`),
  );
  const problems = await layoutProblems(p);
  expect(problems.filter((x) => x.check === "small-target")).toHaveLength(2);
  expect(problems.map((x) => x.check)).toContain("overflow");
  expect((await accessibilityProblems(p)).join("\n")).toContain("image-alt");
});

test("finds the main area scrolling sideways inside a window that does not", async ({
  page: p,
}) => {
  await p.setContent(`<!doctype html><html lang="en"><head><title>Check</title></head>
    <body style="margin:0;height:100vh;display:flex"><main style="flex:1;min-width:0;overflow:auto">
    <div style="width:4000px;height:10px"></div></main></body></html>`);
  const problems = await layoutProblems(p);
  expect(problems).toEqual([expect.objectContaining({ check: "overflow" })]);
});
