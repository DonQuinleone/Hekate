import { type PlayerTool, playerTools } from "@hekate/shared";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "~/lib/cn";
import { Checkbox } from "./ui/choice";

/** Each player tool as the matrix names it (#240). */
export const toolWords: Record<PlayerTool, { label: string; hint: string }> = {
  qa: { label: "QA", hint: "Findings, loudness, format and metadata" },
  meters: { label: "Meters", hint: "Loudness and peaks beside the player" },
  spectrogram: { label: "Spectrogram", hint: "Below or instead of the waveform" },
  score: { label: "Score", hint: "The linked score beside the recording" },
  compare: { label: "Compare", hint: "Versions and variations side by side" },
  loops: { label: "Loops", hint: "A passage played round, from comments too" },
  normalise: {
    label: "Normalise",
    hint: "Level-matched playback at the delivery profile's target, where the project leaves it a choice",
  },
};

/** A column of the matrix: a role, or an exception for one person or group (decision 258). */
export interface ToolColumn {
  id: string;
  name: string;
  tools: readonly string[];
  /** A line under its name: "Guest", "Group". */
  caption?: string;
  /** Its actions, beside its name. */
  actions?: ReactNode;
}

/**
 * Every player tool against every role, on or off: a project's roles (#240) and its
 * exceptions (decision 258), or the default roles a new project starts with (#55). On a phone
 * only `column`'s column is shown.
 */
export function PlayerToolsTable({
  roles,
  manage,
  column,
  onToggle,
}: {
  roles: ToolColumn[];
  manage: boolean;
  /** Classes for a role's column: hidden on a phone unless it is the one shown. */
  column: (roleId: string) => string;
  onToggle: (roleId: string, tool: PlayerTool, on: boolean) => void;
}) {
  return (
    <div className="rounded-panel-lg border border-line bg-raised/25 shadow-1 @3xl/app:overflow-x-auto">
      <table
        className="w-full border-collapse text-[13px] @3xl/app:min-w-[var(--roles-width)]"
        // A column holds a checkbox and a name that truncates, so a project's five roles and an
        // exception or two fit the settings page before it scrolls sideways.
        style={{ "--roles-width": `${200 + roles.length * 100}px` } as CSSProperties}
      >
        <thead>
          <tr>
            <th className="label px-4 py-2 text-left font-normal">Tool</th>
            {roles.map((role) => (
              <th
                key={role.id}
                className={cn(
                  "w-[120px] px-1 py-2 text-left font-normal last:pr-4",
                  column(role.id),
                )}
              >
                <span className="flex items-center gap-1 px-2">
                  <span className="min-w-0 flex-1">
                    <span className="label block truncate" title={role.name}>
                      {role.name}
                    </span>
                    {role.caption && (
                      <span className="block truncate text-[12px] text-ink-3">{role.caption}</span>
                    )}
                  </span>
                  {role.actions}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {playerTools.map((tool) => (
            <tr key={tool} className="border-t border-line">
              <td className="px-4 py-2">
                <div className="text-ink">{toolWords[tool].label}</div>
                <div className="text-[12px] text-ink-3">{toolWords[tool].hint}</div>
              </td>
              {roles.map((role) => {
                const on = role.tools.includes(tool);
                return (
                  <td key={role.id} className={cn("px-1 py-1.5 last:pr-4", column(role.id))}>
                    <span className="flex h-8 items-center px-2">
                      <Checkbox
                        checked={on}
                        disabled={!manage}
                        aria-label={`${toolWords[tool].label} for ${role.name}`}
                        onChange={() => onToggle(role.id, tool, !on)}
                      />
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
