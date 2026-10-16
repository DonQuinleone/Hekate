import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/**
 * What a reviewer's eye should catch on every screen, checked by the browser instead:
 * text running into other text, lines drawn through text, text cut off without an
 * ellipsis, targets too small for a finger or a pointer, a page wider than the window,
 * and what axe finds against WCAG 2.2 AA.
 *
 * An element that overlaps on purpose (a label on a waveform, say) says so with
 * `data-e2e-overlap`; it is then left out of the overlap checks, along with its contents.
 * A panel that floats over the page without shutting it off (a side sheet) says so with
 * `data-e2e-layer`: what it covers is out of sight, and its own text is checked against
 * itself.
 */

/** The smallest target WCAG 2.2 accepts (2.5.8), in CSS pixels. */
const MIN_TARGET = 24;

export interface LayoutProblem {
  check: "overflow" | "text-overlap" | "line-through-text" | "clipped-text" | "small-target";
  what: string;
}

export async function layoutProblems(page: Page): Promise<LayoutProblem[]> {
  return page.evaluate((minTarget) => {
    const problems: { check: string; what: string }[] = [];
    const describe = (el: Element) => {
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

    // Every run of visible text, as the boxes its lines take up. While a modal is open, only
    // its own: the page behind it is out of reach, and the modal lies over it on purpose.
    const modal = document.querySelector("[aria-modal=true]");
    const layers = [...document.querySelectorAll("[data-e2e-layer]")].filter(shown);
    const layerOf = (el: Element) => el.closest("[data-e2e-layer]");
    // Whether a box outside the layers lies under one of them, out of sight.
    const covered = (el: Element, box: DOMRect) =>
      !layerOf(el) && layers.some((l) => intersect(l.getBoundingClientRect(), box, 0));
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
      // What shows of the text: its lines, cut to every box that hides its overflow (an
      // ellipsis, a scrolling list), since the hidden part cannot run into anything.
      const clips: DOMRect[] = [];
      for (let a: Element | null = el; a && a !== document.body; a = a.parentElement) {
        const style = getComputedStyle(a);
        if (style.overflowX !== "visible" || style.overflowY !== "visible")
          clips.push(a.getBoundingClientRect());
      }
      const rects = [...range.getClientRects()]
        .map((r) =>
          clips.reduce(
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
          ),
        )
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
            what: `${describe(a.el)} runs into ${describe(b.el)}`,
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
          t.rects.some((r) => intersect(r, box, 0.5)),
      );
      if (crossed) {
        problems.push({
          check: "line-through-text",
          what: `${describe(el)} crosses ${describe(crossed.el)}`,
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
        problems.push({ check: "clipped-text", what: `${describe(el)} is cut off` });
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
        const box = (
          label && (el as HTMLInputElement).type?.match(/checkbox|radio/) ? label : el
        ).getBoundingClientRect();
        const small = box.width < minTarget - 0.5 || box.height < minTarget - 0.5;
        return { el, box, small, x: box.left + box.width / 2, y: box.top + box.height / 2 };
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
          (circleTouchesBox(t.x, t.y, o.box) ||
            (o.small && Math.hypot(o.x - t.x, o.y - t.y) < 2 * radius - 0.5)),
      );
      if (crowded) {
        problems.push({
          check: "small-target",
          what: `${describe(t.el)} is ${Math.round(t.box.width)}×${Math.round(t.box.height)}, too close to ${describe(crowded.el)}`,
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
  const result = await new AxeBuilder({ page })
    // A sandboxed frame runs no scripts, so axe cannot look inside it; what it shows (an
    // email preview) is not the app's interface and is tested on its own.
    .exclude("iframe[sandbox]")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  return result.violations.flatMap((v) =>
    v.nodes.map((n) => `${v.id}: ${n.target.join(" ")} (${v.help})`),
  );
}

/** Both kinds of check, failing softly so one capture shows every problem at once. */
export async function checkScreen(page: Page) {
  expect.soft(await layoutProblems(page), "layout").toEqual([]);
  expect.soft(await accessibilityProblems(page), "accessibility").toEqual([]);
}
