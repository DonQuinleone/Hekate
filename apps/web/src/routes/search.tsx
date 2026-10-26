import {
  narrowed,
  type SearchKind,
  type SearchRequest,
  type SearchResult,
  type SearchSince,
  searchFrameRates,
  searchSince,
} from "@hekate/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  type FormEvent,
  type MouseEvent,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import { Empty } from "~/components/empty";
import { Icon, type IconName } from "~/components/icons";
import { Kbd, paletteKey } from "~/components/kbd";
import { Page } from "~/components/page";
import { PageHeader } from "~/components/page-header";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input, Select } from "~/components/ui/input";
import { usePopover } from "~/components/ui/menu";
import {
  membersQuery,
  projectsQuery,
  type SavedSearch,
  savedSearchesQuery,
  searchQuery,
  tagsQuery,
  useSavedSearchMutations,
} from "~/lib/queries";
import {
  compact,
  describeSearch,
  draftOf,
  type FieldDraft,
  type FieldKey,
  fieldChips,
  fieldsOf,
  fromKindChoice,
  kindChoice,
  kindChoices,
  sinceLabels,
} from "~/lib/search";

const kindHeading: Record<SearchKind, { title: string; icon: IconName }> = {
  projects: { title: "Projects", icon: "folder" },
  tracks: { title: "Tracks", icon: "track" },
  files: { title: "Files", icon: "file" },
  reviews: { title: "Reviews", icon: "review" },
  people: { title: "People", icon: "user" },
  comments: { title: "Comments", icon: "comment" },
};

/**
 * Search with room to narrow it: words, a kind, a project, a person and how recent, all held
 * in the address so a search can be shared or kept. Saved searches sit under the field.
 */
export function SearchPage({ search }: { search: SearchRequest }) {
  const navigate = useNavigate();
  const [text, setText] = useState(search.q);
  const [saving, setSaving] = useState(false);
  // The address can change under the page (a saved search, the palette); the field follows,
  // but not back to words it wrote itself while typing ran ahead of the address. `pending`
  // holds the words written and not yet arrived, oldest first; anything else came from outside.
  const pending = useRef<string[]>([]);
  useEffect(() => {
    const at = pending.current.indexOf(search.q);
    if (at >= 0) {
      pending.current = pending.current.slice(at + 1);
      return;
    }
    pending.current = [];
    setText(search.q);
  }, [search.q]);

  const { q: _typed, ...filters } = search;
  const asked = useDeferredValue(compact({ ...filters, q: text.trim() }));
  const found = useQuery({ ...searchQuery(asked), placeholderData: keepPreviousData });
  const { data: projects = [] } = useQuery(projectsQuery);
  const { data: members = [] } = useQuery(membersQuery);
  const { data: saved = [] } = useQuery(savedSearchesQuery);
  const { data: tags = [] } = useQuery(tagsQuery);

  const go = (next: Partial<SearchRequest>) =>
    void navigate({ to: "/search", search: compact({ ...search, ...next }), replace: true });
  const words = text.trim();
  const filtered = narrowed(filters);
  const looking = words.length > 0 || filtered;
  const results = looking ? (found.data ?? []) : [];

  const names = (id: string) =>
    projects.find((p) => p.id === id)?.name ??
    members.find((m) => m.userId === id)?.name ??
    tags.find((t) => t.id === id)?.name;

  return (
    <>
      <PageHeader title="Search" />
      <Page width="narrow" className="gap-5">
        <div className="relative">
          <Icon
            name="search"
            size={18}
            className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-ink-3"
          />
          <Input
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              pending.current.push(e.target.value);
              go({ q: e.target.value });
            }}
            placeholder="Projects, tracks, files, reviews, people and comments"
            aria-label="Search"
            maxLength={200}
            // The page exists to be typed into.
            autoFocus
            className="h-12 rounded-panel-lg border-line bg-raised/40 pr-4 pl-12 text-[16px] @3xl/app:pr-36"
          />
          {!text && (
            <span className="pointer-events-none absolute top-1/2 right-4 hidden -translate-y-1/2 items-center gap-1.5 text-[12px] text-ink-3 @3xl/app:flex">
              <Kbd>{paletteKey}</Kbd> from anywhere
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 items-center gap-2 @3xl/app:flex @3xl/app:flex-wrap">
          <Select
            aria-label="Kind"
            value={kindChoice(search)}
            onChange={(e) => go(fromKindChoice(e.target.value))}
            className="@3xl/app:w-36"
          >
            {kindChoices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.indent ? ` ${c.label}` : c.label}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Project"
            value={search.projectId ?? ""}
            onChange={(e) => go({ projectId: e.target.value || undefined })}
            className="@3xl/app:w-36"
          >
            <option value="">Any project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Person"
            value={search.personId ?? ""}
            onChange={(e) => go({ personId: e.target.value || undefined })}
            className="@3xl/app:w-36"
          >
            <option value="">Anyone</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </Select>
          <Select
            aria-label="When"
            value={search.since ?? ""}
            onChange={(e) => go({ since: (e.target.value || undefined) as SearchSince })}
            className="@3xl/app:w-32"
          >
            <option value="">Any time</option>
            {searchSince.map((s) => (
              <option key={s} value={s}>
                {sinceLabels[s]}
              </option>
            ))}
          </Select>
          {/* Only files carry tags, so a tag narrows to files. */}
          {(tags.length > 0 || search.tagId) && (
            <Select
              aria-label="Tag"
              value={search.tagId ?? ""}
              onChange={(e) => go({ tagId: e.target.value || undefined })}
              className="@3xl/app:w-32"
            >
              <option value="">Any tag</option>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          )}
          <FieldsMenu search={search} onApply={(fields) => go(fields)} />
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              className="justify-self-start"
              onClick={() =>
                go({
                  kind: undefined,
                  fileKind: undefined,
                  projectId: undefined,
                  personId: undefined,
                  tagId: undefined,
                  since: undefined,
                  ...noFields,
                })
              }
            >
              Clear
            </Button>
          )}
          {/* Beside the filters it keeps, not in the header, so a phone keeps one header row. */}
          {looking && (
            <Button
              variant="ghost"
              size="sm"
              className="col-start-2 justify-self-end @3xl/app:ml-auto"
              onClick={() => setSaving(true)}
            >
              <Icon name="star" size={14} />
              Save search
            </Button>
          )}
        </div>
        {fieldChips(search).length > 0 && (
          <FieldChips
            search={search}
            onClear={(keys) => go(Object.fromEntries(keys.map((k) => [k, undefined])))}
          />
        )}
        {!words && saved.length > 0 && (
          <Saved
            saved={saved}
            onOpen={(s) => {
              setText(s.search.q);
              pending.current.push(s.search.q);
              void navigate({ to: "/search", search: compact(s.search), replace: true });
            }}
          />
        )}
        {found.error && <p className="m-0 text-signal">{found.error.message}</p>}
        {!looking ? (
          <p className="m-0 text-[13px] text-ink-3">
            Type to search what you may see, or narrow by kind, project, person, time and a file's
            fields.
          </p>
        ) : found.isPending ? (
          <p className="m-0 text-[13px] text-ink-3">Searching</p>
        ) : results.length === 0 ? (
          <Empty
            title="No results"
            text={
              words
                ? `Nothing matches “${words}” in what you may see.`
                : "Nothing matches these filters in what you may see."
            }
          />
        ) : (
          <Results results={results} />
        )}
      </Page>
      {saving && (
        <SaveSearch
          search={compact({ ...filters, q: words })}
          suggested={describeSearch({ ...filters, q: words }, names)}
          onClose={() => setSaving(false)}
        />
      )}
    </>
  );
}

const noFields: Pick<SearchRequest, FieldKey> = {
  durationMin: undefined,
  durationMax: undefined,
  sizeMin: undefined,
  sizeMax: undefined,
  frameRate: undefined,
  commentText: undefined,
};

/**
 * Advanced search by field (decision 263): a file's duration and size as ranges, its frame
 * rate, and what its comments say, filled in together and applied at once, so a half-typed
 * number never searches.
 */
function FieldsMenu({
  search,
  onApply,
}: {
  search: SearchRequest;
  onApply: (fields: Pick<SearchRequest, FieldKey>) => void;
}) {
  const [open, setOpen, box] = usePopover();
  const [draft, setDraft] = useState<FieldDraft>(() => draftOf(search));
  const count = fieldChips(search).length;
  const edit = (key: keyof FieldDraft) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [key]: e.target.value }));
  const apply = (e: FormEvent) => {
    e.preventDefault();
    onApply(fieldsOf(draft));
    setOpen(false);
  };
  return (
    <div ref={box} className="relative col-span-2 @3xl/app:col-span-1">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          if (!open) setDraft(draftOf(search));
          setOpen(!open);
        }}
        className={count ? "text-ink" : "text-ink-3"}
      >
        <Icon name="sliders" size={14} />
        Fields
        {count > 0 && (
          <span className="tabular rounded-full bg-raised px-1.5 text-[11px] text-ink-2">
            {count}
          </span>
        )}
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="Search by field"
          data-e2e-overlap
          className="rise-in absolute left-0 z-30 mt-1 w-80 max-w-[calc(100vw-32px)] rounded-panel-lg bg-overlay p-3 shadow-4 @3xl/app:right-0 @3xl/app:left-auto"
        >
          <form onSubmit={apply} className="flex flex-col gap-3">
            <fieldset className="m-0 grid grid-cols-2 gap-2 border-0 p-0">
              <legend className="mb-1.5 p-0 text-[13px] text-ink-2">Duration, in minutes</legend>
              <Input
                aria-label="Longer than, minutes"
                placeholder="At least"
                inputMode="decimal"
                value={draft.durationMin}
                onChange={edit("durationMin")}
              />
              <Input
                aria-label="Shorter than, minutes"
                placeholder="At most"
                inputMode="decimal"
                value={draft.durationMax}
                onChange={edit("durationMax")}
              />
            </fieldset>
            <fieldset className="m-0 grid grid-cols-2 gap-2 border-0 p-0">
              <legend className="mb-1.5 p-0 text-[13px] text-ink-2">Size, in MB</legend>
              <Input
                aria-label="Larger than, MB"
                placeholder="At least"
                inputMode="decimal"
                value={draft.sizeMin}
                onChange={edit("sizeMin")}
              />
              <Input
                aria-label="Smaller than, MB"
                placeholder="At most"
                inputMode="decimal"
                value={draft.sizeMax}
                onChange={edit("sizeMax")}
              />
            </fieldset>
            <Field label="Frame rate">
              <Select value={draft.frameRate} onChange={edit("frameRate")}>
                <option value="">Any frame rate</option>
                {searchFrameRates.map((rate) => (
                  <option key={rate} value={String(rate)}>
                    {rate} fps
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Comments say">
              <Input
                value={draft.commentText}
                onChange={edit("commentText")}
                maxLength={200}
                placeholder="Words in a comment"
              />
            </Field>
            <div className="flex justify-end gap-2 border-t border-line pt-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  onApply(noFields);
                  setOpen(false);
                }}
              >
                Clear fields
              </Button>
              <Button type="submit" variant="primary" size="sm">
                Apply
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

/** The fields in force, each removable, as the files page shows its filters. */
function FieldChips({
  search,
  onClear,
}: {
  search: SearchRequest;
  onClear: (keys: FieldKey[]) => void;
}) {
  return (
    <ul aria-label="Fields" className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0">
      {fieldChips(search).map((chip) => (
        <li
          key={chip.keys.join()}
          className="flex h-7 items-center gap-1.5 rounded-full border border-line bg-raised/40 pr-1 pl-2.5 text-[12px] text-ink-2"
        >
          <span className="max-w-64 truncate">{chip.label}</span>
          <button
            type="button"
            aria-label={`Remove ${chip.label}`}
            onClick={() => onClear(chip.keys)}
            className="flex size-6 items-center justify-center rounded-full text-ink-3 hover:bg-raised hover:text-ink"
          >
            <Icon name="close" size={11} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function Saved({ saved, onOpen }: { saved: SavedSearch[]; onOpen: (s: SavedSearch) => void }) {
  const { remove } = useSavedSearchMutations();
  return (
    <section aria-label="Saved searches" className="flex flex-wrap items-center gap-1.5">
      <h2 className="m-0 mr-1 text-[12px] font-normal text-ink-3">Saved</h2>
      {saved.map((s) => (
        <span
          key={s.id}
          className="flex h-7 items-center rounded-chip border border-line text-[13px] text-ink-2 transition-colors hover:border-edge-strong"
        >
          <button
            type="button"
            onClick={() => onOpen(s)}
            className="h-full max-w-56 truncate pl-2.5 pr-1 hover:text-ink"
          >
            {s.name}
          </button>
          <button
            type="button"
            aria-label={`Forget ${s.name}`}
            title="Forget"
            disabled={remove.isPending}
            onClick={() => remove.mutate(s.id)}
            className="mr-0.5 flex size-6 items-center justify-center rounded-chip text-ink-3 transition-colors hover:bg-raised hover:text-ink"
          >
            <Icon name="close" size={10} />
          </button>
        </span>
      ))}
    </section>
  );
}

function Results({ results }: { results: SearchResult[] }) {
  const navigate = useNavigate();
  const open = (event: MouseEvent<HTMLAnchorElement>, link: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    void navigate({ href: link });
  };
  const groups = new Map<SearchKind, SearchResult[]>();
  for (const r of results) groups.set(r.kind, [...(groups.get(r.kind) ?? []), r]);
  return (
    <div className="flex flex-col gap-4">
      {[...groups].map(([kind, rows]) => (
        <section key={kind} aria-label={kindHeading[kind].title} className="flex flex-col">
          <h2 className="eyebrow m-0 mb-1 px-3">{kindHeading[kind].title}</h2>
          <ul className="m-0 flex list-none flex-col p-0">
            {rows.map((r) => (
              <li key={r.id}>
                <a
                  href={r.link}
                  onClick={(e) => open(e, r.link)}
                  className="flex h-10 w-full items-center gap-3 rounded-control px-3 text-ink-2 transition-colors hover:bg-raised/60 hover:text-ink"
                >
                  <Icon name={kindHeading[kind].icon} size={16} className="shrink-0 text-ink-3" />
                  <span className="min-w-0 flex-1 truncate text-[14px]">{r.label}</span>
                  {r.hint && (
                    <span className="hidden max-w-[40%] truncate text-[12px] text-ink-3 @3xl/app:inline">
                      {r.hint}
                    </span>
                  )}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function SaveSearch({
  search,
  suggested,
  onClose,
}: {
  search: SearchRequest;
  suggested: string;
  onClose: () => void;
}) {
  const [name, setName] = useState(suggested);
  const { save } = useSavedSearchMutations();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ name: name.trim(), search }, { onSuccess: onClose });
  };
  return (
    <Dialog
      title="Save search"
      description="Kept for you, in this workspace."
      onClose={onClose}
      width="sm"
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Name
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
        </label>
        {save.error && <p className="m-0 text-[13px] text-signal">{save.error.message}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
