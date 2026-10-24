/**
 * What the Support page offers before a ticket (#181): answers already written down on the
 * documentation site, searched here by their words. The first three are the common answers it
 * shows before anything is typed.
 */
export interface HelpTopic {
  title: string;
  hint: string;
  /** Its page on the documentation site, after HEKATE_DOCS_URL. */
  path: string;
  /** More words it answers to. */
  words: string;
}

export const helpTopics: HelpTopic[] = [
  {
    title: "A file will not play",
    hint: "Checks, renditions and what the player needs",
    path: "/use/support/#a-file-will-not-play",
    words: "playback stream processing failed transcode audio video blank waveform",
  },
  {
    title: "Reviewers cannot see a file",
    hint: "Permissions, groups and per-review overrides",
    path: "/use/support/#reviewers-cannot-see-a-file",
    words: "guest access permission hidden missing review link",
  },
  {
    title: "Loudness reads differently elsewhere",
    hint: "Integrated loudness, true peak and the delivery profile",
    path: "/use/support/#loudness-reads-differently-elsewhere",
    words: "lufs peak qa meter delivery profile",
  },
  {
    title: "Asking for reviews and approvals",
    hint: "Approval or feedback, reviewers in order or all at once",
    path: "/use/reviews/",
    words: "approve approval feedback reviewer decision changes requested",
  },
  {
    title: "Guests and their links",
    hint: "Reviewers without an account, and how long a link lasts",
    path: "/use/guests/",
    words: "guest external link magic expired code",
  },
  {
    title: "Takes and sessions",
    hint: "Session snippets beside a track, with bars and in and out points",
    path: "/use/takes/",
    words: "take session recording bar microphone",
  },
  {
    title: "Recorders and the DAW",
    hint: "Timecode and takes from the recorder, and a player that follows a DAW",
    path: "/use/recorders/",
    words: "recorder daw midi timecode mtc mmc ltc sound devices follow take log",
  },
  {
    title: "Asking someone outside for files",
    hint: "Upload requests, their links and what arrives",
    path: "/use/upload-requests/",
    words: "upload request send files link",
  },
  {
    title: "Slack, Teams, Discord and webhooks",
    hint: "Where the workspace's events go",
    path: "/use/integrations/",
    words: "slack teams discord webhook notifications channel integration",
  },
  {
    title: "Workflow files",
    hint: "Stages, statuses and transitions written as a file",
    path: "/use/workflow-files/",
    words: "workflow stage status transition yaml",
  },
];

/** The topics whose words hold every word searched for, best first. */
export function topicsFor(search: string): HelpTopic[] {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return helpTopics;
  return helpTopics
    .map((t) => {
      const title = t.title.toLowerCase();
      const all = `${title} ${t.hint.toLowerCase()} ${t.words}`;
      if (!terms.every((term) => all.includes(term))) return null;
      return { t, score: terms.filter((term) => title.includes(term)).length };
    })
    .filter((x): x is { t: HelpTopic; score: number } => x !== null)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.t)
    .slice(0, 6);
}
