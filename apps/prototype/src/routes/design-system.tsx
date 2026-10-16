import { type ReactNode, useState } from "react";
import { Avatar, AvatarRow } from "~/components/avatar";
import { Lockup, Mark, Wordmark } from "~/components/brand";
import { Icon, type IconName } from "~/components/icons";
import { Kbd, Label } from "~/components/label";
import { Card, SectionHead } from "~/components/page";
import { Row, Section } from "~/components/settings";
import { Dot, type DotState } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Input, Select, Textarea } from "~/components/ui/input";
import { Dropdown } from "~/components/ui/menu";
import { Switch } from "~/components/ui/toggle";
import { cn } from "~/lib/cn";
import { Empty } from "~/viewer/state-gate";

/* ---------- The brand ---------- */

const colours: { token: string; name: string; use: string; className: string }[] = [
  {
    token: "canvas",
    name: "Canvas",
    use: "Behind everything; the window itself",
    className: "bg-canvas",
  },
  {
    token: "ground",
    name: "Ground",
    use: "The sidebar and the phone frame",
    className: "bg-ground",
  },
  { token: "pane", name: "Pane", use: "The lifted page", className: "bg-pane" },
  { token: "raised", name: "Raised", use: "Cards, hovered rows, chips", className: "bg-raised" },
  {
    token: "overlay",
    name: "Overlay",
    use: "Menus, dialogs, the palette",
    className: "bg-overlay",
  },
  {
    token: "line",
    name: "Line",
    use: "Hairlines between rows and around cards",
    className: "bg-line",
  },
  { token: "edge", name: "Edge", use: "Borders on controls", className: "bg-edge" },
  { token: "ink", name: "Ink", use: "Text, icons, the strongest mark", className: "bg-ink" },
  { token: "ink-2", name: "Ink 2", use: "Secondary text", className: "bg-ink-2" },
  { token: "ink-3", name: "Ink 3", use: "Hints, placeholders, eyebrows", className: "bg-ink-3" },
  {
    token: "signal",
    name: "Signal",
    use: "The one accent: a primary action, an alert, a count",
    className: "bg-signal",
  },
  {
    token: "paper",
    name: "Paper",
    use: "Scores and documents on a light ground",
    className: "bg-paper",
  },
];

const type: { name: string; className: string; use: string; sample: string }[] = [
  { name: "Title", className: "title", use: "One per page", sample: "Album review" },
  {
    name: "Heading",
    className: "text-[18px] font-medium tracking-tight text-ink",
    use: "A band or a workflow",
    sample: "Needs attention",
  },
  {
    name: "Section",
    className: "text-[16px] font-medium text-ink",
    use: "A settings section",
    sample: "Access permissions",
  },
  {
    name: "Body",
    className: "text-[14px] text-ink",
    use: "Rows, labels, copy",
    sample: "Mira requested changes at bar 12.",
  },
  {
    name: "Secondary",
    className: "text-[13px] text-ink-2",
    use: "Hints and details",
    sample: "Due in 5 days · 3 versions",
  },
  {
    name: "Small",
    className: "text-[12px] text-ink-3",
    use: "Timestamps, counts, captions",
    sample: "19 minutes ago",
  },
  {
    name: "Eyebrow",
    className: "eyebrow",
    use: "A quiet heading over a group",
    sample: "Waiting on you",
  },
  {
    name: "Tabular",
    className: "tabular text-[14px] text-ink",
    use: "Numbers that align: times, counts, keys",
    sample: "00:02:41.08 · JR-14",
  },
];

const spacing = [
  { name: "Page", value: "40 px sides, 32 px top, 32 px between sections (20 and 24 on a phone)" },
  { name: "Section", value: "12 px between a heading and its card" },
  { name: "Row", value: "16 px sides, 12 px top and bottom; 8 px between a name and its hint" },
  { name: "Controls", value: "8 px between a row's controls; 6 px between chips" },
  {
    name: "Heights",
    value: "Controls 32 px (small 28 px, large 36 px); rows 40 px; nav items 32 px",
  },
  {
    name: "Radii",
    value: "Chips 4 px, controls 6 px, panels 8 px, large panels 12 px, the stage 16 px",
  },
  {
    name: "Width",
    value: "Pages run to 1360 px; narrow pages to 860 px; dialogs 420, 560, 760 or 960 px",
  },
];

const iconSample: IconName[] = [
  "search",
  "plus",
  "check",
  "close",
  "more",
  "upload",
  "download",
  "folder",
  "file",
  "track",
  "music",
  "film",
  "score",
  "mic",
  "take",
  "user",
  "users",
  "comment",
  "review",
  "board",
  "task",
  "calendar",
  "bell",
  "settings",
  "play",
  "pause",
  "loop",
  "compare",
  "shield",
  "bolt",
];

function Swatch({ c }: { c: (typeof colours)[number] }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <span className={cn("size-8 shrink-0 rounded-control border border-line", c.className)} />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-ink">{c.name}</span>
        <span className="block truncate text-[12px] text-ink-3">{c.use}</span>
      </span>
      <code className="tabular text-[12px] text-ink-3">--hk-{c.token}</code>
    </div>
  );
}

export function BrandSection() {
  return (
    <>
      <Section
        title="The mark"
        intro="Two stems and a point. The SVG in the repository is the source of truth; everything else is cut from it."
        action={
          <Button variant="secondary" size="md">
            <Icon name="download" size={14} />
            Download the pack
          </Button>
        }
      >
        <div className="grid gap-px bg-line @3xl/app:grid-cols-2">
          <div className="flex flex-col items-start gap-4 bg-ground px-6 py-6">
            <Lockup size={28} />
            <div className="flex items-center gap-6">
              <Mark size={40} />
              <Mark size={24} />
              <Mark size={16} />
              <Wordmark height={16} />
            </div>
            <span className="text-[12px] text-ink-3">
              On the dark ground: ink mark, ink wordmark
            </span>
          </div>
          <div className="flex flex-col items-start gap-4 bg-paper px-6 py-6 text-ground">
            <span className="flex items-center gap-2">
              <Mark size={28} mono />
              <span className="text-[22px] font-medium tracking-tight">Hekate</span>
            </span>
            <div className="flex items-center gap-6">
              <Mark size={40} mono />
              <Mark size={24} mono />
              <Mark size={16} mono />
            </div>
            <span className="text-[12px] text-ground/60">
              On paper: the mono mark, never the signal colour
            </span>
          </div>
        </div>
        <Row name="Clear space" hint="Keep a square the height of the mark free on every side." />
        <Row
          name="Smallest size"
          hint="The mark at 16 px, the lockup at 18 px; below that use the mark alone."
        />
        <Row
          name="Never"
          hint="Rotate it, recolour it, put it in a circle, or set it in another face."
        />
      </Section>
      <Section
        title="Colour"
        intro="Near-black ground, hairlines over cards, type doing the work, one signal colour used sparingly. Every colour is a token; nothing is hard-coded."
      >
        <div className="grid divide-y divide-line @3xl/app:grid-cols-2 @3xl/app:divide-x @3xl/app:divide-y-0">
          <div className="divide-y divide-line">
            {colours.slice(0, 6).map((c) => (
              <Swatch key={c.token} c={c} />
            ))}
          </div>
          <div className="divide-y divide-line">
            {colours.slice(6).map((c) => (
              <Swatch key={c.token} c={c} />
            ))}
          </div>
        </div>
        <Row
          name="Status"
          hint="States are dots and words, not fills: a filled dot for done, a hollow one for waiting, signal for what needs a person."
        >
          <span className="flex items-center gap-3 text-[12px] text-ink-2">
            {(
              [
                ["approved", "done"],
                ["in_review", "in review"],
                ["changes_requested", "changes"],
                ["waiting", "waiting"],
                ["working", "working"],
              ] as [DotState, string][]
            ).map(([s, l]) => (
              <span key={s} className="flex items-center gap-1.5">
                <Dot state={s} />
                {l}
              </span>
            ))}
          </span>
        </Row>
      </Section>
      <Section
        title="Type"
        intro="One face, Schibsted Grotesk, at one scale. No monospace outside code and timecodes."
      >
        {type.map((t) => (
          <div
            key={t.name}
            className="grid items-baseline gap-3 px-4 py-2.5 @3xl/app:grid-cols-[120px_minmax(0,1fr)_200px]"
          >
            <span className="text-[12px] text-ink-3">{t.name}</span>
            <span className={cn("truncate", t.className)}>{t.sample}</span>
            <span className="hidden text-[12px] text-ink-3 @3xl/app:block">{t.use}</span>
          </div>
        ))}
      </Section>
      <Section title="Space and shape" intro="Everything sits on a 4 px grid.">
        {spacing.map((s) => (
          <Row key={s.name} name={s.name} hint={s.value} />
        ))}
      </Section>
      <Section
        title="Icons"
        intro="Lucide, at one 1.5 px stroke, named for what each means in Hekate. Icons carry meaning on their own: a track is bars, a folder is a folder, never a label saying what the icon already says."
      >
        <div className="flex flex-wrap gap-1 px-4 py-3">
          {iconSample.map((i) => (
            <span
              key={i}
              title={i}
              className="flex size-9 items-center justify-center rounded-control text-ink-2 hover:bg-raised hover:text-ink"
            >
              <Icon name={i} size={16} />
            </span>
          ))}
        </div>
      </Section>
    </>
  );
}

/* ---------- The components ---------- */

function Spec({
  name,
  rule,
  children,
  stacked = false,
}: {
  name: string;
  rule: string;
  children: ReactNode;
  stacked?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid gap-3 px-4 py-4",
        stacked ? "" : "@3xl/app:grid-cols-[220px_minmax(0,1fr)]",
      )}
    >
      <div>
        <div className="text-[14px] text-ink">{name}</div>
        <div className="mt-0.5 text-[13px] text-ink-3">{rule}</div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function ComponentsSection() {
  const [on, setOn] = useState(true);
  return (
    <>
      <Section
        title="Actions"
        intro="One primary action per view, at the top right of the bar or the foot of a dialog. Everything else is secondary, ghost or quiet."
      >
        <Spec
          name="Button"
          rule="Primary for the one thing to do; secondary beside it; ghost in toolbars and rows; quiet for icon-only. Sentence case, a verb, no trailing punctuation."
        >
          <Button variant="primary">Request a review</Button>
          <Button variant="secondary">Share</Button>
          <Button variant="ghost">Export</Button>
          <Button variant="quiet" size="icon" aria-label="More">
            <Icon name="more" size={16} />
          </Button>
          <Button variant="primary" size="sm">
            <Icon name="plus" size={13} />
            Node
          </Button>
        </Spec>
        <Spec
          name="Menu"
          rule="Row actions live in a hover or a three-dot menu, never as repeated links. Destructive items last, after a divider, in signal."
        >
          <Dropdown
            value="Album review"
            actions={[
              { label: "Rename", onSelect: () => {} },
              { label: "Duplicate", onSelect: () => {} },
              "divider",
              { label: "Delete", danger: true, onSelect: () => {} },
            ]}
          />
        </Spec>
        <Spec
          name="Keys"
          rule="Every shortcut uses the key people expect and is shown where it applies, in a key cap."
        >
          <span className="flex items-center gap-1.5 text-[13px] text-ink-2">
            <Kbd>⌘K</Kbd> palette <Kbd>/</Kbd> search <Kbd>[</Kbd> sidebar <Kbd>space</Kbd> play
          </span>
        </Spec>
      </Section>
      <Section
        title="Inputs"
        intro="Labels above, in secondary ink; hints below. Validation sits under the field in signal; never a red border alone."
      >
        <Spec
          name="Text"
          rule="32 px tall, 14 px type, the raised ground. Placeholder text is an example, not a label."
        >
          <Input placeholder="Masters at 96 kHz" className="w-56" />
          <Select defaultValue="Producer" className="w-40">
            <option>Producer</option>
            <option>Engineer</option>
          </Select>
        </Spec>
        <Spec name="Long text" rule="Grows with its content up to a point, then scrolls.">
          <Textarea placeholder="Notes for the engineer" className="h-20 w-full max-w-[420px]" />
        </Spec>
        <Spec
          name="Switch and checkbox"
          rule="A switch for a setting that takes effect at once; a checkbox inside a form or a list of things to pick."
        >
          <Switch label="Example" checked={on} onChange={setOn} />
          <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
            <input type="checkbox" defaultChecked /> On upload
          </label>
        </Spec>
        <Spec
          name="Segmented"
          rule="For two to four views of the same thing: board, timeline, calendar. Tabs for a third level of navigation only."
        >
          <div
            role="tablist"
            className="flex h-8 items-center rounded-control border border-line bg-raised/40 p-0.5"
          >
            {["Basic", "Advanced", "Code"].map((t, i) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={i === 1}
                className={cn(
                  "h-7 rounded-[7px] px-2.5 text-[13px] leading-7",
                  i === 1 ? "bg-raised text-ink shadow-1" : "text-ink-3",
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </Spec>
      </Section>
      <Section
        title="Surfaces"
        intro="Hairlines over cards and shadows. A card groups rows; a dialog holds one task; a slide-over holds one thing's details."
      >
        <Spec
          name="Card and rows"
          rule="A card is a bordered panel on the raised ground; rows inside it divide by hairline and read name, hint, control."
        >
          <Card className="w-full max-w-[460px] divide-y divide-line">
            <Row name="Name" hint="What people see">
              <Input defaultValue="Joplin Rags" className="w-40" />
            </Row>
            <Row name="Profile" hint="Only decides which tools appear">
              <Select defaultValue="Music" className="w-32">
                <option>Music</option>
              </Select>
            </Row>
          </Card>
        </Spec>
        <Spec
          name="Section head"
          rule="A title, a count or hint, and at most one action at the right."
        >
          <div className="w-full max-w-[460px]">
            <SectionHead
              title="Tracks"
              hint="5"
              action={
                <Button variant="ghost" size="sm">
                  All files
                </Button>
              }
            />
          </div>
        </Spec>
        <Spec
          name="Stat tile"
          rule="A label, one figure, one line under it. Signal only when the figure needs a person."
        >
          <div className="grid w-full max-w-[460px] grid-cols-2 gap-px overflow-hidden rounded-panel-lg border border-line bg-line">
            {[
              ["Tracks approved", "1 of 3", "2 without a version", false],
              ["Open tasks", "3", "1 overdue", true],
            ].map(([l, v, h, flag]) => (
              <div key={String(l)} className="bg-raised/25 px-4 py-3">
                <div className="text-[12px] text-ink-3">{l}</div>
                <div
                  className={cn(
                    "tabular mt-1 text-[26px] leading-none font-medium",
                    flag ? "text-signal" : "text-ink",
                  )}
                >
                  {v}
                </div>
                <div className="mt-1.5 text-[12px] text-ink-3">{h}</div>
              </div>
            ))}
          </div>
        </Spec>
        <Spec
          name="Empty state"
          rule="Says what the place is for and what to do next, with the one action that does it."
        >
          <div className="w-full max-w-[460px] rounded-panel-lg border border-dashed border-line">
            <Empty
              title="No reviews yet"
              text="Ask someone to approve or give feedback on a version."
              action={<Button variant="primary">Request a review</Button>}
            />
          </div>
        </Spec>
      </Section>
      <Section
        title="Identity and status"
        intro="People are avatars with initials; things are icons; states are dots. Names appear once per row."
      >
        <Spec
          name="Avatar"
          rule="Initials on a tinted ground; 20 px in lists, 28 px in headers; a row of them overlaps by a quarter and stops at four."
        >
          <Avatar personId="p-alex" size={28} />
          <Avatar personId="p-mira" size={20} />
          <AvatarRow personIds={["p-alex", "p-tomas", "p-ines", "p-mira"]} />
        </Spec>
        <Spec
          name="Chip"
          rule="A small bordered pill for a tag, a count or a filter. Never for a type the icon already shows."
        >
          <span className="rounded-chip border border-line px-1.5 text-[11px] leading-5 text-ink-3">
            delivery
          </span>
          <span className="rounded-chip border border-line px-1.5 text-[11px] leading-5 text-ink-3">
            custom
          </span>
          <span className="tabular rounded-full bg-signal px-1.5 text-[11px] leading-[18px] font-medium text-ground">
            2
          </span>
        </Spec>
        <Spec
          name="Labels"
          rule="Eyebrows head groups; a count sits after the label in small tabular figures."
        >
          <span className="flex items-center gap-2">
            <Label>Waiting on you</Label>
            <span className="tabular text-[12px] text-ink-3">2</span>
          </span>
        </Spec>
      </Section>
      <Section
        title="Navigation"
        intro="The sidebar holds the primary level; a page with sections keeps a list at the left; tabs are for a third level. Every page declares a trail and at most one row of actions."
      >
        <Spec
          name="Sidebar item"
          rule="Icon, label, an optional count at the right. The active item is lifted; hover tints."
        >
          <div className="flex w-56 flex-col gap-0.5 rounded-panel bg-ground p-2">
            {[
              ["dashboard", "Overview", "", true],
              ["folder", "Files", "", false],
              ["review", "Reviews", "4", false],
            ].map(([i, l, n, active]) => (
              <span
                key={String(l)}
                className={cn(
                  "flex h-8 items-center gap-2.5 rounded-control px-2.5 text-[14px]",
                  active ? "bg-raised text-ink shadow-1" : "text-ink-2",
                )}
              >
                <Icon name={i as IconName} />
                <span className="flex-1">{l}</span>
                {n && <span className="tabular text-[12px] text-ink-3">{n}</span>}
              </span>
            ))}
          </div>
        </Spec>
        <Spec
          name="Secondary list"
          rule="200 px wide, grouped by eyebrow, sticky while the page scrolls."
        >
          <div className="flex w-48 flex-col gap-1">
            <span className="eyebrow px-2 pb-1">Project</span>
            {["General", "Comments", "Roles and access"].map((l, i) => (
              <span
                key={l}
                className={cn(
                  "h-8 rounded-control px-2.5 text-[14px] leading-8",
                  i === 2 ? "bg-raised text-ink shadow-1" : "text-ink-2",
                )}
              >
                {l}
              </span>
            ))}
          </div>
        </Spec>
        <Spec
          name="Trail"
          rule="Crumbs in small secondary ink, slashes between, the page's own name last and in ink."
        >
          <span className="flex items-center gap-1.5 text-[13px]">
            <span className="text-ink-3">Joplin Rags</span>
            <span className="text-edge">/</span>
            <span className="text-ink-3">Settings</span>
            <span className="text-edge">/</span>
            <span className="font-medium text-ink">Workflows</span>
          </span>
        </Spec>
      </Section>
      <Section
        title="Motion and feedback"
        intro="Menus and dialogs rise in over 160 ms; nothing bounces. A toast confirms what just happened and leaves on its own."
      >
        <Spec
          name="Toast"
          rule="One line, at the foot of the pane, gone in under three seconds; never for errors a person has to act on."
        >
          <span className="rounded-panel bg-overlay px-4 py-2 text-[13px] text-ink shadow-4">
            Copied.
          </span>
        </Spec>
        <Spec
          name="Problem"
          rule="Inline, next to what is wrong, with the fix in the sentence. Signal border for errors; a plain card for warnings."
        >
          <span className="rounded-panel border border-signal/40 bg-signal/10 px-3 py-2 text-[12px] text-ink">
            “Engineer edits” is an action with nothing before it. An action never starts a workflow.
          </span>
        </Spec>
      </Section>
    </>
  );
}
