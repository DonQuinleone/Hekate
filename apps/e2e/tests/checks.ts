import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/**
 * What a reviewer's eye should catch on every screen, checked by the browser instead:
 * text running into other text, lines drawn through text, text cut off without an
 * ellipsis, targets too small for a finger or a pointer, a page wider than the window, a
 * modal that leaves part of the page uncovered, and what axe finds against WCAG 2.2 AA.
 *
 * An element that overlaps on purpose (a label on a waveform, say) says so with
 * `data-e2e-overlap`; it is then left out of the overlap checks, along with its contents.
 * A panel that floats over the page without shutting it off (a side sheet) says so with
 * `data-e2e-layer`: what it covers is out of sight, and its own text is checked against
 * itself, and a target it half covers is not read as crowded. An open menu is treated the same way.
 */

/** The smallest target WCAG 2.2 accepts (2.5.8), in CSS pixels. */
const MIN_TARGET = 24;

export interface LayoutProblem {
  check:
    | "overflow"
    | "text-overlap"
    | "line-through-text"
    | "clipped-text"
    | "small-target"
    | "uncovered-by-modal";
  what: string;
}

export async function layoutProblems(page: Page): Promise<LayoutProblem[]> {
  return page.evaluate((minTarget) => {
    const problems: { check: string; what: string }[] = [];
    const nameOf = (el: Element) => {
      const label =
        el.getAttribute("aria-label") ??
        (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      const cls = typeof el.className === "string" ? el.className.split(" ")[0] : "";
      return `<${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}> "${label}"`;
    };
    const exempt = (el: Element) => el.closest("[data-e2e-overlap]") !== null;
    const shown = (el: Element) => {
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0)
        return false;
      // Text for screen readers only.
      const box = el.getBoundingClientRect();
      if (style.position === "absolute" && box.width <= 1 && box.height <= 1) return false;
      return box.width > 0 && box.height > 0;
    };
    const intersect = (a: DOMRect, b: DOMRect, slack = 1) => {
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      return w > slack && h > slack;
    };

    // A page no wider than its window, and no wider than the app's own scrolling area.
    const root = document.scrollingElement ?? document.documentElement;
    if (root.scrollWidth > window.innerWidth + 1) {
      problems.push({
        check: "overflow",
        what: `The page is ${root.scrollWidth}px wide in a ${window.innerWidth}px window`,
      });
    }
    for (const main of document.querySelectorAll("main")) {
      if (main.scrollWidth > main.clientWidth + 1) {
        problems.push({
          check: "overflow",
          what: `The main area is ${main.scrollWidth}px wide in ${main.clientWidth}px`,
        });
      }
    }

    // A modal shuts off the whole working area: its backdrop (the element it sits in) covers
    // every corner of the main area, rather than the box of whatever it was opened inside. A
    // dialog opened from another (a picker from the composer's sheet) is the one on top.
    const modal = [...document.querySelectorAll("[aria-modal=true]")].at(-1);
    const backdrop = modal?.parentElement;
    if (backdrop) {
      for (const main of document.querySelectorAll("main")) {
        if (backdrop.contains(main) || !shown(main)) continue;
        const r = main.getBoundingClientRect();
        // Inside the pane's rounded corners, which clip hit-testing; the midpoints of the
        // edges besides, since a backdrop the size of a column or a page misses one of them.
        const left = Math.max(r.left, 0) + 24;
        const right = Math.min(r.right, window.innerWidth) - 24;
        const top = Math.max(r.top, 0) + 24;
        const bottom = Math.min(r.bottom, window.innerHeight) - 24;
        const midX = (left + right) / 2;
        const midY = (top + bottom) / 2;
        const points = [
          [left, top],
          [right, top],
          [left, bottom],
          [right, bottom],
          [midX, top - 20],
          [midX, bottom + 20],
          [left - 20, midY],
          [right + 20, midY],
        ] as const;
        for (const [x, y] of points) {
          const hit = document.elementFromPoint(x, y);
          if (hit && backdrop.contains(hit)) continue;
          problems.push({
            check: "uncovered-by-modal",
            what: `${nameOf(modal)} leaves the main area uncovered at ${Math.round(x)},${Math.round(y)}${hit ? `, where ${nameOf(hit)} shows` : ""}`,
          });
          break;
        }
      }
    }

    // Every run of visible text, as the boxes its lines take up. While a modal is open, only
    // its own: the page behind it is out of reach, and the modal lies over it on purpose.
    const layers = [...document.querySelectorAll("[data-e2e-layer]")].filter(shown);
    const layerOf = (el: Element) => el.closest("[data-e2e-layer]");
    // Whether a box outside the layers lies under one of them, out of sight.
    const covered = (el: Element, box: DOMRect) =>
      !layerOf(el) && layers.some((l) => intersect(l.getBoundingClientRect(), box, 0));
    // What shows of a box: cut to every box around it that hides its overflow (an ellipsis, a
    // scrolling list, the page's own scrolling pane), since the hidden part touches nothing.
    const clipped = (el: Element, r: DOMRect) => {
      const clips: DOMRect[] = [];
      for (let a: Element | null = el; a && a !== document.body; a = a.parentElement) {
        const style = getComputedStyle(a);
        if (style.overflowX !== "visible" || style.overflowY !== "visible")
          clips.push(a.getBoundingClientRect());
      }
      return clips.reduce(
        (cut, c) =>
          // Never below nothing: a DOMRect with a negative size turns itself round, and a
          // line cut away by one box would come back at the next.
          new DOMRect(
            Math.max(cut.left, c.left),
            Math.max(cut.top, c.top),
            Math.max(0, Math.min(cut.right, c.right) - Math.max(cut.left, c.left)),
            Math.max(0, Math.min(cut.bottom, c.bottom) - Math.max(cut.top, c.top)),
          ),
        r,
      );
    };
    const texts: { el: Element; rects: DOMRect[] }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const el = node.parentElement;
      if (!el || !shown(el) || el.closest("[aria-hidden=true], svg, option, script, style"))
        continue;
      if (modal && !modal.contains(el)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      // What shows of the text: its lines, cut to every box that hides its overflow.
      const rects = [...range.getClientRects()]
        .map((r) => clipped(el, r))
        .filter((r) => r.width > 1 && r.height > 1 && !covered(el, r));
      if (rects.length) texts.push({ el, rects });
    }

    // Text into text.
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i];
        const b = texts[j];
        if (!a || !b || a.el === b.el || exempt(a.el) || exempt(b.el)) continue;
        if (layerOf(a.el) !== layerOf(b.el)) continue;
        if (a.rects.some((ra) => b.rects.some((rb) => intersect(ra, rb, 2)))) {
          problems.push({
            check: "text-overlap",
            what: `${nameOf(a.el)} runs into ${nameOf(b.el)}`,
          });
        }
      }
    }

    // Lines through text: a thin, painted element over someone else's text.
    for (const el of document.body.querySelectorAll("*")) {
      // Behind an open modal, a line (a player's playhead) lies under it, as its text does.
      if (!shown(el) || exempt(el) || (modal && !modal.contains(el))) continue;
      const box = el.getBoundingClientRect();
      const thin = (box.width <= 2 && box.height >= 6) || (box.height <= 2 && box.width >= 6);
      if (!thin || covered(el, box)) continue;
      // A line scrolled out of its pane crosses nothing.
      const seen = clipped(el, box);
      if (seen.width <= 0 || seen.height <= 0) continue;
      const style = getComputedStyle(el);
      const painted =
        style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent";
      if (!painted) continue;
      const crossed = texts.find(
        (t) =>
          !exempt(t.el) &&
          layerOf(t.el) === layerOf(el) &&
          !el.contains(t.el) &&
          !t.el.contains(el) &&
          t.rects.some((r) => intersect(r, seen, 0.5)),
      );
      if (crossed) {
        problems.push({
          check: "line-through-text",
          what: `${nameOf(el)} crosses ${nameOf(crossed.el)}`,
        });
      }
    }

    // Text cut off without an ellipsis to say so.
    for (const { el } of texts) {
      const style = getComputedStyle(el);
      const hides = style.overflowX === "hidden" || style.overflowX === "clip";
      if (
        hides &&
        el.scrollWidth > el.clientWidth + 1 &&
        style.textOverflow !== "ellipsis" &&
        !style.webkitLineClamp?.match(/\d/)
      ) {
        problems.push({ check: "clipped-text", what: `${nameOf(el)} is cut off` });
      }
    }

    // Whether a target's centre shows: one scrolled out of a box that hides its overflow (the
    // page's scrolling pane) cannot be hit, so it crowds nothing.
    const inView = (el: Element) => {
      const box = el.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const style = getComputedStyle(a);
        if (style.overflowX === "visible" && style.overflowY === "visible") continue;
        const clip = a.getBoundingClientRect();
        if (x < clip.left || x > clip.right || y < clip.top || y > clip.bottom) return false;
      }
      return true;
    };

    // Targets big enough to hit, or far enough apart (WCAG 2.5.8): a smaller target passes
    // when a 24 px circle on its centre touches no other target nor another such circle.
    // Links inside running text are exempt, as WCAG allows.
    const targets = [
      ...document.body.querySelectorAll(
        "a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=link], [role=checkbox], [role=radio], [role=switch], [role=slider]",
      ),
    ]
      .filter((el) => shown(el) && !covered(el, el.getBoundingClientRect()) && inView(el))
      // While a modal is open, only its own targets: the page and the layer that closes the
      // modal when clicked lie behind it.
      .filter((el) => !modal || modal.contains(el))
      .filter((el) => !(el.tagName === "A" && el.parentElement?.closest("p") !== null))
      .map((el) => {
        // A checkbox or radio inside its label takes the label's size.
        const label = el.closest("label");
        const sized = label && (el as HTMLInputElement).type?.match(/checkbox|radio/) ? label : el;
        const box = sized.getBoundingClientRect();
        const small = box.width < minTarget - 0.5 || box.height < minTarget - 0.5;
        // How big a target is goes by its whole box; what a neighbour can reach, by what shows.
        return {
          el,
          box,
          hit: clipped(sized, box),
          small,
          x: box.left + box.width / 2,
          y: box.top + box.height / 2,
        };
      })
      // One target inside another (a button in a link) counts as the outer one.
      .filter((t, _, all) => !all.some((o) => o.el !== t.el && o.el.contains(t.el)));
    const radius = minTarget / 2;
    const circleTouchesBox = (x: number, y: number, box: DOMRect) => {
      const dx = Math.max(box.left - x, 0, x - box.right);
      const dy = Math.max(box.top - y, 0, y - box.bottom);
      return dx * dx + dy * dy < radius * radius - 0.5;
    };
    for (const t of targets) {
      if (!t.small) continue;
      const crowded = targets.find(
        (o) =>
          o !== t &&
          layerOf(o.el) === layerOf(t.el) &&
          (circleTouchesBox(t.x, t.y, o.hit) ||
            (o.small && Math.hypot(o.x - t.x, o.y - t.y) < 2 * radius - 0.5)),
      );
      if (crowded) {
        problems.push({
          check: "small-target",
          what: `${nameOf(t.el)} is ${Math.round(t.box.width)}×${Math.round(t.box.height)}, too close to ${nameOf(crowded.el)}`,
        });
      }
    }

    // One report for each thing, however many lines of text it touches.
    const seen = new Set<string>();
    return problems.filter((p) => {
      const key = `${p.check}:${p.what}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, MIN_TARGET) as Promise<LayoutProblem[]>;
}

/** Axe's WCAG 2.2 AA rules; each violation as one line naming the rule and where. */
export async function accessibilityProblems(page: Page): Promise<string[]> {
  const builder = new AxeBuilder({ page })
    // A sandboxed frame runs no scripts, so axe cannot look inside it; what it shows (an
    // email preview) is not the app's interface and is tested on its own.
    .exclude("iframe[sandbox]")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
  // While a modal is open, only the modal: the page behind it is out of reach, and a target
  // that happens to sit at the modal's edge would read as crowded by it. The page itself is
  // checked on its own screens.
  if ((await page.locator("[aria-modal=true]").count()) > 0) builder.include("[aria-modal=true]");
  const result = await builder.analyze();
  const lines = result.violations.flatMap((v) =>
    v.nodes.map((n) => {
      // What axe found: its reason and the elements it holds against the target, so the log
      // says what to move without a second look.
      const found = [...n.any, ...n.all]
        .map((c) => {
          const data = c.data as { messageKey?: string } | null;
          const related = c.relatedNodes?.map((r) => r.target.join(" ")) ?? [];
          return `${c.id}${data?.messageKey ? ` ${data.messageKey}` : ""}${related.length ? ` with ${related.join(", ")}` : ""}`;
        })
        .join("; ");
      return {
        rule: v.id,
        target: n.target,
        line: `${v.id}: ${n.target.join(" ")} (${v.help}) {${found}}`,
      };
    }),
  );
  // A crowded target is named with what lies over it, so the capture's log says what to move.
  const over = await page.evaluate(
    (targets) =>
      targets.map((selector) => {
        if (!selector) return "";
        const el = document.querySelector(selector);
        if (!el) return "";
        const r = el.getBoundingClientRect();
        const points: [number, number][] = [
          [r.left + 2, r.top + 2],
          [r.right - 2, r.top + 2],
          [r.left + 2, r.bottom - 2],
          [r.right - 2, r.bottom - 2],
          [(r.left + r.right) / 2, (r.top + r.bottom) / 2],
        ];
        const seen = new Set<string>();
        for (const [x, y] of points) {
          for (const hit of document.elementsFromPoint(x, y)) {
            if (hit === el || el.contains(hit)) break;
            const b = hit.getBoundingClientRect();
            seen.add(
              `<${hit.tagName.toLowerCase()} class="${hit.getAttribute("class")?.slice(0, 60) ?? ""}"> at ${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)}`,
            );
          }
        }
        return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}${seen.size ? ` under ${[...seen].join("; ")}` : ""}`;
      }),
    lines.map((l) => (l.rule === "target-size" ? String(l.target[0]) : "")),
  );
  for (const [i, l] of lines.entries()) if (over[i]) l.line += ` [${over[i]}]`;
  // An open menu or a floating layer lies over the page on purpose, as a modal does: a target it
  // half covers would read as crowded by it. Those are checked on the screens where it is shut.
  const covered = await page.evaluate(
    (targets) => {
      const menus = [...document.querySelectorAll("[role=menu], [data-e2e-layer]")].map((m) =>
        m.getBoundingClientRect(),
      );
      return targets.map((selector) => {
        if (!selector) return false;
        const el = document.querySelector(selector);
        if (!el || el.closest("[role=menu], [data-e2e-layer]")) return false;
        const r = el.getBoundingClientRect();
        return menus.some(
          (m) => r.left < m.right && r.right > m.left && r.top < m.bottom && r.bottom > m.top,
        );
      });
    },
    lines.map((l) => (l.rule === "target-size" ? String(l.target[0]) : "")),
  );
  return lines.filter((_, i) => !covered[i]).map((l) => l.line);
}

/** Both kinds of check, failing softly so one capture shows every problem at once. */
export async function checkScreen(page: Page) {
  expect.soft(await layoutProblems(page), "layout").toEqual([]);
  expect.soft(await accessibilityProblems(page), "accessibility").toEqual([]);
}
