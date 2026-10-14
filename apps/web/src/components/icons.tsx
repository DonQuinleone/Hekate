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
