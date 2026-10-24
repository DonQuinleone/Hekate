/**
 * Caption tracks (#146, #201): sidecar files added to a video or a recording, each with its
 * language and what it is for, read into cues. The player shows one at a time from its
 * Captions menu; the transcript beside the comments lists, follows and searches it; any of
 * them exports as SubRip, WebVTT or TTML.
 */

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

export interface CaptionTrack {
  id: string;
  /** How the Captions menu names it. */
  label: string;
  /** A language tag: "en", "fr". */
  language: string | null;
  /** Subtitles carry the words; captions (SDH) the sounds as well. */
  kind: "subtitles" | "captions";
  format: "srt" | "vtt" | "ttml";
  /** The sidecar as it was added. */
  name: string;
  cues: CaptionCue[];
}

export const captionKindNames = { subtitles: "Subtitles", captions: "Captions (SDH)" } as const;
export const captionFormatNames = { srt: "SubRip", vtt: "WebVTT", ttml: "TTML" } as const;

const lines: [number, number, string, string, string?][] = [
  // start, end, English, French, and what an SDH track adds before the words
  [6, 9.5, "Endless Hall Records presents", "Endless Hall Records présente", "NARRATOR:"],
  [12, 15.5, "Every hall has a sound of its own.", "Chaque salle a son propre son."],
  [
    16,
    19.8,
    "This one took forty years to find.",
    "Celle-ci, il a fallu quarante ans pour la trouver.",
  ],
  [21, 24.5, "A film by Mira Solberg", "Un film de Mira Solberg"],
  [
    28,
    31.5,
    "We recorded at night,\nwhen the city was quiet.",
    "Nous enregistrions la nuit,\nquand la ville se taisait.",
    "MIRA:",
  ],
  [32, 35, "The piano stayed where it was.", "Le piano restait à sa place."],
  [36.5, 40, "We moved the microphones instead.", "Ce sont les micros que nous déplacions."],
  [
    44,
    47.5,
    "Try the next take a little slower.",
    "Essayez la prochaine prise un peu plus lentement.",
    "TOMAS:",
  ],
  [48, 51, "From the top of bar twelve?", "Depuis le début de la mesure douze ?", "INES:"],
  [51.5, 53, "From bar twelve.", "Depuis la mesure douze.", "TOMAS:"],
  [
    58,
    62,
    "Ragtime was dance music first.",
    "Le ragtime était d’abord une musique de danse.",
    "INES:",
  ],
  [
    62.5,
    66,
    "You have to play it as if\nsomebody is dancing.",
    "Il faut le jouer comme si\nquelqu’un dansait.",
  ],
  [
    72,
    75.5,
    "Listen to the room after the last chord.",
    "Écoutez la salle après le dernier accord.",
    "MIRA:",
  ],
  [76, 79, "That is the hall answering.", "C’est la salle qui répond."],
  [88, 92, "With Tomas Varga and Ines Arlow", "Avec Tomas Varga et Ines Arlow"],
  [96, 100, "Recorded at Endless Hall", "Enregistré à Endless Hall"],
  [
    110,
    114,
    "Some things you can only hear once.",
    "Certaines choses ne s’entendent qu’une fois.",
    "NARRATOR:",
  ],
  [118, 122, "So we kept everything.", "Alors nous avons tout gardé."],
];

/** What an SDH track says of the sound where nobody speaks. */
const sounds: CaptionCue[] = [
  { start: 0.5, end: 5, text: "[Soft piano]" },
  { start: 41, end: 43.5, text: "[Chair creaks]" },
  { start: 53.5, end: 56, text: "[Ragtime piano]" },
  { start: 67, end: 71, text: "[Final chord rings out]" },
  { start: 80, end: 86, text: "[Silence, then the hall settles]" },
  { start: 124, end: 140, text: "[Ragtime piano returns]" },
];

const english: CaptionCue[] = lines.map(([start, end, text]) => ({ start, end, text }));
const french: CaptionCue[] = lines.map(([start, end, , text]) => ({ start, end, text }));
const sdh: CaptionCue[] = [
  ...lines.map(([start, end, text, , who]) => ({
    start,
    end,
    text: who ? `${who} ${text}` : text,
  })),
  ...sounds,
].sort((a, b) => a.start - b.start);

const titles: CaptionTrack[] = [
  {
    id: "cap-en",
    label: "English",
    language: "en",
    kind: "subtitles",
    format: "ttml",
    name: "Opening titles.en.ttml",
    cues: english,
  },
  {
    id: "cap-en-sdh",
    label: "English (SDH)",
    language: "en",
    kind: "captions",
    format: "srt",
    name: "Opening titles.en.sdh.srt",
    cues: sdh,
  },
  {
    id: "cap-fr",
    label: "French",
    language: "fr",
    kind: "subtitles",
    format: "vtt",
    name: "Opening titles.fr.vtt",
    cues: french,
  },
];

const byFile: Record<string, CaptionTrack[]> = {
  "file-titles-c1": titles.slice(0, 1),
  "file-titles-c2": titles.slice(0, 1),
  "file-titles-c3": titles,
  "file-titles-c3-916": titles.slice(0, 1),
  // A recording carries them too: the narration of the stereo mix.
  "file-titles-stereo": titles.slice(0, 1),
};

export const captionTracksFor = (fileId: string): CaptionTrack[] => byFile[fileId] ?? [];

/** The cue showing at a moment, the one that began last where two overlap; -1 between. */
export function activeCue(cues: readonly CaptionCue[], time: number): number {
  let found = -1;
  cues.forEach((c, i) => {
    if (c.start <= time && time < c.end) found = i;
  });
  return found;
}

/** A transcript's search: case and accents set aside, line breaks read as spaces. */
export const foldText = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ");
