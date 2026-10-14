import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { personById } from "~/data";
import { cn } from "~/lib/cn";
import { type ScreenState, useViewer } from "./context.tsx";
import { personas } from "./personas.ts";

const states: { id: ScreenState; label: string }[] = [
  { id: "normal", label: "As the data is" },
  { id: "empty", label: "Empty" },
  { id: "loading", label: "Loading" },
  { id: "processing", label: "Processing" },
  { id: "failed", label: "Failed" },
  { id: "refused", label: "Refused" },
  { id: "expired", label: "Expired" },
  { id: "long", label: "Long names and lists" },
];

/**
 * The prototype's own control, in the corner: who you are, and how the screen is shown.
 * Nothing here exists in the product.
 */
export function Switcher() {
  const viewer = useViewer();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const person = personById(viewer.personId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2"
      style={{
        right: "max(16px, env(safe-area-inset-right, 0px))",
        bottom: "max(16px, env(safe-area-inset-bottom, 0px))",
      }}
    >
      {open && (
        <div className="pointer-events-auto flex max-h-[min(80vh,640px)] w-[340px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-panel-lg border border-edge bg-overlay shadow-4">
          <div className="flex items-center gap-2 border-b border-hairline-soft px-4 py-3">
            <Label>Prototype</Label>
            <span className="text-xs text-ink-3">who you are, and how it is shown</span>
            <button
              type="button"
              aria-label="Close"
              onClick={() => setOpen(false)}
              className="ml-auto flex size-7 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <fieldset className="m-0 border-0 p-2">
              <legend className="label px-2 pt-2 pb-1">You are</legend>
              {personas.map((p) => {
                const who = personById(p.personId);
                const active = viewer.persona.id === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => {
                      viewer.setPersona(p.id);
                      navigate({ to: p.home });
                    }}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-control px-2 py-1.5 text-left hover:bg-raised",
                      active && "bg-raised shadow-1",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-[7px] size-[7px] shrink-0 rounded-full border-[1.5px]",
                        active ? "border-signal bg-signal" : "border-ink-3",
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="text-[13px] font-medium text-ink">{p.label}</span>
                        <span className="truncate text-xs text-ink-3">{who.name}</span>
                      </span>
                      <span className="block text-xs leading-[17px] text-ink-2">{p.summary}</span>
                    </span>
                  </button>
                );
              })}
            </fieldset>
            <div className="flex flex-col gap-3 border-t border-hairline-soft p-4">
              <label className="flex items-center justify-between gap-4 text-[13px] text-ink-2">
                <span>
                  Shadows for what floats
                  <span className="block text-xs text-ink-3">
                    Off: the brand's current rule, a step up the surface scale
                  </span>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={viewer.settings.shadows}
                  aria-checked={viewer.settings.shadows}
                  onChange={(e) => viewer.setSettings({ shadows: e.target.checked })}
                  className="peer sr-only"
                />
                <span
                  aria-hidden="true"
                  className={cn(
                    "relative h-[18px] w-8 shrink-0 rounded-full border transition-colors after:absolute after:top-[2px] after:left-[2px] after:size-3 after:rounded-full after:transition-transform",
                    viewer.settings.shadows
                      ? "border-signal bg-signal/80 after:translate-x-[14px] after:bg-ground"
                      : "border-edge bg-ground after:bg-ink-2",
                  )}
                />
              </label>
              <div className="flex items-center justify-between gap-4 text-[13px] text-ink-2">
                <span>Width</span>
                <div
                  role="radiogroup"
                  className="flex rounded-control border border-hairline bg-surface p-0.5"
                >
                  {(["desktop", "phone"] as const).map((w) => (
                    <button
                      key={w}
                      type="button"
                      role="radio"
                      aria-checked={viewer.settings.width === w}
                      onClick={() => viewer.setSettings({ width: w })}
                      className={cn(
                        "h-6 rounded-[4px] px-2.5 text-xs capitalize",
                        viewer.settings.width === w
                          ? "bg-overlay text-ink shadow-2"
                          : "text-ink-3 hover:text-ink",
                      )}
                    >
                      {w}
                    </button>
                  ))}
                </div>
              </div>
              <label className="flex items-center justify-between gap-4 text-[13px] text-ink-2">
                <span>Screen state</span>
                <select
                  value={viewer.settings.state}
                  onChange={(e) => viewer.setSettings({ state: e.target.value as ScreenState })}
                  className="h-7 rounded-control border border-edge bg-ground px-2 text-[13px] text-ink"
                >
                  {states.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        </div>
      )}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="pointer-events-auto flex h-9 items-center gap-2 rounded-full border border-edge bg-overlay pr-3 pl-1.5 text-[13px] text-ink shadow-3 hover:border-edge-strong"
      >
        <span className="flex size-6 items-center justify-center rounded-full bg-signal text-[10px] font-medium text-ground">
          {viewer.persona.label.slice(0, 1)}
        </span>
        <span className="font-medium">{viewer.persona.label}</span>
        <span className="hidden text-ink-3 @md/app:inline">{person.name}</span>
        {viewer.settings.state !== "normal" && (
          <span className="label text-signal">{viewer.settings.state}</span>
        )}
      </button>
    </div>
  );
}
