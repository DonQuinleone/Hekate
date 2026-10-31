import { frameRates, loudnessGauge } from "@hekate/shared";
import { type ReactNode, useState } from "react";
import { Avatar, AvatarRow } from "~/components/avatar";
import { Lockup, Mark, Wordmark } from "~/components/brand";
import { DrawingMarks, DrawToolbar } from "~/components/drawings";
import { Empty } from "~/components/empty";
import { LinkedFiles } from "~/components/file-picker";
import { Icon, type IconName, iconNames } from "~/components/icons";
import { Kbd } from "~/components/kbd";
import { Card, Page, SectionHead } from "~/components/page";
import { Crop, Gauge, Verdict } from "~/components/qa-report";
import { FoldingSection, Row, Section, SwitchRow } from "~/components/settings";
import { StatusChipView } from "~/components/status-chip";
import { Button } from "~/components/ui/button";
import { Chip, Count, ToggleChip } from "~/components/ui/chip";
import { Checkbox, Choice, ChoiceCard, Radio } from "~/components/ui/choice";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { ColourInput, InlineInput, Input, Select, Textarea } from "~/components/ui/input";
import { ActionMenu, Dropdown, MenuList } from "~/components/ui/menu";
import { Segmented } from "~/components/ui/segmented";
import { Slider } from "~/components/ui/slider";
import {
  ReviewerDot,
  type ReviewerDotState,
  type ReviewState,
  StatusDot,
  StatusPill,
} from "~/components/ui/status";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Switch } from "~/components/ui/toggle";
import {
  type ChosenFile,
  ChosenList,
  UploadDialog,
  UploadZone,
} from "~/components/ui/upload-dialog";
import { FrameGuides, GoToTimecode } from "~/components/video-frame";
import { GroupLegend, KindLegend } from "~/components/workflow-kinds";
import { cn } from "~/lib/cn";
import { categoryTones } from "~/lib/comments";

/*
 * The design system as a reference for whoever builds screens: the brand, the tokens, and
 * every component in the set in each of its states. It is never part of a release: the
 * router adds it only in development and in the build the visual suite captures.
 */

const colours: { token: string; use: string; className: string }[] = [
  { token: "canvas", use: "Behind everything; the window itself", className: "bg-canvas" },
  { token: "ground", use: "The sidebar and the phone frame", className: "bg-ground" },
  { token: "pane", use: "The lifted page", className: "bg-pane" },
  { token: "raised", use: "Cards, hovered rows, chips", className: "bg-raised" },
  { token: "overlay", use: "Menus, dialogs, the palette", className: "bg-overlay" },
  { token: "line", use: "Hairlines between rows and around cards", className: "bg-line" },
  { token: "edge", use: "Borders on controls", className: "bg-edge" },
  { token: "ink", use: "Text, icons, the strongest mark", className: "bg-ink" },
  { token: "ink-2", use: "Secondary text", className: "bg-ink-2" },
  { token: "ink-3", use: "Hints, placeholders, eyebrows", className: "bg-ink-3" },
  {
    token: "signal",
    use: "The one accent: a primary action, an alert, a count",
    className: "bg-signal",
  },
  { token: "paper", use: "Scores and documents on a light ground", className: "bg-paper" },
];

const type: { name: string; className: string; use: string; sample: string }[] = [
  { name: "Title", className: "title", use: "One per page", sample: "Album review" },
  {
    name: "Heading",
    className: "text-[18px] font-medium tracking-tight text-ink",
    use: "A band on a page",
    sample: "Needs attention",
  },
  {
    name: "Section",
    className: "text-[16px] font-medium text-ink",
    use: "A settings section",
    sample: "Reviewer permissions",
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

const spacing: [string, string][] = [
  ["Page", "40 px sides, 32 px top, 32 px between sections (20 and 24 on a phone)"],
  ["Section", "12 px between a heading and its card"],
  ["Row", "16 px sides, 12 px top and bottom; the hint 2 px under the name"],
  ["Controls", "8 px between a row's controls; 6 px between chips"],
  ["Heights", "Buttons 32 px (small 28, large 36); fields 36 px (small 28); nav items 32 px"],
  ["Radii", "Chips 4 px, controls 6 px, panels 8 px, large panels 12 px"],
  ["Width", "Pages run to 1360 px; narrow pages to 860 px; dialogs 420, 560, 760 or 960 px"],
];

const states: ReviewState[] = [
  "in_review",
  "changes_requested",
  "approved",
  "submitted",
  "cancelled",
];

/** Files on an upload dialog's list, one in each state it can be in. */
const chosenFiles: ChosenFile<string>[] = [
  {
    key: "dry",
    name: "Maple Leaf Rag - V3 dry.wav",
    size: 52_400_000,
    file: null,
    folder: "",
    state: "waiting",
    share: 0,
    error: null,
    result: null,
  },
  {
    key: "wet",
    name: "Maple Leaf Rag - V3 wet.wav",
    size: 52_400_000,
    file: null,
    folder: "",
    state: "sending",
    share: 0.42,
    error: null,
    result: null,
  },
  {
    key: "edl",
    name: "Maple Leaf Rag - V3.edl",
    size: 4_100,
    file: null,
    folder: "",
    state: "sent",
    share: 1,
    error: null,
    result: "edl",
  },
  {
    key: "score",
    name: "Maple Leaf Rag - Score.pdf",
    size: 2_300_000,
    file: null,
    folder: "",
    state: "failed",
    share: 0,
    error: "The connection dropped",
    result: null,
  },
];

/** An upload that goes nowhere, for the live dialog here: it takes two seconds and succeeds. */
const pretendToSend = (file: File, onProgress: (share: number) => void, signal: AbortSignal) =>
  new Promise<string>((resolve, reject) => {
    let share = 0;
    const tick = setInterval(() => {
      share = Math.min(1, share + 0.1);
      onProgress(share);
      if (share >= 1) {
        clearInterval(tick);
        resolve(file.name);
      }
    }, 200);
    signal.addEventListener("abort", () => {
      clearInterval(tick);
      reject(new DOMException("Upload cancelled", "AbortError"));
    });
  });

/** One component: its name and rule at the left, the component in its states at the right. */
function Spec({ name, rule, children }: { name: string; rule: string; children: ReactNode }) {
  return (
    <div className="grid gap-3 px-4 py-4 @3xl/app:grid-cols-[220px_minmax(0,1fr)]">
      <div>
        <div className="text-[14px] text-ink">{name}</div>
        <div className="mt-0.5 text-[13px] text-ink-3">{rule}</div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function Brand() {
  return (
    <>
      <Section
        title="The mark"
        intro="Two stems and a point. The SVG in brand/ is the source of truth; everything else is cut from it."
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
              On the dark ground: ink mark, signal point
            </span>
          </div>
          <div className="flex flex-col items-start gap-4 bg-paper px-6 py-6 text-ground">
            <div className="flex items-center gap-6">
              <Mark size={40} mono />
              <Mark size={24} mono />
              <Mark size={16} mono />
            </div>
            <span className="text-[12px] text-ground">
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
        intro="Near-black ground, hairlines over cards, type doing the work, one signal colour used sparingly. Every colour is a token; nothing is hard-coded. Themes change the values, never the names."
      >
        <div className="grid divide-y divide-line @3xl/app:grid-cols-2 @3xl/app:divide-x @3xl/app:divide-y-0">
          {[colours.slice(0, 6), colours.slice(6)].map((half) => (
            <div key={half[0]?.token} className="divide-y divide-line">
              {half.map((c) => (
                <div key={c.token} className="flex items-center gap-3 px-4 py-2.5">
                  <span
                    className={cn(
                      "size-8 shrink-0 rounded-control border border-line",
                      c.className,
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] text-ink">{c.token}</span>
                    <span className="block truncate text-[12px] text-ink-3">{c.use}</span>
                  </span>
                  <code className="tabular hidden text-[12px] text-ink-3 @3xl/app:block">
                    --hk-{c.token}
                  </code>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Section>
      <Section
        title="Type"
        intro="One face, Schibsted Grotesk, at one scale. No monospace outside code and timecodes."
      >
        {type.map((t) => (
          <div
            key={t.name}
            className="grid items-baseline gap-1 px-4 py-2.5 @3xl/app:grid-cols-[120px_minmax(0,1fr)_200px] @3xl/app:gap-3"
          >
            <span className="text-[12px] text-ink-3">{t.name}</span>
            <span className={cn("truncate", t.className)}>{t.sample}</span>
            <span className="hidden text-[12px] text-ink-3 @3xl/app:block">{t.use}</span>
          </div>
        ))}
      </Section>
      <Section title="Space and shape" intro="Everything sits on a 4 px grid.">
        {spacing.map(([name, value]) => (
          <Row key={name} name={name} hint={value} />
        ))}
      </Section>
      <Section
        title="Icons"
        intro="Lucide, at one 1.5 px stroke, named for what each means in Hekate. An icon carries its meaning alone: never a label saying what the icon already says."
      >
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-1 p-3">
          {iconNames.map((name) => (
            <li
              key={name}
              className="flex items-center gap-2 rounded-control px-2 py-1.5 text-ink-2"
            >
              <Icon name={name} size={16} />
              <span className="truncate text-[11px] text-ink-3">{name}</span>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

/** A programme's mark in a slot wide enough for a wordmark (Avid's), drawn lower to match. */
function MarkSlot({ name }: { name: IconName }) {
  return (
    <span className="flex w-8 shrink-0 justify-center text-ink-2">
      <Icon name={name} size={name === "avid" ? 9 : 14} />
    </span>
  );
}

function Components() {
  const [on, setOn] = useState(true);
  const [folded, setFolded] = useState(true);
  const [colour, setColour] = useState("#4fb3a9");
  const [view, setView] = useState<"list" | "grid">("list");
  const [mode, setMode] = useState<"light" | "dark" | "text">("light");
  const [level, setLevel] = useState(60);
  const [profile, setProfile] = useState("music");
  const [dialog, setDialog] = useState(false);
  const [uploading, setUploading] = useState(false);
  const noop = () => {};
  return (
    <>
      <Section
        title="Actions"
        intro="One primary action per view. Everything else is secondary, ghost or quiet. Sentence case, a verb, no trailing punctuation."
      >
        <Spec
          name="Button"
          rule="Primary for the one thing to do; secondary beside it; ghost in toolbars and rows; quiet for icon-only."
        >
          <Button variant="primary">Request a review</Button>
          <Button variant="secondary">Share</Button>
          <Button variant="ghost">Export</Button>
          <Button variant="quiet" size="icon" aria-label="More">
            <Icon name="more" size={16} />
          </Button>
        </Spec>
        <Spec
          name="Sizes"
          rule="Small in dense rows, medium by default, large where a page has room."
        >
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
          <Button variant="primary" size="sm">
            <Icon name="plus" size={13} />
            With an icon
          </Button>
        </Spec>
        <Spec name="Disabled" rule="Dimmed and inert; say nearby why, when it is not obvious.">
          <Button variant="primary" disabled>
            Request a review
          </Button>
          <Button disabled>Share</Button>
        </Spec>
        <Spec
          name="Menu"
          rule="Row actions live in a three-dot menu, never repeated links. Destructive items last, after a divider, in signal."
        >
          <Dropdown
            value="Album review"
            actions={[
              { label: "Rename", onSelect: noop },
              { label: "Duplicate", onSelect: noop },
              "divider",
              { label: "Delete", danger: true, onSelect: noop },
            ]}
          />
          <ActionMenu always label="this file" actions={[{ label: "Details", onSelect: noop }]} />
        </Spec>
        <Spec
          name="Menu with a heading"
          rule="A quiet heading names a group of items where the group says what they do, such as New role's Copy from over the roles; never over a single item."
        >
          <MenuList
            label="New role"
            onClose={noop}
            actions={[
              { label: "Blank role…", hint: "Sees files, reads comments", onSelect: noop },
              "divider",
              { heading: "Copy from" },
              { label: "Producer", onSelect: noop },
              { label: "Engineer", onSelect: noop },
            ]}
          />
        </Spec>
        <Spec
          name="Dropdown field"
          rule="In a form, where each choice is known by its mark (another programme, a provider), a dropdown drawn as a field shows it; anything else is a select. Marks sit in one slot wide enough for the widest, so the names line up."
        >
          <div className="w-60">
            <Dropdown
              variant="field"
              label="Export for"
              value={
                <>
                  <MarkSlot name="protools" />
                  Pro Tools
                </>
              }
              actions={(
                [
                  ["Pro Tools", "protools"],
                  ["Nuendo", "steinberg"],
                  ["Reaper", "reaper"],
                  ["Avid Media Composer", "avid"],
                ] as const
              ).map(([label, mark]) => ({
                label,
                icon: <MarkSlot name={mark} />,
                checked: label === "Pro Tools",
                onSelect: noop,
              }))}
            />
          </div>
        </Spec>
        <Spec
          name="Keys"
          rule="Every shortcut uses the key people expect, shown where it applies in a key cap."
        >
          <span className="flex flex-wrap items-center gap-1.5 text-[13px] text-ink-2">
            <Kbd>⌘K</Kbd> palette <Kbd>/</Kbd> search <Kbd>[</Kbd> sidebar <Kbd>space</Kbd> play
          </span>
        </Spec>
      </Section>
      <Section
        title="Inputs"
        intro="Labels above, in secondary ink; hints below. What is wrong sits under the field in signal, never a red border alone. Nothing in a screen uses a control from outside this set."
      >
        <Spec
          name="Text"
          rule="The ground, a hairline, 14 px type. Placeholder text is an example, not a label."
        >
          <Input placeholder="Masters at 96 kHz" className="w-56" aria-label="Example" />
          <Input defaultValue="Joplin Rags" className="w-40" aria-label="Filled" />
          <Input disabled defaultValue="Read only" className="w-36" aria-label="Disabled" />
        </Spec>
        <Spec
          name="Field"
          rule="A label, the control, a hint; the hint gives way to what is wrong."
        >
          <Field label="Title" hint="People see it in their inbox." className="w-56">
            <Input defaultValue="Album masters" />
          </Field>
          <Field label="Email" error="That is not an email address." className="w-56">
            <Input defaultValue="mira@" aria-invalid="true" />
          </Field>
        </Spec>
        <Spec name="Small" rule="28 px, for dense toolbars such as the player's settings.">
          <Input size="sm" defaultValue="-90" className="tabular w-20" aria-label="Floor" />
          <Select size="sm" defaultValue="mel" className="w-auto" aria-label="Scale">
            <option value="mel">Mel</option>
            <option value="linear">Linear</option>
          </Select>
        </Spec>
        <Spec name="Select" rule="For one of a known list; a menu when the choices are actions.">
          <Select defaultValue="Producer" className="w-40" aria-label="Role">
            <option>Producer</option>
            <option>Engineer</option>
          </Select>
        </Spec>
        <Spec name="Long text" rule="Grows with its content up to a point, then scrolls.">
          <Textarea
            placeholder="Notes for the engineer"
            className="h-20 max-w-[420px]"
            aria-label="Notes"
          />
        </Spec>
        <Spec
          name="Inline"
          rule="A name edited where it is shown: no border until hovered or focused."
        >
          <InlineInput
            defaultValue="Producer"
            className="w-32 text-[14px]"
            aria-label="Role name"
          />
        </Spec>
        <Spec
          name="Colour"
          rule="A swatch that opens the system's picker, beside its six digits to type or paste."
        >
          <ColourInput label="Accent" value={colour} onChange={setColour} />
          <ColourInput label="Unfinished" value="#4fb" invalid onChange={noop} />
          <ColourInput label="Fixed" value="#4fb3a9" disabled onChange={noop} />
        </Spec>
        <Spec name="Switch" rule="A setting that takes effect at once.">
          <Switch label="On" checked={on} onChange={setOn} />
          <Switch label="Off" checked={false} onChange={noop} />
          <Switch label="Fixed" checked disabled onChange={noop} />
        </Spec>
        <Spec
          name="Checkbox and radio"
          rule="Picking things inside a form or a list; the words beside them pick them too."
        >
          <Checkbox aria-label="Unchecked" />
          <Checkbox aria-label="Checked" defaultChecked />
          <Checkbox aria-label="Partly" indeterminate />
          <Checkbox aria-label="Disabled" disabled />
          <Radio aria-label="Off" name="reference-radio" />
          <Radio aria-label="On" name="reference-radio" defaultChecked />
          <Choice defaultChecked hint="Each gets a copy by email.">
            Tell the reviewers
          </Choice>
        </Spec>
        <Spec
          name="Choice cards"
          rule="A few larger choices with a line each, such as a project's profile. One the plan leaves out is disabled, its line saying why."
        >
          <div className="grid w-full gap-2 @3xl/app:grid-cols-2">
            <ChoiceCard
              name="reference-storage"
              defaultChecked
              title="Instance storage"
              hint="Kept and backed up by this instance's operators."
            />
            <ChoiceCard
              name="reference-storage"
              disabled
              title="Your own S3-compatible bucket"
              hint="Not on the Studio plan."
            />
          </div>
          <div className="grid w-full gap-2 @3xl/app:grid-cols-3">
            {[
              ["music", "Music", "Bars, scores and takes."],
              ["video", "Video", "Frames and timecode."],
              ["general", "General", "Documents and anything else."],
            ].map(([value, title, hint]) => (
              <ChoiceCard
                key={value}
                name="reference-profile"
                value={value}
                checked={profile === value}
                onChange={() => setProfile(value ?? "music")}
                title={title}
                hint={hint}
              />
            ))}
          </div>
        </Spec>
        <Spec
          name="Segmented"
          rule="Two to four views of the same thing. Tabs are for a third level of navigation only."
        >
          <Segmented
            label="View"
            value={view}
            options={[
              { value: "list", label: "List", icon: <Icon name="list" size={14} /> },
              { value: "grid", label: "Grid", icon: <Icon name="grid" size={14} /> },
            ]}
            onChange={setView}
          />
          <Segmented
            label="Preview as"
            value={mode}
            options={[
              { value: "light", label: "Light client" },
              { value: "dark", label: "Dark client" },
              { value: "text", label: "Plain text" },
            ]}
            onChange={setMode}
          />
        </Spec>
        <Spec name="Slider" rule="A value along a range; the number beside it when it matters.">
          <Slider
            aria-label="Level"
            min={0}
            max={100}
            value={level}
            onChange={(e) => setLevel(Number(e.target.value))}
            className="w-48"
          />
          <span className="tabular text-[13px] text-ink-2">{level}</span>
        </Spec>
      </Section>
      <Section
        title="Surfaces"
        intro="Hairlines over cards and shadows. A card groups rows; a dialog holds one task; a sheet holds one thing's details."
      >
        <Spec name="Card and rows" rule="Rows divide by hairline and read name, hint, control.">
          <Card className="w-full max-w-[460px] divide-y divide-line">
            <Row name="Name" hint="What people see">
              <Input defaultValue="Joplin Rags" className="w-40" aria-label="Project name" />
            </Row>
            <SwitchRow name="Carried comments shown" checked={on} onChange={setOn} />
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
          name="Folding section"
          rule="Folded to one line, its heading and how it stands, where it matters less; Show opens it."
        >
          <div className="w-full max-w-[460px]">
            <FoldingSection
              id="reference-folding"
              title="Video"
              intro="The visible watermark, laid over the player and burned into each download."
              summary="Visible watermark · Guests only · Tiled · 30%"
              open={!folded}
              onToggle={() => setFolded(!folded)}
            >
              <Row name="Visible watermark" hint="Whom it marks.">
                <span className="text-[13px] text-ink-2">Guests only</span>
              </Row>
            </FoldingSection>
          </div>
        </Spec>
        <Spec name="Tabs" rule="A third level of navigation, with the panel they control.">
          <Tabs defaultValue="review" className="w-full max-w-[460px]">
            <TabsList>
              <TabsTrigger value="review">Review</TabsTrigger>
              <TabsTrigger value="qa">QA</TabsTrigger>
            </TabsList>
            <TabsContent value="review" className="pt-3 text-[13px] text-ink-2">
              The player, comments and the score.
            </TabsContent>
            <TabsContent value="qa" className="pt-3 text-[13px] text-ink-2">
              What was measured.
            </TabsContent>
          </Tabs>
        </Spec>
        <Spec name="Dialog" rule="One task, a title that says it, the primary action at the foot.">
          <Button onClick={() => setDialog(true)}>Open a dialog</Button>
          {dialog && (
            <Dialog
              title="Rename the folder"
              onClose={() => setDialog(false)}
              width="sm"
              footer={
                <Button variant="primary" onClick={() => setDialog(false)}>
                  Rename
                </Button>
              }
            >
              <Input defaultValue="Mixes" aria-label="Folder name" />
            </Dialog>
          )}
        </Spec>
        <Spec
          name="Upload dialog"
          rule="Wherever a file is chosen in a dialog: a drop zone that is the file picker, the files chosen with their size and a way off the list, the field or two the job needs, one line on what will happen, and the action named for the job. Each file's progress shows on its row; what went wrong sits under the file it concerns."
        >
          <div className="flex w-full max-w-[460px] flex-col gap-4">
            <UploadZone
              prompt="Drop the files of this version here, or choose them"
              hint="One file per variant."
              inputLabel="Example files"
              multiple
              onPick={noop}
            />
            <ChosenList chosen={chosenFiles} label="Example files chosen" onRemove={noop} />
            <p className="m-0 text-[13px] text-ink-2">
              Uploaded into the track's folder as Version 3.
            </p>
            <div>
              <Button onClick={() => setUploading(true)}>Open an upload dialog</Button>
            </div>
            {uploading && (
              <UploadDialog<string>
                title="Add a variant to V2"
                description="Another treatment of the same edit, such as a wet mix beside the dry one."
                onClose={() => setUploading(false)}
                inputLabel="The variant's file"
                prompt="Drop the file here, or choose it"
                accept="audio/*,video/*"
                send={pretendToSend}
                what="Uploaded into the track's folder, beside the other variants of V2."
                action="Add variant"
                onSubmit={() => setUploading(false)}
              />
            )}
          </div>
        </Spec>
        <Spec
          name="Empty state"
          rule="Says what the place is for and what to do next, with the one action that does it."
        >
          <div className="w-full max-w-[460px]">
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
        intro="People are avatars with initials; things are icons; states are dots and words, never colour alone."
      >
        <Spec
          name="Avatar"
          rule="Initials on a hue of their own; a row overlaps and stops at four."
        >
          <Avatar id="alex" name="Alex Rivera" size={28} />
          <Avatar id="mira" name="Mira Solberg" size={20} />
          <AvatarRow
            people={[
              { id: "alex", name: "Alex Rivera" },
              { id: "tomas", name: "Tomas Varga" },
              { id: "ines", name: "Ines Arlow" },
              { id: "mira", name: "Mira Solberg" },
            ]}
          />
        </Spec>
        <Spec
          name="Status"
          rule="A filled dot for done, a hollow one for waiting, signal for what needs a person."
        >
          <span className="flex flex-wrap items-center gap-3 text-[12px] text-ink-2">
            {states.map((s) => (
              <span key={s} className="flex items-center gap-1.5">
                <StatusDot state={s} />
                {s.replace("_", " ")}
              </span>
            ))}
          </span>
        </Spec>
        <Spec
          name="Comment category"
          rule="A 3 px bar at the thread's left edge, by the category's place in the project's list; six tones, then round again. Its name is in the thread's menu and on hover, never a pill."
        >
          <span className="flex flex-wrap items-center gap-3 text-[12px] text-ink-2">
            {categoryTones.map((tone, i) => (
              <span key={tone} className="flex items-center gap-2" title={`--hk-category-${i + 1}`}>
                <span aria-hidden="true" className={cn("h-6 w-[3px] rounded-full", tone)} />
                category-{i + 1}
              </span>
            ))}
          </span>
        </Spec>
        <Spec
          name="Reviewer status"
          rule="A reviewer or an item: dashed when asked, dotted while waiting their turn."
        >
          <span className="flex flex-wrap items-center gap-3 text-[12px] text-ink-2">
            {(
              [
                "approved",
                "changes_requested",
                "submitted",
                "in_review",
                "invited",
                "waiting",
                "passed",
              ] as ReviewerDotState[]
            ).map((s) => (
              <span key={s} className="flex items-center gap-1.5">
                <ReviewerDot state={s} />
                {s.replace("_", " ")}
              </span>
            ))}
          </span>
        </Spec>
        <Spec name="Pill" rule="A review's state in a list or a header.">
          {states.map((s) => (
            <StatusPill key={s} state={s} />
          ))}
        </Spec>
        <Spec
          name="Status chip"
          rule="A track's status in the player's header; with moves, a menu that confirms each."
        >
          <StatusChipView status="With the soloists" category="in_progress" />
          <StatusChipView status="Approved" category="done" />
          <StatusChipView
            status="Editing"
            category="in_progress"
            moves={[
              {
                runId: "run",
                nodeId: "edit",
                step: "Engineer edits",
                outcome: "done",
                label: "Done",
              },
              {
                runId: "run",
                nodeId: "edit",
                step: "Engineer edits",
                outcome: "overdue",
                label: "Due date passed",
              },
            ]}
            onMove={() => {}}
          />
        </Spec>
        <Spec
          name="Chip and count"
          rule="A chip for a tag or a filter; a count in signal only when it needs someone."
        >
          <Chip>delivery</Chip>
          <Chip>
            <Icon name="tag" size={11} />
            mix
          </Chip>
          <Count>2</Count>
        </Spec>
        <Spec
          name="Linked file"
          rule="A file of the project on a comment: its kind, its name and its length or pages; it opens in the viewer, never as a download."
        >
          <LinkedFiles
            guest={false}
            files={[
              {
                id: "01890000-0000-7000-8000-000000000001",
                name: "Maple Leaf Rag - Score.pdf",
                kind: "document",
                duration: null,
                pageCount: 3,
              },
              {
                id: "01890000-0000-7000-8000-000000000002",
                name: "Reference mix.wav",
                kind: "audio",
                duration: 214,
                pageCount: null,
              },
            ]}
            onUnlink={() => {}}
          />
        </Spec>
        <Spec
          name="Toggle chip"
          rule="A quick pick beside a field, pressed or not: a due date in a week, the rule an approval settles by."
        >
          <ToggleChip pressed>everyone</ToggleChip>
          <ToggleChip pressed={false}>any one</ToggleChip>
          <ToggleChip pressed={false} disabled>
            a share
          </ToggleChip>
        </Spec>
        <Spec name="Eyebrow" rule="Heads a group; a count follows in small tabular figures.">
          <span className="flex items-center gap-2">
            <span className="eyebrow">Waiting on you</span>
            <span className="tabular text-[12px] text-ink-3">2</span>
          </span>
        </Spec>
      </Section>
      <Section
        title="Workflow nodes"
        intro="Each kind of node has a family, which gives its colour and shape, and an icon of its own: no two kinds are drawn alike, on the canvas, in the picker or in any list that offers them."
      >
        <Spec
          name="Families"
          rule="In the order a workflow reads; the key on the canvas and in the picker."
        >
          <GroupLegend />
        </Spec>
        <div className="px-4 py-4">
          <KindLegend />
        </div>
      </Section>
      <Section
        title="Video frame"
        intro="Guides over the picture never take a click; the picture beneath still plays."
      >
        <Spec
          name="Mattes and safe areas"
          rule="Fitted to the picture, not the player: action within 93%, titles within 90%."
        >
          {(["2.39", "4:3"] as const).map((matte) => (
            <div key={matte} className="relative aspect-video w-56 bg-ink-3">
              <FrameGuides aspect={16 / 9} matte={matte} safe={matte === "2.39"} />
            </div>
          ))}
        </Spec>
        <Spec
          name="Drawing on a frame"
          rule="Each mark in a colour of the system, over the picture; the one being written in full, the rest fainter."
        >
          <div className="relative aspect-video w-full max-w-96 bg-ink-3">
            <DrawingMarks
              aspect={16 / 9}
              drawings={[
                {
                  tool: "box",
                  colour: "signal",
                  points: [
                    [0.06, 0.1],
                    [0.36, 0.42],
                  ],
                },
                {
                  tool: "circle",
                  colour: "paper",
                  points: [
                    [0.5, 0.1],
                    [0.72, 0.45],
                  ],
                },
                {
                  tool: "arrow",
                  colour: "blue",
                  points: [
                    [0.1, 0.85],
                    [0.35, 0.6],
                  ],
                },
                {
                  tool: "free",
                  colour: "green",
                  points: [
                    [0.45, 0.8],
                    [0.52, 0.68],
                    [0.6, 0.78],
                    [0.68, 0.66],
                    [0.76, 0.8],
                  ],
                },
                {
                  tool: "line",
                  colour: "paper",
                  points: [
                    [0.8, 0.2],
                    [0.95, 0.4],
                  ],
                },
              ]}
              draft={{
                tool: "text",
                colour: "signal",
                points: [[0.06, 0.48]],
                text: "Boom in shot",
              }}
            />
          </div>
          <div className="relative h-14 w-full max-w-[32rem]">
            <DrawToolbar
              tool="box"
              onTool={() => {}}
              colour="signal"
              onColour={() => {}}
              onClose={() => {}}
            />
          </div>
        </Spec>
        <Spec
          name="Go to"
          rule="Opens on the current timecode, selected; fewer fields count from the start."
        >
          <GoToTimecode
            clock={{ rate: frameRates["25"], start: 10 * 3600 * 25 }}
            time={72.32}
            duration={600}
            onGo={() => {}}
          />
        </Spec>
      </Section>
      <Section
        title="QA report"
        intro="The report as a page and as a PDF (#515): the same parts, from the same document."
      >
        <Spec
          name="Verdict"
          rule="One line under the signal's bar: what fails, by name; ready with what to look at; or ready."
        >
          <div className="flex w-full max-w-[520px] flex-col gap-4">
            {(["fail", "warn", "pass"] as const).map((tone) => (
              <Verdict
                key={tone}
                doc={{
                  profile: "Streaming",
                  verdict: {
                    tone,
                    words:
                      tone === "fail"
                        ? "Not ready for Streaming: clipping and true peak fail."
                        : tone === "warn"
                          ? "Ready for Streaming, with one thing worth a look."
                          : "Ready for Streaming: every check passes.",
                  },
                }}
              />
            ))}
          </div>
        </Spec>
        <Spec
          name="Loudness gauge"
          rule="The target's band in the signal, the value's needle in ink; without a target, −30 to 0 LUFS."
        >
          <div className="flex w-full max-w-[520px] flex-col gap-4">
            <Gauge gauge={loudnessGauge(-16.4, { target: -14, tolerance: 1 })} />
            <Gauge gauge={loudnessGauge(-9.8, null)} />
          </div>
        </Spec>
        <Spec
          name="A finding's crop"
          rule="The waveform around the finding, its stretch in the signal; the window's ends below."
        >
          <div className="w-full max-w-[520px]">
            <Crop
              crop={{
                from: 11.25,
                to: 13.25,
                markFrom: 12,
                markTo: 12.5,
                envelope: Array.from({ length: 160 }, (_, i): [number, number] => {
                  const level =
                    i >= 60 && i < 100 ? 1 : 0.15 + 0.35 * Math.exp(-((i * 0.0125) % 0.5) * 4);
                  return [-level, level];
                }),
              }}
            />
          </div>
        </Spec>
      </Section>
      <Section title="Feedback" intro="Menus and dialogs rise in over 160 ms; nothing bounces.">
        <Spec
          name="Toast"
          rule="One line, gone in under three seconds; never for an error someone has to act on."
        >
          <span className="rounded-panel bg-overlay px-4 py-2 text-[13px] text-ink shadow-4">
            Copied.
          </span>
        </Spec>
        <Spec
          name="Undo line"
          rule="After a change made by a gesture (a bar dragged on the timeline): what was done, Undo, and Dismiss; gone by itself after a while."
        >
          <span
            role="status"
            className="flex items-center gap-1 rounded-control border border-line bg-overlay py-0.5 pr-0.5 pl-3 text-[13px] text-ink-2 shadow-2"
          >
            <span>Maple Leaf Rag due 21 Oct</span>
            <Button variant="ghost" size="sm">
              Undo
            </Button>
            <Button variant="quiet" size="iconSm" aria-label="Dismiss">
              <Icon name="close" size={13} />
            </Button>
          </span>
        </Spec>
        <Spec name="Problem" rule="Inline, next to what is wrong, with the fix in the sentence.">
          <span className="rounded-panel border border-signal/40 bg-signal/10 px-3 py-2 text-[12px] text-ink">
            An approval needs reviewers who may decide: say that they may, or ask for feedback.
          </span>
        </Spec>
      </Section>
    </>
  );
}

export default function ReferencePage() {
  return (
    <main className="h-full overflow-y-auto bg-pane">
      <Page width="default">
        <div>
          <p className="eyebrow m-0">Reference, not part of the app</p>
          <h1 className="title mt-2">Brand and design system</h1>
          <p className="mt-1.5 max-w-[620px] text-[14px] text-ink-2">
            Everything a screen is built from: the brand, the tokens, and each component in its
            states. docs/brand.md explains the reasons.
          </p>
        </div>
        <Brand />
        <Components />
      </Page>
    </main>
  );
}
