import {
  type PatchedChannel,
  roundKinds,
  type StageItem,
  type StagePlan,
  shownLabel,
} from "@hekate/shared";
import { pdfString, widthOf } from "./media/helvetica.ts";
import { fitted } from "./patch-pdf.ts";

/**
 * A stage plan as it is printed for the get-in (#53): landscape A3 or A4, the stage to a
 * standard scale (the largest of 1:20 to 1:500 that fits), with metre rulers along the back and
 * the side, a scale bar, and each item drawn as the plan draws it, in vectors and Helvetica.
 * The audience is at the foot of the page, as on screen.
 */

export const STAGE_PAPER = {
  a3: { width: 1190.55, height: 841.89 },
  a4: { width: 841.89, height: 595.28 },
} as const;
export type StagePaper = keyof typeof STAGE_PAPER;

const MARGIN = 36;
const HEADER = 44;
const FOOTER = 34;
/** Room for the rulers' numbers, left of and above the stage. */
const RULER = 18;
const SCALES = [20, 25, 50, 75, 100, 200, 250, 500] as const;
/** Points a metre at 1:n. */
const pointsAt = (n: number) => ((1000 / n) * 72) / 25.4;

const num = (n: number) => String(Math.round(n * 100) / 100);
const text = (font: "H" | "HB", size: number, x: number, y: number, words: string, grey = 0) =>
  `BT /${font} ${num(size)} Tf ${grey} g ${num(x)} ${num(y)} Td ${pdfString(words)} Tj ET`;
const centred = (size: number, x: number, y: number, words: string, grey = 0) =>
  text("H", size, x - widthOf(words, size) / 2, y, words, grey);

/** The largest standard scale at which a stage fits the room, or the room's own when none does. */
export function printScale(
  width: number,
  depth: number,
  room: { width: number; height: number },
): { ratio: number | null; perMetre: number } {
  for (const n of SCALES) {
    const s = pointsAt(n);
    if (width * s <= room.width && depth * s <= room.height) return { ratio: n, perMetre: s };
  }
  return { ratio: null, perMetre: Math.min(room.width / width, room.height / depth) };
}

/** An ellipse about (0, 0), in four curves. */
function ellipse(rx: number, ry: number): string {
  const kx = 0.5523 * rx;
  const ky = 0.5523 * ry;
  return [
    `${num(rx)} 0 m`,
    `${num(rx)} ${num(ky)} ${num(kx)} ${num(ry)} 0 ${num(ry)} c`,
    `${num(-kx)} ${num(ry)} ${num(-rx)} ${num(ky)} ${num(-rx)} 0 c`,
    `${num(-rx)} ${num(-ky)} ${num(-kx)} ${num(-ry)} 0 ${num(-ry)} c`,
    `${num(kx)} ${num(-ry)} ${num(rx)} ${num(-ky)} ${num(rx)} 0 c`,
  ].join(" ");
}

/** Turned clockwise as the screen turns it, about the origin, in a page whose y runs up. */
function turned(degrees: number): string {
  if (!degrees) return "";
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return `${num(c)} ${num(-s)} ${num(s)} ${num(c)} 0 0 cm `;
}

/** The page's drawing for a plan, on the paper chosen, with the labels of hidden groups left off. */
export function stagePlanPage(
  project: string,
  plan: StagePlan,
  channels: PatchedChannel[],
  paper: StagePaper,
  hidden: string[] = [],
): { points: { width: number; height: number }; content: string } {
  const page = STAGE_PAPER[paper];
  const room = {
    width: page.width - 2 * MARGIN - RULER,
    height: page.height - 2 * MARGIN - HEADER - FOOTER - RULER,
  };
  const { ratio, perMetre: s } = printScale(plan.width, plan.depth, room);
  const stageW = plan.width * s;
  const stageH = plan.depth * s;
  // The stage centred in the room; its back edge at the top.
  const left = MARGIN + RULER + (room.width - stageW) / 2;
  const top = page.height - MARGIN - HEADER - RULER - (room.height - stageH) / 2;
  const X = (m: number) => left + m * s;
  const Y = (m: number) => top - m * s;
  const ops: string[] = [];

  // Title, and what the page is.
  const scaleWords = ratio ? `1:${ratio} on ${paper.toUpperCase()}` : "not to a standard scale";
  ops.push(
    text(
      "HB",
      15,
      MARGIN,
      page.height - MARGIN - 12,
      fitted(`${project} · ${plan.name}`, page.width - 2 * MARGIN, 15, true),
    ),
    text(
      "H",
      9,
      MARGIN,
      page.height - MARGIN - 27,
      `Stage plan, ${num(plan.width)} × ${num(plan.depth)} m, ${scaleWords}`,
      0.4,
    ),
  );

  // The grid, then the stage's edge, then the rulers.
  ops.push("0.88 G 0.3 w");
  for (let m = plan.grid; m < plan.width - 1e-6; m += plan.grid)
    ops.push(`${num(X(m))} ${num(Y(0))} m ${num(X(m))} ${num(Y(plan.depth))} l S`);
  for (let m = plan.grid; m < plan.depth - 1e-6; m += plan.grid)
    ops.push(`${num(X(0))} ${num(Y(m))} m ${num(X(plan.width))} ${num(Y(m))} l S`);
  ops.push(`0.2 G 0.8 w ${num(left)} ${num(Y(plan.depth))} ${num(stageW)} ${num(stageH)} re S`);
  // A number every metre, or every few where metres are close together.
  const every = s >= 18 ? 1 : s >= 8 ? 2 : 5;
  ops.push("0.3 G 0.5 w");
  for (let m = 0; m <= plan.width + 1e-6; m += every) {
    ops.push(`${num(X(m))} ${num(Y(0))} m ${num(X(m))} ${num(Y(0) + 4)} l S`);
    ops.push(centred(7, X(m), Y(0) + 7, `${m}`, 0.4));
  }
  for (let m = 0; m <= plan.depth + 1e-6; m += every) {
    ops.push(`${num(left)} ${num(Y(m))} m ${num(left - 4)} ${num(Y(m))} l S`);
    ops.push(text("H", 7, left - 6 - widthOf(`${m}`, 7), Y(m) - 2.5, `${m}`, 0.4));
  }

  // What stands on the stage, in the order it was put down.
  const channelOf = (i: StageItem) =>
    i.patchRowId ? channels.find((c) => c.id === i.patchRowId) : undefined;
  for (const item of plan.items) {
    const label = hidden.includes(item.group) ? null : shownLabel(item, channelOf(item));
    ops.push(drawn(item, label, channelOf(item), X, Y, s));
  }

  // The scale bar: five metres, or what fits, in alternate blocks.
  const barMetres = [10, 5, 2, 1].find((m) => m * s <= 200 && m <= plan.width) ?? 1;
  const barY = MARGIN + 8;
  for (let m = 0; m < barMetres; m++) {
    ops.push(
      `${m % 2 ? "1" : "0.2"} g 0.2 G 0.5 w ${num(MARGIN + m * s)} ${barY} ${num(s)} 4 re B`,
    );
  }
  ops.push(
    centred(7, MARGIN, barY + 8, "0", 0.3),
    centred(7, MARGIN + barMetres * s, barY + 8, `${barMetres} m`, 0.3),
    text("H", 7, MARGIN, barY - 9, ratio ? `Scale 1:${ratio}` : "Scale as drawn", 0.4),
  );
  ops.push(centred(8, X(plan.width / 2), Y(plan.depth) - 14, "Audience", 0.45));
  return { points: page, content: ops.join("\n") };
}

/** One item, drawn as the plan draws its kind, in print's greys. */
function drawn(
  item: StageItem,
  label: string | null,
  channel: PatchedChannel | undefined,
  X: (m: number) => number,
  Y: (m: number) => number,
  s: number,
): string {
  const ops: string[] = [];
  const size = 7;
  const words = (x: number, y: number, centre = true) => {
    if (label === null) return;
    const fit = fitted(label, Math.max(4 * s, 60), size);
    ops.push(centre ? centred(size, x, y, fit, 0.15) : text("H", size, x, y, fit, 0.15));
  };
  if (item.kind === "mic") {
    const x = X(item.x);
    const y = Y(item.y);
    ops.push(`q 1 g 0.15 G 0.7 w 1 0 0 1 ${num(x)} ${num(y)} cm ${ellipse(4, 4)} B Q`);
    ops.push(`q 0.15 g 1 0 0 1 ${num(x)} ${num(y)} cm ${ellipse(1.4, 1.4)} f Q`);
    words(x + 6, y - 2.5, false);
    if (channel && label !== null)
      ops.push(
        text(
          "H",
          6,
          x + 6,
          y - 9.5,
          `${channel.box}, ${channel.direction === "input" ? "in" : "out"} ${channel.channel}`,
          0.5,
        ),
      );
    return ops.join("\n");
  }
  if (item.kind === "cable") {
    ops.push(
      `0.35 G 1 w [4 2] 0 d ${num(X(item.x))} ${num(Y(item.y))} m ${num(X(item.x + item.w))} ${num(Y(item.y + item.h))} l S [] 0 d`,
    );
    words(X(item.x + item.w / 2), Y(item.y + item.h / 2) + 3);
    return ops.join("\n");
  }
  const w = Math.abs(item.w) * s;
  const h = Math.abs(item.h) * s;
  if (roundKinds.includes(item.kind)) {
    const x = X(item.x);
    const y = Y(item.y);
    ops.push(
      `q 0.94 g 0.2 G 0.7 w 1 0 0 1 ${num(x)} ${num(y)} cm ${turned(item.rotation)}${ellipse(w / 2, h / 2)} B Q`,
    );
    if (item.kind === "performer") words(x, y - 2.5);
    else words(x, y - h / 2 - 8);
    return ops.join("\n");
  }
  // Boxes turn about their centre, as the plan turns them.
  const cx = X(item.x + item.w / 2);
  const cy = Y(item.y + item.h / 2);
  const fill = item.kind === "wall" ? "0.45 g" : item.kind === "stage-box" ? "0.75 g" : "0.94 g";
  const paint = item.kind === "label" ? "n" : item.kind === "wall" ? "f" : "B";
  const dash = item.kind === "riser" ? "[3 2] 0 d " : "";
  ops.push(
    `q ${fill} 0.2 G 0.7 w ${dash}1 0 0 1 ${num(cx)} ${num(cy)} cm ${turned(item.rotation)}${num(-w / 2)} ${num(-h / 2)} ${num(w)} ${num(h)} re ${paint} Q`,
  );
  if (item.kind !== "wall") words(cx, cy - 2.5);
  return ops.join("\n");
}
