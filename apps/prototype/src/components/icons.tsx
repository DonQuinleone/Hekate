import type { SVGProps } from "react";

const paths = {
  plus: "M8 3 V13 M3 8 H13",
  check: "M3 8.5 L6.5 12 L13 4.5",
  search: "M7 3 a4 4 0 1 0 0.01 0 M10 10 L13.5 13.5",
  bell: "M4 11 V7 a4 4 0 0 1 8 0 v4 l1 1.5 H3 Z M6.5 14 h3",
  folder: "M2.5 4.5 H6.5 L8 6 H13.5 V12.5 H2.5 Z",
  settings:
    "M8 5.5 a2.5 2.5 0 1 0 0.01 0 M8 1.5 V3 M8 13 V14.5 M1.5 8 H3 M13 8 H14.5 M3.4 3.4 L4.5 4.5 M11.5 11.5 L12.6 12.6 M3.4 12.6 L4.5 11.5 M11.5 4.5 L12.6 3.4",
  chevronRight: "M6 3 L11 8 L6 13",
  upload: "M8 11 V3 M5 6 L8 3 L11 6 M3 10 V13 H13 V10",
  music: "M6 12 V3.5 L13 2 V10.5 M6 12 a1.75 1.75 0 1 1 -0.01 0 M13 10.5 a1.75 1.75 0 1 1 -0.01 0",
  film: "M2.5 3.5 H13.5 V12.5 H2.5 Z M5 3.5 V12.5 M11 3.5 V12.5 M2.5 8 H5 M11 8 H13.5",
  users:
    "M6 7.5 a2.5 2.5 0 1 0 0.01 0 M1.5 13.5 c0.5 -2.5 2.3 -3.5 4.5 -3.5 s4 1 4.5 3.5 M10.5 3 a2.2 2.2 0 1 1 0 4.4 M11.5 10 c1.6 0.3 2.7 1.3 3 3.5",
  mail: "M2.5 4 H13.5 V12 H2.5 Z M2.5 4.5 L8 8.5 L13.5 4.5",
  file: "M4 2.5 H9.5 L12 5 V13.5 H4 Z M9.5 2.5 V5 H12",
  image:
    "M2.5 3.5 H13.5 V12.5 H2.5 Z M2.5 10.5 L6 7 L9 10 L10.5 8.5 L13.5 11.5 M10.5 5.5 a1 1 0 1 0 0.01 0",
  close: "M4 4 L12 12 M12 4 L4 12",
  play: "M5 3.5 L12.5 8 L5 12.5 Z",
  pause: "M5.5 3.5 V12.5 M10.5 3.5 V12.5",
  volume: "M2.5 6 H5 L8.5 3 V13 L5 10 H2.5 Z M11 5.5 a3.5 3.5 0 0 1 0 5",
  mute: "M2.5 6 H5 L8.5 3 V13 L5 10 H2.5 Z M11 6 L14 10 M14 6 L11 10",
  /** A track: a folder holding a piece's versions. */
  track:
    "M2.5 4.5 H6.5 L8 6 H13.5 V12.5 H2.5 Z M7 11.25 V8.25 L10.5 7.75 V10.75 M7 11.25 a0.9 0.9 0 1 1 -0.01 0 M10.5 10.75 a0.9 0.9 0 1 1 -0.01 0",
  /** The sidebar: shown with labels, or as icons alone. */
  sidebar: "M2.5 3 H13.5 V13 H2.5 Z M6 3 V13",
  /** Reviews: a mark of approval in a box. */
  review: "M2.5 2.5 H13.5 V13.5 H2.5 Z M5.25 8.25 L7.25 10.25 L10.75 6",
  more: "M3.5 8 h0.01 M8 8 h0.01 M12.5 8 h0.01",
  home: "M2.5 7.5 L8 3 L13.5 7.5 V13.5 H9.5 V9.5 H6.5 V13.5 H2.5 Z",
  pulse: "M1.5 8 H4.5 L6 4 L8.5 12 L10.5 8 H14.5",
  chevronDown: "M3 6 L8 11 L13 6",
  chevronLeft: "M10 3 L5 8 L10 13",
  loop: "M3 7 V6 a2 2 0 0 1 2 -2 h7 l-2 -2 M13 9 v1 a2 2 0 0 1 -2 2 H4 l2 2",
  compare: "M5 2 V14 M11 2 V14 M2 5 L5 2 L8 5 M8 11 L11 14 L14 11",
  back5: "M3 3 V7 H7 M3.5 7 A5 5 0 1 1 3 9.5",
  forward5: "M13 3 V7 H9 M12.5 7 A5 5 0 1 0 13 9.5",
  mic: "M8 2 a2.5 2.5 0 0 1 2.5 2.5 v3 a2.5 2.5 0 0 1 -5 0 v-3 A2.5 2.5 0 0 1 8 2 Z M4 7.5 a4 4 0 0 0 8 0 M8 11.5 V14 M5.5 14 h5",
  take: "M2.5 12.5 V3.5 H13.5 V12.5 Z M5.5 6 L8 8 L10.5 6 M5.5 10 H10.5",
  score: "M2 4 H14 M2 7 H14 M2 10 H14 M6 7 a1.2 1.2 0 1 1 -0.01 0 M10.5 10 a1.2 1.2 0 1 1 -0.01 0",
  star: "M8 2.5 L9.8 6.2 L13.8 6.7 L10.9 9.5 L11.6 13.5 L8 11.6 L4.4 13.5 L5.1 9.5 L2.2 6.7 L6.2 6.2 Z",
  pin: "M9.5 2.5 L13.5 6.5 L11 7 L8.5 9.5 V13.5 L7.5 13.5 V9.5 L5 7 L2.5 6.5 L6.5 2.5 Z",
  download: "M8 2.5 V10.5 M5 7.5 L8 10.5 L11 7.5 M3 13.5 H13",
  link: "M6.5 9.5 L9.5 6.5 M5 11 a2.5 2.5 0 0 1 -3.5 -3.5 L4 5 a2.5 2.5 0 0 1 3.5 0 M11 5 a2.5 2.5 0 0 1 3.5 3.5 L12 11 a2.5 2.5 0 0 1 -3.5 0",
  edit: "M3 13 L3.5 10.5 L11 3 L13 5 L5.5 12.5 Z",
  clock: "M8 2.5 a5.5 5.5 0 1 0 0.01 0 M8 5 V8 L10.5 9.5",
  calendar: "M2.5 4 H13.5 V13.5 H2.5 Z M2.5 7 H13.5 M5.5 2.5 V5 M10.5 2.5 V5",
  board: "M2.5 3 H5.5 V13 H2.5 Z M6.5 3 H9.5 V9.5 H6.5 Z M10.5 3 H13.5 V11 H10.5 Z",
  list: "M2.5 4 H13.5 M2.5 8 H13.5 M2.5 12 H13.5",
  grid: "M2.5 2.5 H7 V7 H2.5 Z M9 2.5 H13.5 V7 H9 Z M2.5 9 H7 V13.5 H2.5 Z M9 9 H13.5 V13.5 H9 Z",
  filter: "M2.5 3.5 H13.5 L9.5 8.5 V13 L6.5 11.5 V8.5 Z",
  shield: "M8 2 L13 4 V8 c0 3 -2.5 5 -5 6 c-2.5 -1 -5 -3 -5 -6 V4 Z",
  key: "M9.5 6.5 a3 3 0 1 0 -3 3 h0 L2.5 13.5 M5.5 10.5 L7 12 M7 9 L8.5 10.5",
  eye: "M1.5 8 c1.5 -3 4 -4.5 6.5 -4.5 s5 1.5 6.5 4.5 c-1.5 3 -4 4.5 -6.5 4.5 S3 11 1.5 8 Z M8 6.2 a1.8 1.8 0 1 1 -0.01 0",
  eyeOff:
    "M2.5 2.5 L13.5 13.5 M6.2 6.3 a1.8 1.8 0 0 0 3.5 3.5 M3.7 5 C2.8 5.8 2 6.8 1.5 8 c1.5 3 4 4.5 6.5 4.5 c1.1 0 2.2 -0.3 3.2 -0.8 M6.3 3.8 C6.9 3.6 7.4 3.5 8 3.5 c2.5 0 5 1.5 6.5 4.5 c-0.4 0.8 -0.9 1.5 -1.5 2.1",
  comment: "M2.5 3.5 H13.5 V10.5 H8 L5 13 V10.5 H2.5 Z",
  tag: "M2.5 2.5 H7.5 L13.5 8.5 L8.5 13.5 L2.5 7.5 Z M5.5 5.5 h0.01",
  archive: "M2.5 3.5 H13.5 V6 H2.5 Z M3.5 6 V13.5 H12.5 V6 M6.5 9 H9.5",
  zoomIn: "M7 3 a4 4 0 1 0 0.01 0 M10 10 L13.5 13.5 M7 5 V9 M5 7 H9",
  zoomOut: "M7 3 a4 4 0 1 0 0.01 0 M10 10 L13.5 13.5 M5 7 H9",
  trash: "M3 4.5 H13 M6 4.5 V3 H10 V4.5 M4 4.5 L4.8 13.5 H11.2 L12 4.5",
  send: "M2.5 8 L13.5 2.5 L10.5 13.5 L8 9 Z",
  stop: "M4 4 H12 V12 H4 Z",
  record: "M8 4 a4 4 0 1 1 -0.01 0",
  warning: "M8 2.5 L14 13 H2 Z M8 7 V9.5 M8 11.5 h0.01",
} as const;

export type IconName = keyof typeof paths;

export function Icon({
  name,
  size = 16,
  ...props
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  );
}
