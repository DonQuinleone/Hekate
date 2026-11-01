import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { instanceActionLabel, instanceActions } from "@hekate/shared";
import { describe, expect, it } from "vitest";

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });

const key = /"([a-z_]+\.[a-z_]+)"/g;

/**
 * Every action the server records as an instance event, read from the code that records them:
 * the `action` of each `recordInstanceEvent` call, the support desk's `event` and the queues'
 * `record` helpers, and the instance settings' changes, which are recorded one by one.
 */
const recordedActions = () => {
  const found = new Set<string>();
  const take = (text: string) => {
    for (const [, action] of text.matchAll(key)) found.add(action as string);
  };
  for (const file of sources(join(import.meta.dirname))) {
    const text = readFileSync(file, "utf8");
    for (const call of text.matchAll(/recordInstanceEvent\((?:tx|db), \{([\s\S]*?)\}\);/g)) {
      const action = /action:([^,]*(?:\?[^,]*:[^,]*)?),/.exec(call[1] as string);
      if (action) take(action[1] as string);
    }
    // The desk's and the queues' own helpers, which record nothing but instance events.
    if (/routes\/(support-desk|instance-queues)\.ts$/.test(file))
      for (const call of text.matchAll(
        /await (?:event|record)\(\s*c,([\s\S]*?),\s*(?:name|ticket|input|gone|queue|"Every)/g,
      ))
        take(call[1] as string);
  }
  const settings = readFileSync(
    join(import.meta.dirname, "../../../packages/shared/src/instance-settings.ts"),
    "utf8",
  );
  for (const change of settings.matchAll(/changes\.push\(\{\s*action:([^,]*(?:\?[^,]*:[^,]*)?),/g))
    take(change[1] as string);
  return [...found].sort();
};

describe("instance events in words (#597)", () => {
  it("finds the actions the server records", () => {
    const actions = recordedActions();
    // A check on the reading itself: each way of recording is seen.
    for (const action of [
      "operator.added",
      "support.replied",
      "support.reply_saved",
      "queue.paused",
      "queues.retried",
      "dates.format",
      "incident.resolved",
      "workspace.export_requested",
    ])
      expect(actions).toContain(action);
  });

  it("gives every recorded action a label, so no row shows a dotted key", () => {
    const unlabelled = recordedActions().filter((action) => !(action in instanceActions));
    expect(unlabelled).toEqual([]);
  });

  it("reads an unknown action as something done, with its key only in development", () => {
    expect(instanceActionLabel("support.replied")).toBe("answered");
    expect(instanceActionLabel("made.up")).toBe("did something");
    expect(instanceActionLabel("made.up", true)).toBe("did something (made.up)");
  });
});
