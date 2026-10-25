import type { Family } from "../family.ts";

/**
 * Views (provisional, decision 242): the desktop app's saved views and layout. They describe
 * ControlRoom's own windows, not the project, so every event of theirs is read and set aside,
 * and counted in the report.
 */
const reason = "The desktop app's own view, not part of the project";

export const views: Family = {
  name: "views",
  nouns: {},
  ignoredNouns: { view: reason, layout: reason, ui: reason, selection: reason, zoom: reason },
};
