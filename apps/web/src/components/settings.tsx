import {
  type DateFormat,
  dateFormatLabels,
  dateFormats,
  formatDate,
  formatTime,
  type TimeFormat,
  timeFormatLabels,
  timeFormats,
} from "@hekate/shared";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Page } from "~/components/page";
import { cn } from "~/lib/cn";
import { docsUrl } from "~/lib/links";
import { Icon } from "./icons";
import { Button } from "./ui/button";
import { Switch } from "./ui/toggle";

export interface NavSection {
  id: string;
  label: string;
  group?: string;
}

/** One afternoon, shown in each format so the choice reads as it will look (#481). */
const SAMPLE = new Date("2026-10-29T14:05:00Z");

/** Each date format as a choice, with its example: "Day, month, year (29 Oct 2026)". */
export const dateFormatChoices: { value: DateFormat; label: string }[] = dateFormats.map((f) => ({
  value: f,
  label: `${dateFormatLabels[f]} (${formatDate(f, SAMPLE, { timeZone: "UTC" })})`,
}));

/** Each time format as a choice, with its example: "12-hour (2:05 pm)". */
export const timeFormatChoices: { value: TimeFormat; label: string }[] = timeFormats.map((f) => ({
  value: f,
  label: `${timeFormatLabels[f]} (${formatTime(f, SAMPLE, { timeZone: "UTC" })})`,
}));

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
  docs,
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
  /** Where the documentation explains this section, as a path on the docs site. */
  docs?: string;
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
          {(intro || docs) && (
            <p className="mt-1.5 max-w-[620px] text-[14px] text-ink-2">
              {intro}
              {docs && (
                <>
                  {intro && " "}
                  <a
                    href={`${docsUrl}${docs}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-ink-2 underline decoration-edge underline-offset-2 transition-colors hover:text-ink hover:decoration-ink-3"
                  >
                    How this works
                  </a>
                </>
              )}
            </p>
          )}
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
  panelId,
}: {
  title: string;
  intro?: string;
  /** Its rows; a section without them is its heading alone, as a folded one is. */
  children?: ReactNode;
  action?: ReactNode;
  /** The rows' panel, for a control that shows and hides it. */
  panelId?: string;
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
      {children ? (
        <div
          id={panelId}
          className="flex flex-col divide-y divide-line rounded-panel-lg border border-line bg-raised/25 shadow-1"
        >
          {children}
        </div>
      ) : null}
    </section>
  );
}

/**
 * A section that folds to its heading and a line saying how it stands (decision 287): for what
 * matters less in this place, such as video settings in a project with no video. Nothing is
 * hidden for good; Show opens it.
 */
export function FoldingSection({
  id,
  title,
  intro,
  summary,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  intro?: string;
  /** What a folded section says in place of its rows. */
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const toggle = (
    <Button
      variant="ghost"
      size="sm"
      aria-expanded={open}
      aria-controls={id}
      aria-label={`${open ? "Hide" : "Show"} ${title.toLowerCase()}`}
      onClick={onToggle}
    >
      {open ? "Hide" : "Show"}
      <Icon
        name="chevronDown"
        size={12}
        className={cn("text-ink-3 transition-transform", open && "rotate-180")}
      />
    </Button>
  );
  // Folded, it is one line: its heading, how it stands, and Show.
  if (!open)
    return (
      <section className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h2 className="text-[16px] font-medium text-ink">{title}</h2>
          <p className="m-0 text-[13px] text-ink-3">{summary}</p>
        </div>
        {toggle}
      </section>
    );
  return (
    <Section title={title} intro={intro} panelId={id} action={toggle}>
      {children}
    </Section>
  );
}

/** One setting: a name, what it does, and its control on the right. */
export function Row({
  name,
  hint,
  children,
  stacked = false,
  inline = false,
}: {
  name: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
  stacked?: boolean;
  /** Its control stays beside it even on a phone: a menu, say. */
  inline?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex gap-4 px-4 py-row",
        stacked
          ? "flex-col"
          : inline
            ? "flex-row items-center justify-between"
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
  disabled = false,
}: {
  name: string;
  hint?: string;
  checked: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Row name={name} hint={hint} inline>
      <Switch
        label={name}
        checked={checked}
        onChange={onChange ?? (() => {})}
        disabled={disabled}
      />
    </Row>
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
