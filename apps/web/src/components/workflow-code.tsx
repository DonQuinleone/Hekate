import {
  type WorkflowSummary,
  workflowFileName,
  workflowFromYaml,
  workflowToYaml,
} from "@hekate/shared";
import { useMemo, useRef, useState } from "react";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { CodeEditor } from "~/components/ui/code-editor";
import { FileInput } from "~/components/ui/input";
import { Dropdown } from "~/components/ui/menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { cn } from "~/lib/cn";
import { useWorkflowMutations } from "~/lib/queries";
import {
  workflowChanges,
  workflowTemplates,
  type YamlPiece,
  yamlPieces,
} from "~/lib/workflow-code";

const pieceClass: Record<YamlPiece, string> = {
  space: "",
  key: "text-ink",
  punctuation: "text-ink-3",
  text: "text-ink-2",
  number: "text-node-work",
  word: "text-node-event",
  comment: "text-ink-3",
};

const colour = (line: string) =>
  yamlPieces(line).map((p, i) => (
    <span
      // Pieces are positions in the line.
      // biome-ignore lint/suspicious/noArrayIndexKey: each piece is its position.
      key={i}
      className={cn(
        pieceClass[p.piece],
        p.piece === "text" && /^\s*["']/.test(p.text) && "text-node-comm",
      )}
    >
      {p.text}
    </span>
  ));

/** A file of more than this is not a workflow. */
const MAX_FILE = 1024 * 1024;

/** Text being changed, and the version of the workflow it was begun from. */
interface Draft {
  text: string;
  version: number;
}

/**
 * The builder's code view (#145): each workflow as its file, to copy, download, or change and
 * apply. A file read in, or a template, is checked before anything is saved: what it would
 * change, and its problems, each at its line.
 */
export function WorkflowCode({
  projectId,
  workflows,
  editing,
  focus,
}: {
  projectId: string;
  workflows: WorkflowSummary[];
  editing: boolean;
  focus: string | null;
}) {
  const { change } = useWorkflowMutations(projectId);
  const [chosen, setChosen] = useState(focus);
  const workflow = workflows.find((w) => w.id === chosen) ?? workflows[0];
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [said, setSaid] = useState<{ text: string; failed?: boolean } | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const chooser = useRef<HTMLInputElement>(null);

  const written = useMemo(
    () => (workflow ? workflowToYaml(workflow.name, workflow.definition) : ""),
    [workflow],
  );
  const draft = workflow ? drafts[workflow.id] : undefined;
  const text = draft?.text ?? written;
  const dirty = draft !== undefined && draft.text !== written;
  const read = useMemo(() => workflowFromYaml(text), [text]);
  if (!workflow) return null;

  const changes =
    dirty && read.ok
      ? workflowChanges(workflow, { name: read.name, definition: read.definition })
      : [];
  const stale = dirty && draft.version !== workflow.version;
  const breaks = read.ok && workflow.active && read.problems.some((p) => p.level === "error");
  const marked = new Set(
    (read.ok ? read.problems.filter((p) => p.level === "error") : read.errors).flatMap((p) =>
      p.line === null ? [] : [p.line],
    ),
  );

  const setText = (next: string) => {
    setSaid(null);
    setDrafts((d) => ({
      ...d,
      [workflow.id]: { text: next, version: d[workflow.id]?.version ?? workflow.version },
    }));
  };
  const forget = () => {
    setSaid(null);
    setDrafts(({ [workflow.id]: _gone, ...rest }) => rest);
  };
  const goTo = (line: number | null) => {
    const area = editor.current;
    if (!area || line === null) return;
    const lines = text.split("\n");
    const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
    area.focus({ preventScroll: true });
    area.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
    // The text area is as tall as the file, so the line is brought into view by its coloured copy.
    area.parentElement
      ?.querySelector("pre")
      ?.children[line - 1]?.scrollIntoView({ block: "center" });
  };
  const apply = () => {
    if (!read.ok) return;
    const { name, definition } = read;
    const id = workflow.id;
    const applied = text;
    change.mutate(
      { id, change: () => ({ name, definition }) },
      {
        // What was applied is now the workflow. Anything typed while it was saving is kept, as
        // a change to the version just saved, not to the one it was begun from.
        onSuccess: (saved) => {
          setDrafts(({ [id]: current, ...rest }) =>
            !current || current.text === applied
              ? rest
              : { ...rest, [id]: { ...current, version: saved.version } },
          );
          setSaid({ text: `Applied to ${name}.` });
        },
        onError: (failure) => setSaid({ text: failure.message, failed: true }),
      },
    );
  };
  const copy = () =>
    navigator.clipboard
      ?.writeText(text)
      .then(() => setSaid({ text: "Copied." }))
      .catch(() => setSaid({ text: "The clipboard would not take it.", failed: true }));
  const download = () => {
    const name = workflowFileName(read.ok ? read.name : workflow.name);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/yaml" }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    setSaid({ text: `Saved ${name}.` });
  };
  const open = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_FILE) {
      setSaid({ text: `${file.name} is too large to be a workflow.`, failed: true });
      return;
    }
    file
      .text()
      .then((content) => {
        setText(content);
        setSaid({ text: `Read ${file.name}: check what it changes, then apply it.` });
      })
      .catch(() => setSaid({ text: `${file.name} could not be read.`, failed: true }));
  };

  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
      <Tabs
        value={workflow.id}
        onValueChange={setChosen}
        className="fade-in mx-auto flex w-full max-w-[960px] flex-col gap-4 px-5 py-6 @3xl/app:px-10 @3xl/app:py-8"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1">
            <TabsList aria-label="Workflow" className="scroll-quiet overflow-x-auto border-b-0">
              {workflows.map((w) => (
                <TabsTrigger key={w.id} value={w.id} className="shrink-0 whitespace-nowrap">
                  {w.name}
                  {drafts[w.id] && drafts[w.id]?.text !== workflowToYaml(w.name, w.definition) && (
                    <>
                      <span aria-hidden="true" className="size-1.5 rounded-full bg-signal" />
                      <span className="sr-only">(changed)</span>
                    </>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={copy}>
              <Icon name="copy" size={13} />
              Copy
            </Button>
            <Button variant="ghost" size="sm" onClick={download}>
              <Icon name="download" size={13} />
              Download
            </Button>
            {editing && (
              <>
                <Dropdown
                  size="sm"
                  align="right"
                  value={
                    <>
                      <Icon name="upload" size={13} />
                      Import
                    </>
                  }
                  actions={[
                    { label: "A file…", onSelect: () => chooser.current?.click() },
                    "divider",
                    ...workflowTemplates.map((t) => ({
                      label: t.name,
                      hint: "Template",
                      onSelect: () => {
                        setText(t.text);
                        setSaid({
                          text: `The ${t.name} template: check what it changes, then apply it.`,
                        });
                      },
                    })),
                  ]}
                />
                <FileInput
                  ref={chooser}
                  accept=".yaml,.yml,application/yaml,text/yaml"
                  onChange={(e) => {
                    open(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                {dirty && (
                  <Button variant="ghost" size="sm" onClick={forget}>
                    Discard
                  </Button>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  disabled={
                    !dirty ||
                    !read.ok ||
                    stale ||
                    breaks ||
                    changes.length === 0 ||
                    change.isPending
                  }
                  onClick={apply}
                >
                  Apply
                </Button>
              </>
            )}
          </div>
        </div>
        <TabsContent value={workflow.id} className="flex flex-col gap-4 focus:outline-none">
          <p className="m-0 max-w-[640px] text-[13px] text-ink-3">
            The whole workflow as a file: keep it in a repository, share it between projects, or
            hand it to another instance. Changes made here are checked, then applied when you
            choose; the canvas and this file always show the same workflow.
          </p>
          <div role="status" className="empty:hidden">
            {said && (
              <p className={cn("m-0 text-[13px]", said.failed ? "text-signal" : "text-ink-2")}>
                {said.text}
              </p>
            )}
          </div>
          {stale && (
            <p className="m-0 text-[13px] text-signal">
              {workflow.name} was changed elsewhere since you began, so this cannot be applied over
              it. Copy what you need, then discard to start again from it as it is now.
            </p>
          )}
          {!read.ok ? (
            <Findings
              title="This file cannot be applied"
              items={read.errors.map((e) => ({ line: e.line, text: e.message, error: true }))}
              onLine={goTo}
            />
          ) : (
            <>
              {dirty && (
                <section aria-label="What applying it changes" className="flex flex-col gap-1.5">
                  <h3 className="m-0 text-[13px] font-medium text-ink">
                    {changes.length === 0 ? "Applying it changes nothing" : "Applying it"}
                  </h3>
                  {changes.length > 0 && (
                    <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px] text-ink-2 marker:text-ink-3">
                      {changes.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
              {breaks && (
                <p className="m-0 text-[13px] text-signal">
                  {workflow.name} is switched on, and this would stop it running: mend what is
                  below, or switch it off first.
                </p>
              )}
              {read.problems.length > 0 && (
                <Findings
                  title="To look at"
                  items={read.problems.map((p) => ({
                    line: p.line,
                    text: p.text,
                    error: p.level === "error",
                  }))}
                  onLine={goTo}
                />
              )}
            </>
          )}
          <CodeEditor
            ref={editor}
            label={`${workflow.name} as a file`}
            value={text}
            onChange={setText}
            colour={colour}
            marked={marked}
            readOnly={!editing}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Mistakes or problems in a file, each taking you to its line. */
function Findings({
  title,
  items,
  onLine,
}: {
  title: string;
  items: { line: number | null; text: string; error: boolean }[];
  onLine: (line: number | null) => void;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-1.5">
      <h3 className="m-0 text-[13px] font-medium text-ink">{title}</h3>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {items.map((item) => (
          <li
            key={`${item.line}-${item.text}`}
            className={cn(
              "flex items-start gap-2 text-[13px]",
              item.error ? "text-signal" : "text-ink-2",
            )}
          >
            <Icon name="warning" size={14} className="mt-0.5 shrink-0" />
            {item.line !== null ? (
              <button
                type="button"
                onClick={() => onLine(item.line)}
                className="tabular shrink-0 cursor-pointer text-ink-3 underline-offset-2 hover:text-ink hover:underline"
              >
                Line {item.line}
              </button>
            ) : null}
            <span className="min-w-0">{item.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
