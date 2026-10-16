import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Page } from "~/components/page";
import { cn } from "~/lib/cn";
import { Label } from "./label";
import { Switch } from "./ui/toggle";

export interface NavSection {
  id: string;
  label: string;
  group?: string;
}

/** The secondary navigation: a quiet list of sections at the left, grouped, that stays put while the page scrolls. */
export function SideNav({
  sections,
  current,
  link,
  label = "Sections",
}: {
  sections: NavSection[];
  current: string;
  /** Where each section lives. */
  link: (id: string) => {
    to: string;
    params?: Record<string, string> | ((p: Record<string, string>) => Record<string, string>);
    search?: Record<string, string>;
  };
  label?: string;
}) {
  const groups = [...new Set(sections.map((s) => s.group ?? ""))];
  return (
    <nav
      aria-label={label}
      className="scroll-quiet flex shrink-0 gap-1 overflow-x-auto @3xl/app:sticky @3xl/app:top-8 @3xl/app:w-[200px] @3xl/app:flex-col @3xl/app:self-start @3xl/app:overflow-visible"
    >
      {groups.map((g) => (
        <div key={g} className="flex shrink-0 gap-1 @3xl/app:mb-4 @3xl/app:flex-col">
          {g && <span className="eyebrow hidden px-2 pb-1 @3xl/app:block">{g}</span>}
          {sections
            .filter((s) => (s.group ?? "") === g)
            .map((s) => {
              const l = link(s.id);
              return (
                <Link
                  key={s.id}
                  to={l.to}
                  params={l.params}
                  search={l.search}
                  aria-current={s.id === current ? "page" : undefined}
                  className={cn(
                    "flex h-8 shrink-0 items-center rounded-control px-2.5 text-[14px] whitespace-nowrap transition-colors",
                    s.id === current
                      ? "bg-raised text-ink shadow-1"
                      : "text-ink-2 hover:bg-raised/60 hover:text-ink",
                  )}
                >
                  {s.label}
                </Link>
              );
            })}
        </div>
      ))}
    </nav>
  );
}

/** The secondary nav beside the content; on a phone the nav is a row above it. */
export function Split({ nav, children }: { nav: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6 @3xl/app:flex-row @3xl/app:gap-12">
      {nav}
      <div className="flex min-w-0 flex-1 flex-col gap-10">{children}</div>
    </div>
  );
}

/** Settings pages share one shape: the sections at the left, the current one's heading and rows at the right. */
export function SettingsLayout({
  sections,
  current,
  base,
  param,
  search,
  children,
  title,
  intro,
}: {
  sections: NavSection[];
  current: string;
  /** The route, with `$section` for the section. */
  base: string;
  param: string;
  /** When the section is carried in the query string rather than the path. */
  search?: boolean;
  children: ReactNode;
  title: string;
  intro?: string;
}) {
  return (
    <Page className="gap-6 @3xl/app:flex-row @3xl/app:gap-12">
      <SideNav
        sections={sections}
        current={current}
        link={(id) =>
          search
            ? { to: base, params: (p: Record<string, string>) => p, search: { [param]: id } }
            : { to: base, params: { [param]: id } }
        }
      />
      <div className="flex min-w-0 flex-1 flex-col gap-10">
        <div>
          <h1 className="title">{title}</h1>
          {intro && <p className="mt-1.5 max-w-[620px] text-[14px] text-ink-2">{intro}</p>}
        </div>
        {children}
      </div>
    </Page>
  );
}

export function Section({
  title,
  intro,
  children,
  action,
}: {
  title: string;
  intro?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-medium text-ink">{title}</h2>
          {intro && <p className="mt-0.5 max-w-[620px] text-[13px] text-ink-3">{intro}</p>}
        </div>
        {action}
      </div>
      <div className="flex flex-col divide-y divide-line rounded-panel-lg border border-line bg-raised/25 shadow-1">
        {children}
      </div>
    </section>
  );
}

/** One setting: a name, what it does, and its control on the right. */
export function Row({
  name,
  hint,
  children,
  stacked = false,
}: {
  name: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
  stacked?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex gap-4 px-4 py-row",
        stacked
          ? "flex-col"
          : "flex-col @3xl/app:flex-row @3xl/app:items-center @3xl/app:justify-between",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[14px] text-ink">{name}</div>
        {hint && <div className="mt-0.5 text-[13px] text-ink-3">{hint}</div>}
      </div>
      {children && (
        <div className={cn("flex shrink-0 items-center gap-2", stacked && "w-full")}>
          {children}
        </div>
      )}
    </div>
  );
}

export function SwitchRow({
  name,
  hint,
  checked,
  onChange,
}: {
  name: string;
  hint?: string;
  checked: boolean;
  onChange?: (v: boolean) => void;
}) {
  return (
    <Row name={name} hint={hint}>
      <Switch label={name} checked={checked} onChange={onChange ?? (() => {})} />
    </Row>
  );
}

/** A grid of what each role (or person) may do: rows are the things, columns the roles. */
export function Matrix({
  heading = "Permission",
  columns,
  rows,
  value,
  onToggle,
  locked,
}: {
  heading?: string;
  columns: { id: string; label: string }[];
  rows: { id: string; label: string; hint?: string }[];
  value: (row: string, column: string) => boolean;
  onToggle?: (row: string, column: string) => void;
  /** Cells that cannot change, with why. */
  locked?: (row: string, column: string) => string | null;
}) {
  return (
    <div className="scroll-quiet overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className="w-[40%] px-4 py-2 text-left">
              <Label>{heading}</Label>
            </th>
            {columns.map((c) => (
              <th key={c.id} className="px-2 py-2 text-center">
                <Label>{c.label}</Label>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-line">
              <td className="px-4 py-2">
                <div className="text-ink">{r.label}</div>
                {r.hint && <div className="text-[12px] text-ink-3">{r.hint}</div>}
              </td>
              {columns.map((c) => {
                const on = value(r.id, c.id);
                const why = locked?.(r.id, c.id) ?? null;
                return (
                  <td key={c.id} className="px-2 py-2 text-center">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      aria-label={`${r.label} for ${c.label}`}
                      title={why ?? undefined}
                      disabled={Boolean(why)}
                      onClick={() => onToggle?.(r.id, c.id)}
                      className={cn(
                        "inline-flex size-5 items-center justify-center rounded-chip border transition-colors",
                        on
                          ? "border-signal bg-signal text-ground"
                          : "border-line-strong bg-ground/40 text-transparent hover:border-edge-strong",
                        why && "cursor-not-allowed opacity-50",
                      )}
                    >
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M3 8.5 L6.5 12 L13 4.5" />
                      </svg>
                    </button>
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

/** A danger zone: things that cannot be undone, kept apart. */
export function Danger({ children }: { children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[16px] font-medium text-ink">Danger zone</h2>
      <div className="flex flex-col divide-y divide-line rounded-panel-lg border border-signal/30 bg-signal/[0.04]">
        {children}
      </div>
    </section>
  );
}
