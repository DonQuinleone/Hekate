import type { SVGProps } from "react";

/** A cog: eight teeth around a hub, drawn once at module load. */
function gear(): string {
  const teeth = 8;
  const outer = 7;
  const inner = 5.3;
  const parts: string[] = [];
  const step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    const pts = [
      [inner, a - step * 0.3],
      [outer, a - step * 0.16],
      [outer, a + step * 0.16],
      [inner, a + step * 0.3],
    ] as const;
    for (const [r, t] of pts) {
      const x = 8 + r * Math.cos(t);
      const y = 8 + r * Math.sin(t);
      parts.push(`${parts.length === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`);
    }
  }
  return `${parts.join(" ")}Z M8 5.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4Z`;
}

const dot = (cx: number, cy: number, r = 1.4) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z`;

type Entry = string | { d: string; fill?: boolean; vb?: number };

/**
 * One set, one weight: 16 px, 1.5 stroke, round joins. Brand marks (Slack, Discord, Teams)
 * are filled shapes on a 24 px grid. Nothing here is a zero-length segment, which some
 * engines refuse to cap.
 */
const paths = {
  /* ---- actions ---- */
  plus: "M8 3v10M3 8h10",
  check: "M3 8.5l3.5 3.5L13 4.5",
  close: "M4 4l8 8M12 4l-8 8",
  search: "M7 3a4 4 0 1 1 0 8a4 4 0 1 1 0-8Z M10 10l3.5 3.5",
  more: { d: `${dot(3.5, 8)} ${dot(8, 8)} ${dot(12.5, 8)}`, fill: true },
  moreVertical: { d: `${dot(8, 3.5)} ${dot(8, 8)} ${dot(8, 12.5)}`, fill: true },
  upload: "M8 11V3M5 6l3-3 3 3M3 10.5V13h10v-2.5",
  download: "M8 2.5v8M5 7.5l3 3 3-3M3 13h10",
  send: "M13.5 2.5L2.5 7.5l5 1.5 1.5 5Z M13.5 2.5 7.5 9",
  edit: "M3 13l.6-2.6L11 3l2 2-7.4 7.4Z M9.8 4.2l2 2",
  trash: "M3 4.5h10M6 4.5V3h4v1.5M4 4.5l.8 9h6.4l.8-9 M6.8 7v4.5M9.2 7v4.5",
  link: "M6.5 9.5l3-3 M5 11a2.5 2.5 0 0 1-3.5-3.5L4 5a2.5 2.5 0 0 1 3.5 0 M11 5a2.5 2.5 0 0 1 3.5 3.5L12 11a2.5 2.5 0 0 1-3.5 0",
  copy: "M6 6h7v7H6Z M3 10V3h7",
  external: "M9 3h4v4 M13 3 7.5 8.5 M11 9v4H3V5h4",
  filter: "M2.5 3.5h11L9.5 8.5V13l-3-1.5V8.5Z",
  sort: "M3 4.5h10M3 8h7M3 11.5h4",
  pin: "M9.5 2.5l4 4-2.5.5-2.5 2.5V13.5h-1V9.5L5 7 2.5 6.5l4-4Z",
  star: "M8 2.5l1.8 3.7 4 .5-2.9 2.8.7 4L8 11.6l-3.6 1.9.7-4-2.9-2.8 4-.5Z",
  flag: "M3.5 14V2.5h8l-1.5 3 1.5 3h-8",
  archive: "M2.5 3.5h11V6h-11Z M3.5 6v7.5h9V6 M6.5 9h3",
  tag: { d: `M2.5 2.5h5l6 6-5 5-6-6Z ${dot(5.5, 5.5, 0.9)}` },
  refresh: "M13 8a5 5 0 0 1-9 3 M3 8a5 5 0 0 1 9-3 M12 2.5V5h-2.5 M4 13.5V11h2.5",
  logout: "M6.5 2.5h-3v11h3 M10 5l3 3-3 3 M13 8H6.5",
  grip: {
    d: `${dot(5.5, 4, 1.1)} ${dot(10.5, 4, 1.1)} ${dot(5.5, 8, 1.1)} ${dot(10.5, 8, 1.1)} ${dot(5.5, 12, 1.1)} ${dot(10.5, 12, 1.1)}`,
    fill: true,
  },
  /* ---- arrows ---- */
  chevronRight: "M6 3l5 5-5 5",
  chevronLeft: "M10 3L5 8l5 5",
  chevronDown: "M3 6l5 5 5-5",
  chevronUp: "M3 10l5-5 5 5",
  arrowRight: "M3 8h10M9 4l4 4-4 4",
  arrowLeft: "M13 8H3M7 4L3 8l4 4",
  arrowUp: "M8 13V3M4 7l4-4 4 4",
  /* ---- places ---- */
  home: "M2.5 7.5 8 3l5.5 4.5V13a.5.5 0 0 1-.5.5H9.5V9.5h-3v4H3a.5.5 0 0 1-.5-.5Z",
  dashboard: "M2.5 2.5h4.5v6H2.5Z M9 2.5h4.5v3.5H9Z M9 8h4.5v5.5H9Z M2.5 10.5h4.5v3H2.5Z",
  inbox: "M2.5 9l1.5-5.5h8L13.5 9v4h-11Z M2.5 9h3.2l1 1.8h2.6l1-1.8h3.2",
  folder: "M2 4.5a1 1 0 0 1 1-1h3.5L8 5h5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z",
  folderPlus:
    "M2 4.5a1 1 0 0 1 1-1h3.5L8 5h5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z M8 7v4M6 9h4",
  file: "M4 2.5h5.5L12 5v8.5H4Z M9.5 2.5V5H12",
  filePlus: "M4 2.5h5.5L12 5v8.5H4Z M9.5 2.5V5H12 M8 7v4M6 9h4",
  image: {
    d: `M2.5 3.5h11v9h-11Z M2.5 11l3.5-3.5 2.5 2.5 2-2 3 3 ${dot(10.5, 6, 1)}`,
  },
  music:
    "M6 12V3.5L13 2v8.5 M6 12a1.75 1.75 0 1 1-3.5 0a1.75 1.75 0 1 1 3.5 0Z M13 10.5a1.75 1.75 0 1 1-3.5 0a1.75 1.75 0 1 1 3.5 0Z",
  film: "M2.5 3.5h11v9h-11Z M5 3.5v9M11 3.5v9M2.5 8H5M11 8h2.5M2.5 5.75H5M11 5.75h2.5M2.5 10.25H5M11 10.25h2.5",
  /** A track: a tile holding a piece's recording. */
  track: "M2 7v2M4.4 4.5v7M6.8 2.5v11M9.2 5.5v5M11.6 4v8M14 6.5v3",
  waveform: "M2 6.5v3M4.5 4v8M7 2.5v11M9.5 5.5v5M12 4v8M14 6.5v3",
  score: {
    d: `M2 4h12M2 7h12M2 10h12 ${dot(6, 7, 1.2)} ${dot(10.5, 10, 1.2)}`,
  },
  mic: "M8 2a2.5 2.5 0 0 1 2.5 2.5v3a2.5 2.5 0 0 1-5 0v-3A2.5 2.5 0 0 1 8 2Z M4 7.5a4 4 0 0 0 8 0 M8 11.5V14M5.5 14h5",
  /** A take: a reel. */
  take: "M8 2.5a5.5 5.5 0 1 1 0 11a5.5 5.5 0 1 1 0-11Z M8 6.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3Z M8 2.5V5M8 11v2.5M2.5 8H5M11 8h2.5",
  /* ---- people ---- */
  user: "M8 8a2.75 2.75 0 1 0 0-5.5A2.75 2.75 0 1 0 8 8Z M3 14c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5",
  passkey:
    "M6.5 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM2 13.5c0-2.5 2-4 4.5-4 .9 0 1.7.2 2.4.5M13.5 9.2a1.8 1.8 0 1 1-3.6 0 1.8 1.8 0 0 1 3.6 0ZM11.7 11v3l1 .8 1-.8v-1.2l-.8-.6.8-.6V11",
  help: "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM6 6.3a2 2 0 0 1 3.9.6c0 1.3-1.9 1.6-1.9 2.9M8 12h.01",
  fingerprint:
    "M3.2 6.2A5.2 5.2 0 0 1 8 2.8c1.1 0 2.1.3 3 .9M2.6 10.5c-.1-.8-.1-1.6 0-2.3M13.2 5.6c.3.7.5 1.5.5 2.4 0 1.3-.1 2.6-.4 3.8M5.2 13.4c.4-1 .6-2.2.6-3.4V8a2.2 2.2 0 0 1 4.4 0v.6M8 13.8c.6-1.1 1-2.4 1.1-3.8M11 12.2c.2-.6.3-1.3.4-2M5.5 6.4A2.9 2.9 0 0 1 8 5.1",
  users:
    "M6 8a2.5 2.5 0 1 0 0-5a2.5 2.5 0 1 0 0 5Z M1.5 14c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4 M10.5 3.2a2.5 2.5 0 0 1 0 4.6 M12 10.2c1.5.5 2.5 1.8 2.5 3.8",
  userPlus:
    "M6.5 8a2.5 2.5 0 1 0 0-5a2.5 2.5 0 1 0 0 5Z M2 14c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4 M12.5 6v4M10.5 8h4",
  building: "M3 13.5V3h7v10.5 M10 6.5h3v7 M5.5 5.5h2M5.5 8h2M5.5 10.5h2 M3 13.5h10",
  mail: "M2.5 4h11v8h-11Z M2.5 4.5 8 8.5l5.5-4",
  bell: "M8 2.5a4 4 0 0 0-4 4v2.5L2.5 11.5h11L12 9V6.5a4 4 0 0 0-4-4Z M6.5 13.5a1.5 1.5 0 0 0 3 0",
  bellOff:
    "M2.5 2.5l11 11 M5 5.2A4 4 0 0 0 4 6.5v2.5L2.5 11.5h8.5 M12 9V6.5a4 4 0 0 0-5.8-3.6 M6.5 13.5a1.5 1.5 0 0 0 3 0",
  comment: "M2.5 3.5h11v7H8l-3 2.5v-2.5H2.5Z",
  /* ---- review and workflow ---- */
  review: "M2.5 2.5h11v11h-11Z M5.25 8.25l2 2L10.75 6",
  board: "M2.5 3h3v10h-3Z M6.5 3h3v6h-3Z M10.5 3h3v8h-3Z",
  list: "M2.5 4h11M2.5 8h11M2.5 12h11",
  grid: "M2.5 2.5H7V7H2.5Z M9 2.5h4.5V7H9Z M2.5 9H7v4.5H2.5Z M9 9h4.5v4.5H9Z",
  columns: "M2.5 3h11v10h-11Z M6.2 3v10M9.8 3v10",
  calendar: "M2.5 4.5h11v9h-11Z M2.5 7.5h11 M5.5 2.5v3M10.5 2.5v3",
  clock: "M8 2.5a5.5 5.5 0 1 1 0 11a5.5 5.5 0 1 1 0-11Z M8 5v3l2.5 1.5",
  pulse: "M1.5 8h3L6 4l2.5 8 2-4h3",
  branch:
    "M4.5 5.5v6 M4.5 5.5a1.75 1.75 0 1 0 0-3.5a1.75 1.75 0 1 0 0 3.5Z M4.5 15a1.75 1.75 0 1 0 0-3.5a1.75 1.75 0 1 0 0 3.5Z M11.5 7a1.75 1.75 0 1 0 0-3.5a1.75 1.75 0 1 0 0 3.5Z M11.5 7c0 3-7 2-7 4.5",
  split: "M2.5 8h4l3-4h4 M6.5 8l3 4h4 M11.5 2.5 13.5 4l-2 1.5 M11.5 10.5l2 1.5-2 1.5",
  merge: "M4 2.5v3a4 4 0 0 0 4 4a4 4 0 0 0 4-4v-3 M8 9.5V14 M6 12l2 2 2-2",
  repeat:
    "M3.5 6.5v-1a2 2 0 0 1 2-2h7.5 M11 1.5l2 2-2 2 M12.5 9.5v1a2 2 0 0 1-2 2H3 M5 15l-2-2 2-2",
  bolt: "M9 1.5 3 9h4.5L7 14.5 13 7H8.5Z",
  task: "M2.5 3.5h11v9h-11Z M5 8l2 2 4-4",
  gate: "M2.5 8h3M10.5 8h3 M8 5.5a2.5 2.5 0 1 1 0 5a2.5 2.5 0 1 1 0-5Z M8 2.5V5.5M8 10.5v3",
  loop: "M3 7V6a2 2 0 0 1 2-2h7l-2-2 M13 9v1a2 2 0 0 1-2 2H4l2 2",
  /* ---- player ---- */
  play: "M5 3.5 12.5 8 5 12.5Z",
  pause: "M5.5 3.5v9M10.5 3.5v9",
  stop: "M4 4h8v8H4Z",
  record: "M8 4a4 4 0 1 1 0 8a4 4 0 1 1 0-8Z",
  volume: "M2.5 6H5l3.5-3v10L5 10H2.5Z M11 5.5a3.5 3.5 0 0 1 0 5",
  mute: "M2.5 6H5l3.5-3v10L5 10H2.5Z M11 6l3 4M14 6l-3 4",
  compare: "M5 2v12M11 2v12M2 5l3-3 3 3M8 11l3 3 3-3",
  back5: "M3 3v4h4 M3.5 7A5 5 0 1 1 3 9.5",
  forward5: "M13 3v4H9 M12.5 7A5 5 0 1 0 13 9.5",
  zoomIn: "M7 3a4 4 0 1 1 0 8a4 4 0 1 1 0-8Z M10 10l3.5 3.5M7 5v4M5 7h4",
  zoomOut: "M7 3a4 4 0 1 1 0 8a4 4 0 1 1 0-8Z M10 10l3.5 3.5M5 7h4",
  sidebar: "M2.5 3h11v10h-11Z M6 3v10",
  layoutRight: "M2.5 3h11v10h-11Z M10 3v10",
  layoutBottom: "M2.5 3h11v10h-11Z M2.5 9.5h11",
  layoutHide: "M2.5 3h11v10h-11Z M10 3v10M11 6.5 12.5 8 11 9.5",
  sliders: "M3 4.5h10M3 8h10M3 11.5h10 M6 3v3M10.5 6.5v3M5 10v3",
  /* ---- state ---- */
  warning: { d: `M8 2.5 14 13H2Z M8 6.5v3 ${dot(8, 11.5, 0.7)}` },
  info: { d: `M8 2.5a5.5 5.5 0 1 1 0 11a5.5 5.5 0 1 1 0-11Z M8 7.5v3.5 ${dot(8, 5.5, 0.7)}` },
  eye: "M1.5 8c1.5-3 4-4.5 6.5-4.5s5 1.5 6.5 4.5c-1.5 3-4 4.5-6.5 4.5S3 11 1.5 8Z M8 6.2a1.8 1.8 0 1 1 0 3.6a1.8 1.8 0 1 1 0-3.6Z",
  eyeOff:
    "M2.5 2.5l11 11 M6.2 6.3a1.8 1.8 0 0 0 3.5 3.5 M3.7 5C2.8 5.8 2 6.8 1.5 8c1.5 3 4 4.5 6.5 4.5c1.1 0 2.2-.3 3.2-.8 M6.3 3.8C6.9 3.6 7.4 3.5 8 3.5c2.5 0 5 1.5 6.5 4.5c-.4.8-.9 1.5-1.5 2.1",
  shield: "M8 2 13 4v4c0 3-2.5 5-5 6-2.5-1-5-3-5-6V4Z",
  key: "M9.5 6.5a3 3 0 1 0-3 3 L2.5 13.5 M5.5 10.5 7 12M7 9l1.5 1.5",
  lock: "M4 7h8v6.5H4Z M5.5 7V5a2.5 2.5 0 0 1 5 0v2",
  globe:
    "M8 2.5a5.5 5.5 0 1 1 0 11a5.5 5.5 0 1 1 0-11Z M2.5 8h11 M8 2.5c1.8 1.8 1.8 9.2 0 11 M8 2.5c-1.8 1.8-1.8 9.2 0 11",
  server: "M2.5 3h11v4h-11Z M2.5 9h11v4h-11Z M5 5h.5M5 11h.5",
  database:
    "M8 2.5c3 0 5.5.9 5.5 2s-2.5 2-5.5 2-5.5-.9-5.5-2 2.5-2 5.5-2Z M2.5 4.5v7c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-7 M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2",
  cloud: "M5 12.5h6.5a3 3 0 0 0 .5-5.96A4 4 0 0 0 4.3 7.5 2.5 2.5 0 0 0 5 12.5Z",
  chart: "M2.5 13.5h11 M4.5 11V7M8 11V4M11.5 11V8.5",
  sun: "M8 5.5a2.5 2.5 0 1 1 0 5a2.5 2.5 0 1 1 0-5Z M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1",
  moon: "M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z",
  settings: { d: gear() },
  /* ---- brand marks, filled, on a 24 grid ---- */
  slack: {
    vb: 24,
    fill: true,
    d: "M9.5 2.5a1.5 1.5 0 0 1 1.5 1.5v6.5H9.5A1.5 1.5 0 0 1 8 9V4a1.5 1.5 0 0 1 1.5-1.5Z M6.5 7h1.5v3.5H6.5a1.75 1.75 0 1 1 0-3.5Z M21.5 9.5a1.5 1.5 0 0 1-1.5 1.5h-6.5V9.5A1.5 1.5 0 0 1 15 8h5a1.5 1.5 0 0 1 1.5 1.5Z M17 6.5V8h-3.5V6.5a1.75 1.75 0 1 1 3.5 0Z M14.5 21.5A1.5 1.5 0 0 1 13 20v-6.5h1.5A1.5 1.5 0 0 1 16 15v5a1.5 1.5 0 0 1-1.5 1.5Z M17.5 17H16v-3.5h1.5a1.75 1.75 0 1 1 0 3.5Z M2.5 14.5A1.5 1.5 0 0 1 4 13h6.5v1.5A1.5 1.5 0 0 1 9 16H4a1.5 1.5 0 0 1-1.5-1.5Z M7 17.5V16h3.5v1.5a1.75 1.75 0 1 1-3.5 0Z",
  },
  discord: {
    vb: 24,
    fill: true,
    d: "M19.5 5.5a16.2 16.2 0 0 0-4-1.25l-.5 1.05a15 15 0 0 0-6 0l-.5-1.05a16.2 16.2 0 0 0-4 1.25C1.9 9.2 1.2 12.8 1.55 16.4a16.4 16.4 0 0 0 4.95 2.5l1.05-1.65a10 10 0 0 1-1.65-.8l.4-.3a11.6 11.6 0 0 0 11.4 0l.4.3a10 10 0 0 1-1.65.8l1.05 1.65a16.4 16.4 0 0 0 4.95-2.5c.45-4.2-.7-7.8-2.9-10.9ZM8.6 14.3c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.85.9 1.8 2c0 1.1-.8 2-1.8 2Zm6.8 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.85.9 1.8 2c0 1.1-.8 2-1.8 2Z",
  },
  teams: {
    vb: 24,
    fill: true,
    d: "M10.5 3.5a2.25 2.25 0 1 1 0 4.5a2.25 2.25 0 0 1 0-4.5Z M18 5.5a1.75 1.75 0 1 1 0 3.5a1.75 1.75 0 0 1 0-3.5Z M2.5 9.5A1.5 1.5 0 0 1 4 8h7a1.5 1.5 0 0 1 1.5 1.5V16a4.5 4.5 0 0 1-9 0ZM5.5 10.5v1.5h2v5.5h1.5V12h2v-1.5Z M14 10h4.5a1.5 1.5 0 0 1 1.5 1.5V16a3.5 3.5 0 0 1-5.75 2.7A6 6 0 0 0 14 16Z",
  },
  webhook:
    "M8 2.5a3 3 0 0 1 2.6 4.5L8.5 10.5 M6.5 10.5 5.4 7A3 3 0 0 1 8 2.5 M3 10.5a3 3 0 1 0 5.5 1.5h5",
} as const satisfies Record<string, Entry>;

export type IconName = keyof typeof paths;
/** Every icon in the set, for the design system reference. */
export const iconNames = Object.keys(paths) as IconName[];

export function Icon({
  name,
  size = 16,
  ...props
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  const entry = paths[name] as Entry;
  const spec = typeof entry === "string" ? { d: entry } : entry;
  const vb = spec.vb ?? 16;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${vb} ${vb}`}
      fill={spec.fill ? "currentColor" : "none"}
      stroke={spec.fill ? "none" : "currentColor"}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={spec.d} fillRule={spec.fill ? "evenodd" : undefined} />
    </svg>
  );
}
