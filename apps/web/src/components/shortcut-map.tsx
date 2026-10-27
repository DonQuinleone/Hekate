import { Fragment, useEffect, useState } from "react";
import { isMac, keyCaps } from "~/lib/keys";
import { usePreferences } from "~/lib/queries";
import { type Shortcut, useShortcutGroups, useShortcuts } from "~/lib/shortcuts";
import { Dialog } from "./ui/dialog";

function Keys({ shortcut, mac }: { shortcut: Shortcut; mac: boolean }) {
  return (
    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
      {shortcut.keys.map((binding, i) => (
        <Fragment key={binding}>
          {i > 0 && <span className="text-[12px] text-ink-2">or</span>}
          {keyCaps(binding, mac).map((stroke, s) => (
            <Fragment key={`${binding}-${String(s)}`}>
              {s > 0 && <span className="text-[12px] text-ink-2">then</span>}
              {stroke.map((cap) => (
                <kbd
                  key={cap}
                  className="tabular inline-flex h-5 min-w-5 items-center justify-center rounded-chip border border-line-strong bg-raised px-1.5 font-sans text-[11px] text-ink-2"
                >
                  {cap}
                </kbd>
              ))}
            </Fragment>
          ))}
        </Fragment>
      ))}
    </span>
  );
}

/** The "?" map: every shortcut that works on this page now, by where it belongs. */
export function ShortcutMap({ onClose }: { onClose: () => void }) {
  // Help last: what belongs to the page comes first.
  const groups = [...useShortcutGroups()].sort(
    (a, b) => Number(a.id === "help") - Number(b.id === "help"),
  );
  const mac = isMac();
  return (
    <Dialog
      title="Keyboard shortcuts"
      description="What works on this page. None of them fire while you type in a field."
      onClose={onClose}
      width="md"
    >
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a list that scrolls must be reachable by keyboard (WCAG 2.1.1). */}
      <div tabIndex={0} className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto outline-none">
        {groups.map((group) => (
          <section key={group.id} aria-label={group.title}>
            <h3 className="eyebrow m-0 pb-1.5 text-ink-2">{group.title}</h3>
            <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
              {group.shortcuts.map((s) => (
                <li key={s.label} className="flex items-center gap-3 py-1.5">
                  <span className="min-w-0 flex-1 text-[13px] text-ink">
                    {s.label}
                    {s.where && <span className="block text-[12px] text-ink-2">{s.where}</span>}
                  </span>
                  <Keys shortcut={s} mac={mac} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

const OPEN = "hekate:shortcuts";

/** Open the map from anywhere, such as the Help menu. */
export const openShortcutMap = () => window.dispatchEvent(new Event(OPEN));

/**
 * Holds the map on every page: "?" opens it, as does the Help menu. Someone who turned off
 * "Keyboard map on ?" in Account, Appearance, opens it from the Help menu alone.
 */
export function ShortcutMapHost() {
  const [open, setOpen] = useState(false);
  const { keyboardMapOnQuestion } = usePreferences();
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN, show);
    return () => window.removeEventListener(OPEN, show);
  }, []);
  useShortcuts("help", "Help", [
    ...(keyboardMapOnQuestion
      ? [{ keys: ["?"], label: "Show keyboard shortcuts", run: () => setOpen(true) }]
      : []),
    { keys: ["Escape"], label: "Close a dialog, menu or sheet" },
  ]);
  return open ? <ShortcutMap onClose={() => setOpen(false)} /> : null;
}
