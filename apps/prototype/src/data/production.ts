/** The production side (from ControlRoom): repertoire, venues, personnel, the schedule, the patch list and the stage plan. All fictional. */

export interface Work {
  id: string;
  title: string;
  composer: string;
  forces: string;
  abbreviation: string;
  notes: string;
  trackIds: string[];
  scoreFileId: string | null;
  /** Each track's printed page range in the score, and the offset from PDF page to printed page. */
  pages: { trackId: string; from: number; to: number }[];
  pageOffset: number;
}

export const works: Work[] = [
  {
    id: "w-rags",
    title: "Rags",
    composer: "Scott Joplin",
    forces: "piano trio",
    abbreviation: "RAGS",
    notes: "Four rags in the trio arrangement; Pine Apple to be confirmed.",
    trackIds: ["t-maple", "t-entertainer", "t-solace", "t-elite", "t-pineapple"],
    scoreFileId: "file-score-maple",
    pages: [
      { trackId: "t-maple", from: 1, to: 7 },
      { trackId: "t-entertainer", from: 8, to: 14 },
      { trackId: "t-solace", from: 15, to: 20 },
      { trackId: "t-elite", from: 21, to: 26 },
    ],
    pageOffset: 2,
  },
];

export interface Venue {
  id: string;
  name: string;
  address: string[];
  notes: string;
}

export const venues: Venue[] = [
  {
    id: "v-stjohns",
    name: "St John's",
    address: ["Smith Square", "London SW1P 3HA"],
    notes: "Get-in by the north door; piano tuned on the morning of day 1.",
  },
  {
    id: "v-studio",
    name: "Endless Hall Studio 2",
    address: ["Unit 4, Mill Lane", "Bristol BS1 2AB"],
    notes: "Dead room; use the live chamber for the trio.",
  },
];

export interface Personnel {
  id: string;
  name: string;
  kind: "artist" | "ensemble" | "staff" | "other";
  role: string;
  agreement: boolean;
  headphones: boolean;
  personId?: string;
  guest?: boolean;
  sections?: { name: string; count: number; divisi?: string; names?: string[] }[];
  seating?: string;
}

export const personnel: Personnel[] = [
  {
    id: "pe-1",
    name: "Mira Solberg",
    kind: "artist",
    role: "Conductor",
    agreement: true,
    headphones: false,
    personId: "p-mira",
    guest: true,
  },
  {
    id: "pe-2",
    name: "Ines Arlow",
    kind: "artist",
    role: "Piano",
    agreement: true,
    headphones: true,
    personId: "p-ines",
  },
  {
    id: "pe-3",
    name: "Tomas Varga",
    kind: "staff",
    role: "Engineer",
    agreement: true,
    headphones: true,
    personId: "p-tomas",
  },
  {
    id: "pe-4",
    name: "Alex Rivera",
    kind: "staff",
    role: "Producer",
    agreement: true,
    headphones: true,
    personId: "p-alex",
  },
  {
    id: "pe-5",
    name: "Endless Hall Strings",
    kind: "ensemble",
    role: "Strings",
    agreement: false,
    headphones: false,
    sections: [
      { name: "Violin I", count: 4, divisi: "2 + 2" },
      { name: "Violin II", count: 3 },
      { name: "Viola", count: 2 },
      { name: "Cello", count: 2 },
      { name: "Bass", count: 1 },
    ],
    seating: "Antiphonal violins; basses behind the cellos.",
  },
  {
    id: "pe-6",
    name: "Piano technician",
    kind: "other",
    role: "Tuning",
    agreement: false,
    headphones: false,
  },
];

export interface ScheduleRow {
  id: string;
  kind: "slot" | "break" | "get-in" | "venue";
  start: string;
  minutes: number;
  trackId?: string;
  label?: string;
  personnel?: string;
  notes?: string;
  done?: boolean;
}

export interface ScheduleDay {
  id: string;
  label: string;
  date: string;
  venueId: string;
  rows: ScheduleRow[];
}

export const schedule: ScheduleDay[] = [
  {
    id: "d-1",
    label: "Day 1",
    date: "2026-09-12",
    venueId: "v-stjohns",
    rows: [
      {
        id: "r-1",
        kind: "get-in",
        start: "09:00",
        minutes: 60,
        label: "Get-in and rig",
        personnel: "Engineer, producer",
        done: true,
      },
      {
        id: "r-2",
        kind: "slot",
        start: "10:00",
        minutes: 90,
        trackId: "t-maple",
        personnel: "Trio",
        notes: "Sections A and B first.",
        done: true,
      },
      { id: "r-3", kind: "break", start: "11:30", minutes: 20, label: "Coffee", done: true },
      {
        id: "r-4",
        kind: "slot",
        start: "11:50",
        minutes: 70,
        trackId: "t-entertainer",
        personnel: "Trio",
        done: true,
      },
      { id: "r-5", kind: "break", start: "13:00", minutes: 60, label: "Lunch", done: true },
      {
        id: "r-6",
        kind: "slot",
        start: "14:00",
        minutes: 120,
        trackId: "t-solace",
        personnel: "Trio",
        notes: "Pick-ups for Maple at the end if time.",
      },
    ],
  },
  {
    id: "d-2",
    label: "Day 2",
    date: "2026-09-13",
    venueId: "v-stjohns",
    rows: [
      {
        id: "r-7",
        kind: "slot",
        start: "10:00",
        minutes: 120,
        trackId: "t-elite",
        personnel: "Trio",
      },
      { id: "r-8", kind: "break", start: "12:00", minutes: 60, label: "Lunch" },
      { id: "r-9", kind: "venue", start: "13:00", minutes: 90, label: "Move to Studio 2" },
      {
        id: "r-10",
        kind: "slot",
        start: "14:30",
        minutes: 90,
        trackId: "t-pineapple",
        personnel: "Trio",
        notes: "If the arrangement arrives.",
      },
    ],
  },
];

export interface PatchRow {
  channel: number;
  source: string;
  device: string;
  cable: string;
  notes: string;
  micId?: string;
}

export interface StageBox {
  id: string;
  name: string;
  inputs: PatchRow[];
  outputs: PatchRow[];
}

export const patchList: StageBox[] = [
  {
    id: "sb-1",
    name: "Stage box A",
    inputs: [
      { channel: 1, source: "Main L", device: "DPA 4006", cable: "A1", notes: "", micId: "m-1" },
      { channel: 2, source: "Main R", device: "DPA 4006", cable: "A2", notes: "", micId: "m-2" },
      {
        channel: 3,
        source: "Spot piano L",
        device: "Schoeps MK4",
        cable: "A3",
        notes: "lid on short stick",
        micId: "m-3",
      },
      {
        channel: 4,
        source: "Spot piano R",
        device: "Schoeps MK4",
        cable: "A4",
        notes: "",
        micId: "m-4",
      },
      {
        channel: 5,
        source: "Room L",
        device: "Neumann KM 183",
        cable: "A5",
        notes: "",
        micId: "m-5",
      },
      {
        channel: 6,
        source: "Room R",
        device: "Neumann KM 183",
        cable: "A6",
        notes: "",
        micId: "m-6",
      },
    ],
    outputs: [
      {
        channel: 1,
        source: "Talkback",
        device: "Headphone amp",
        cable: "B1",
        notes: "to the piano",
      },
      { channel: 2, source: "Cue mix", device: "Headphone amp", cable: "B2", notes: "" },
    ],
  },
];

export interface StageItem {
  id: string;
  kind: "performer" | "ensemble" | "mic" | "instrument" | "riser" | "wall" | "label";
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
  micId?: string;
}

/** Metres, from the back-left corner of the stage. */
export const stagePlan: { width: number; height: number; items: StageItem[] } = {
  width: 12,
  height: 8,
  items: [
    {
      id: "s-1",
      kind: "instrument",
      label: "Piano",
      x: 4.5,
      y: 2.2,
      w: 2.8,
      h: 1.6,
      rotation: -20,
    },
    { id: "s-2", kind: "performer", label: "Piano", x: 4.2, y: 3.9, w: 0.6, h: 0.6 },
    { id: "s-3", kind: "performer", label: "Violin", x: 7.6, y: 3.6, w: 0.6, h: 0.6 },
    { id: "s-4", kind: "performer", label: "Cello", x: 8.4, y: 2.4, w: 0.6, h: 0.6 },
    { id: "s-5", kind: "mic", label: "Main L", x: 5.2, y: 5.6, w: 0.3, h: 0.3, micId: "m-1" },
    { id: "s-6", kind: "mic", label: "Main R", x: 6.8, y: 5.6, w: 0.3, h: 0.3, micId: "m-2" },
    { id: "s-7", kind: "mic", label: "Spot L", x: 5.0, y: 2.0, w: 0.3, h: 0.3, micId: "m-3" },
    { id: "s-8", kind: "mic", label: "Spot R", x: 6.4, y: 1.6, w: 0.3, h: 0.3, micId: "m-4" },
    { id: "s-9", kind: "mic", label: "Room L", x: 2.0, y: 7.0, w: 0.3, h: 0.3, micId: "m-5" },
    { id: "s-10", kind: "mic", label: "Room R", x: 10.0, y: 7.0, w: 0.3, h: 0.3, micId: "m-6" },
    { id: "s-11", kind: "riser", label: "Riser", x: 7.2, y: 1.8, w: 2.4, h: 2.4 },
    { id: "s-12", kind: "wall", label: "Rear wall", x: 0, y: 0, w: 12, h: 0.2 },
    { id: "s-13", kind: "label", label: "Audience", x: 5.2, y: 7.5, w: 1.6, h: 0.4 },
  ],
};

export interface ScoreMark {
  id: string;
  page: number;
  bar: number;
  barTo?: number;
  kind:
    | "issue"
    | "edit"
    | "take-start"
    | "take-end"
    | "punch"
    | "wrong-note"
    | "dynamic"
    | "note"
    | "ink";
  category?: "intonation" | "ensemble" | "noise" | "wrong-note" | "balance";
  text: string;
  takeNumbers?: number[];
  fixedBy?: number;
  x: number;
  y: number;
}

export const scoreMarks: ScoreMark[] = [
  {
    id: "sm-1",
    page: 1,
    bar: 5,
    kind: "issue",
    category: "noise",
    text: "Pedal noise",
    takeNumbers: [3, 7],
    fixedBy: 12,
    x: 0.22,
    y: 0.42,
  },
  {
    id: "sm-2",
    page: 1,
    bar: 17,
    barTo: 18,
    kind: "edit",
    text: "3T12 into T7",
    takeNumbers: [12, 7],
    x: 0.3,
    y: 0.78,
  },
  {
    id: "sm-3",
    page: 1,
    bar: 9,
    kind: "wrong-note",
    text: "LH F sharp",
    takeNumbers: [3],
    fixedBy: 9,
    x: 0.52,
    y: 0.56,
  },
  { id: "sm-4", page: 1, bar: 13, kind: "dynamic", text: "mp, not mf", x: 0.71, y: 0.64 },
  {
    id: "sm-5",
    page: 2,
    bar: 25,
    kind: "take-start",
    text: "T9 starts",
    takeNumbers: [9],
    x: 0.12,
    y: 0.2,
  },
  {
    id: "sm-6",
    page: 2,
    bar: 36,
    kind: "punch",
    text: "punch in T13 at the upbeat",
    takeNumbers: [13],
    x: 0.6,
    y: 0.5,
  },
  {
    id: "sm-7",
    page: 1,
    bar: 1,
    kind: "note",
    text: "Tempo settles by bar 3; keep T12's opening.",
    x: 0.8,
    y: 0.26,
  },
];
