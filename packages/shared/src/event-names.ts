/**
 * The names of the events a workspace's channels and a member's notifications both hear of
 * (#681): one name for each, so the workspace's Channels and the account's Notifications call
 * the same thing the same way. Kept apart from `events.ts`, which needs a project's profile,
 * so that notifications can use them without importing the profile's module in a circle.
 */
export const eventNames = {
  review: "Review requested",
  decision: "Decision recorded",
  version: "New version",
  mention: "Mention",
  processing: "Processing failed",
} as const;
