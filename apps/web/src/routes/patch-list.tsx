import type { PatchDirection, PatchRow, StageBox } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { ProductionBody } from "~/components/production-nav";
import { Button } from "~/components/ui/button";
import { Count } from "~/components/ui/chip";
import { Dialog, useConfirm } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { ActionMenu, Dropdown } from "~/components/ui/menu";
import { Failed, Loading, Refused } from "~/components/ui/states";
import {
  patchQuery,
  stagePlansQuery,
  usePatchList,
  useProjectCan,
  useStagePlans,
} from "~/lib/queries";
import { ProjectFrame } from "./project";

const directionWords: Record<PatchDirection, { heading: string; one: string }> = {
  input: { heading: "Input", one: "input" },
  output: { heading: "Output", one: "output" },
};

/**
 * The patch list (#54), in Production as the prototype has it: the project's stage boxes, each
 * with its inputs and outputs (source, device, cable or channel, notes). Those who see the
 * production tools read it; those who use them change it.
 */
export function PatchListPage({ projectId }: { projectId: string }) {
  const can = useProjectCan(projectId);
  const {
    data: boxes,
    error,
    refetch,
  } = useQuery({
    ...patchQuery(projectId),
    enabled: can("view_production"),
  });
  return (
    <ProjectFrame projectId={projectId} title="Patch list">
      {(project) => (
        <ProductionBody projectId={projectId} current="patch" can={can}>
          {!can("view_production") ? (
            <Refused
              title="Not among what your role shows"
              text="The patch list is shown to the roles the project's access gives the production tools."
            />
          ) : error ? (
            <Failed what="The patch list" error={error} retry={refetch} />
          ) : !boxes ? (
            <Loading />
          ) : (
            <PatchList
              projectId={projectId}
              boxes={boxes}
              canEdit={can("edit_production") && !project.archivedAt}
            />
          )}
        </ProductionBody>
      )}
    </ProjectFrame>
  );
}

type Editing =
  | { kind: "box"; box?: StageBox }
  | { kind: "row"; box: StageBox; direction: PatchDirection; row?: PatchRow };

function PatchList({
  projectId,
  boxes,
  canEdit,
}: {
  projectId: string;
  boxes: StageBox[];
  canEdit: boolean;
}) {
  const { removeBox, removeRow } = usePatchList(projectId);
  const [confirm, confirmation] = useConfirm();
  const [editing, setEditing] = useState<Editing | null>(null);
  // The rows a stage plan's microphone is linked to (#659), marked beside their source.
  const { data: stage } = useQuery(stagePlansQuery(projectId));
  const miked = new Set(
    (stage?.plans ?? []).flatMap((p) =>
      p.items.flatMap((i) => (i.kind === "mic" && i.patchRowId ? [i.patchRowId] : [])),
    ),
  );
  const addBox = (
    <Button variant="primary" onClick={() => setEditing({ kind: "box" })}>
      Add a stage box
    </Button>
  );
  return (
    <>
      {boxes.length === 0 ? (
        <Empty
          title="No stage boxes yet"
          text="Inputs and outputs per stage box: source, device, cable or channel, notes."
          action={canEdit ? addBox : undefined}
        />
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-2">
            <span className="label">
              Stage boxes<Count>{boxes.length}</Count>
            </span>
            <span className="ml-auto flex items-center gap-1">
              {/* As the engineer prints it, and as a workbook: made on the server, for this person. */}
              <Dropdown
                value="Export"
                align="right"
                actions={(["pdf", "xlsx"] as const).map((format) => ({
                  label: format.toUpperCase(),
                  onSelect: () =>
                    window.location.assign(`/api/projects/${projectId}/patch/${format}`),
                }))}
              />
              {canEdit && (
                <Button variant="secondary" size="md" onClick={() => setEditing({ kind: "box" })}>
                  <Icon name="plus" size={14} />
                  Add stage box
                </Button>
              )}
            </span>
          </div>
          {boxes.map((box) => (
            <section key={box.id} aria-label={box.name} className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <h2 className="m-0 text-[16px] font-medium text-ink">{box.name}</h2>
                {canEdit && (
                  <ActionMenu
                    always
                    label={box.name}
                    actions={[
                      { label: "Rename…", onSelect: () => setEditing({ kind: "box", box }) },
                      "divider",
                      {
                        label: "Remove…",
                        danger: true,
                        onSelect: () =>
                          confirm({
                            title: `Remove ${box.name}?`,
                            description:
                              "The box goes with its inputs and outputs. Microphones on the stage plan stay, without their channel.",
                            action: "Remove box",
                            onConfirm: () => removeBox.mutateAsync(box.id),
                          }),
                      },
                    ]}
                  />
                )}
              </div>
              {(["input", "output"] as const).map((direction) => {
                const rows = direction === "input" ? box.inputs : box.outputs;
                const words = directionWords[direction];
                return (
                  <div
                    key={direction}
                    className="overflow-x-auto rounded-panel-lg border border-line bg-raised/25"
                  >
                    {/* The same columns for inputs and outputs, so the two tables line up. */}
                    <table className="w-full table-fixed text-[13px] @xl/app:min-w-[520px]">
                      <caption className="sr-only">
                        {box.name}, {words.one}s
                      </caption>
                      <thead>
                        <tr className="text-left">
                          {[
                            [words.heading, "w-[72px]"],
                            ["Source", "w-[30%] @xl/app:w-[22%]"],
                            ["Device", "w-[24%] @xl/app:w-[22%]"],
                            ["Cable", "w-[14%] @xl/app:w-[12%]"],
                            ["Notes", "hidden @xl/app:table-cell"],
                          ].map(([h, width]) => (
                            <th key={h} className={`px-3 py-2 font-normal ${width}`}>
                              <span className="label">{h}</span>
                            </th>
                          ))}
                          <th className="w-10 px-1 py-2">
                            <span className="sr-only">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.id} className="group border-t border-line">
                            <td className="tabular px-3 py-1.5 text-ink-3">{r.channel}</td>
                            <td className="px-3 py-1.5 text-ink">
                              <span className="flex min-w-0 items-center gap-1.5">
                                <span className="truncate">{r.source}</span>
                                {miked.has(r.id) && (
                                  <Icon
                                    name="mic"
                                    size={11}
                                    aria-label="On the stage plan"
                                    className="shrink-0 text-ink-3"
                                  />
                                )}
                              </span>
                              {/* On a phone the notes go under the source, never dropped (#659). */}
                              {r.notes && (
                                <span className="block truncate text-[12px] text-ink-3 @xl/app:hidden">
                                  {r.notes}
                                </span>
                              )}
                            </td>
                            <td className="truncate px-3 py-1.5 text-ink-2">{r.device}</td>
                            <td className="truncate tabular px-3 py-1.5 text-ink-2">{r.cable}</td>
                            <td className="hidden truncate px-3 py-1.5 text-ink-3 @xl/app:table-cell">
                              {r.notes}
                            </td>
                            <td className="px-1 py-1 text-right">
                              {canEdit && (
                                <ActionMenu
                                  label={`${words.one} ${r.channel}`}
                                  actions={[
                                    {
                                      label: "Edit…",
                                      onSelect: () =>
                                        setEditing({ kind: "row", box, direction, row: r }),
                                    },
                                    "divider",
                                    {
                                      label: "Remove…",
                                      danger: true,
                                      onSelect: () =>
                                        confirm({
                                          title: `Remove ${words.one} ${r.channel}?`,
                                          description: r.source
                                            ? `${r.source} goes from the patch list.`
                                            : "It goes from the patch list.",
                                          action: "Remove",
                                          onConfirm: () => removeRow.mutateAsync(r.id),
                                        }),
                                    },
                                  ]}
                                />
                              )}
                            </td>
                          </tr>
                        ))}
                        {rows.length === 0 && (
                          <tr className="border-t border-line">
                            <td colSpan={6} className="px-3 py-2 text-ink-3">
                              No {words.one}s patched.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                    {canEdit && (
                      <div className="border-t border-line px-1.5 py-1">
                        <Button
                          variant="quiet"
                          size="sm"
                          onClick={() => setEditing({ kind: "row", box, direction })}
                        >
                          <Icon name="plus" size={12} />
                          Add an {words.one}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}
      {editing?.kind === "box" && (
        <BoxDialog projectId={projectId} box={editing.box} onClose={() => setEditing(null)} />
      )}
      {editing?.kind === "row" && (
        <RowDialog
          projectId={projectId}
          box={editing.box}
          direction={editing.direction}
          row={editing.row}
          onClose={() => setEditing(null)}
        />
      )}
      {confirmation}
    </>
  );
}

/** Naming a new stage box, or renaming one. */
function BoxDialog({
  projectId,
  box,
  onClose,
}: {
  projectId: string;
  box?: StageBox;
  onClose: () => void;
}) {
  const { addBox, renameBox } = usePatchList(projectId);
  const [name, setName] = useState(box?.name ?? "");
  const saving = box ? renameBox : addBox;
  const save = (e: FormEvent) => {
    e.preventDefault();
    const named = name.trim();
    if (!named) return;
    if (box) renameBox.mutate({ id: box.id, name: named }, { onSuccess: onClose });
    else addBox.mutate(named, { onSuccess: onClose });
  };
  return (
    <Dialog
      title={box ? "Rename the stage box" : "Add a stage box"}
      onClose={onClose}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="stage-box"
            disabled={!name.trim() || saving.isPending}
          >
            {box ? "Rename" : "Add"}
          </Button>
        </>
      }
    >
      <form id="stage-box" onSubmit={save} className="flex flex-col gap-3">
        <Field label="Name" error={saving.error?.message}>
          <Input autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}

/** Patching a channel, or changing one: its number, and what it carries. */
function RowDialog({
  projectId,
  box,
  direction,
  row,
  onClose,
}: {
  projectId: string;
  box: StageBox;
  direction: PatchDirection;
  row?: PatchRow;
  onClose: () => void;
}) {
  const { addRow, changeRow } = usePatchList(projectId);
  const { sendStep, refresh } = useStagePlans(projectId);
  const { data: stage } = useQuery(stagePlansQuery(projectId));
  const words = directionWords[direction];
  // The stage plans' microphones (#659), each a source to choose, linked once the row is saved
  // so its label on the plan follows the patch list.
  const mics = (stage?.plans ?? []).flatMap((plan) =>
    plan.items
      .filter((i) => i.kind === "mic")
      .map((i) => ({
        planId: plan.id,
        id: i.id,
        label: i.label || "Microphone",
        where: (stage?.plans.length ?? 0) > 1 ? plan.name : null,
        linked: Boolean(row) && i.patchRowId === row?.id,
      })),
  );
  const [mic, setMic] = useState<{ planId: string; id: string } | null>(null);
  const [linkFailure, setLinkFailure] = useState<string | null>(null);
  const linkedMic = mics.find((m) => (mic ? m.id === mic.id : m.linked));
  const [channel, setChannel] = useState(row ? String(row.channel) : "");
  const [source, setSource] = useState(row?.source ?? "");
  const [device, setDevice] = useState(row?.device ?? "");
  const [cable, setCable] = useState(row?.cable ?? "");
  const [notes, setNotes] = useState(row?.notes ?? "");
  const saving = row ? changeRow : addRow;
  // Whole digits only: "3abc" or "1.5" is not channel 3 or 1.
  const typed = channel.trim();
  const number = /^\d{1,3}$/.test(typed) ? Number(typed) : undefined;
  const valid = typed === "" || (number !== undefined && number >= 1);
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const fields = { source, device, cable, notes };
    // The microphone chosen is linked to the row, so the plan and the list name it alike.
    const link = async (rowId: string | undefined) => {
      if (mic && rowId) {
        try {
          await sendStep(mic.planId, {
            add: [],
            change: [{ id: mic.id, patchRowId: rowId }],
            remove: [],
          });
        } catch (failure) {
          // The row is saved; the dialog stays open to say the link was not made.
          setLinkFailure(failure instanceof Error ? failure.message : "Not linked");
          return;
        } finally {
          refresh();
        }
      }
      onClose();
    };
    if (row)
      changeRow.mutate(
        { id: row.id, ...fields, ...(number ? { channel: number } : {}) },
        { onSuccess: () => void link(row.id) },
      );
    else
      addRow.mutate(
        { boxId: box.id, direction, channel: number, ...fields },
        { onSuccess: (made) => void link((made as { row?: { id: string } }).row?.id) },
      );
  };
  return (
    <Dialog
      title={row ? `Edit ${words.one} ${row.channel}` : `Add an ${words.one}`}
      description={box.name}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="patch-row"
            disabled={!valid || saving.isPending}
          >
            {row ? "Save" : "Add"}
          </Button>
        </>
      }
    >
      <form id="patch-row" onSubmit={save} className="grid grid-cols-1 gap-3 @xl/app:grid-cols-2">
        {/* Named as the table heads its columns (#659). */}
        <Field
          label={words.heading}
          hint={row ? undefined : "Left blank, the next free one."}
          error={
            valid
              ? (saving.error?.message ??
                (linkFailure
                  ? `Saved, but not linked to the stage plan: ${linkFailure}`
                  : undefined))
              : "A number from 1 to 999"
          }
        >
          <Input inputMode="numeric" value={channel} onChange={(e) => setChannel(e.target.value)} />
        </Field>
        <Field
          label="Source"
          hint={
            linkedMic
              ? `The stage plan's ${linkedMic.label}: its label there follows this list.`
              : undefined
          }
        >
          <span className="flex gap-2">
            <Input
              autoFocus
              value={source}
              maxLength={80}
              className="min-w-0 flex-1"
              onChange={(e) => {
                setSource(e.target.value);
                if (mic && e.target.value !== linkedMic?.label) setMic(null);
              }}
            />
            {direction === "input" && mics.length > 0 && (
              <Dropdown
                value="Stage plan"
                align="right"
                label="A microphone on the stage plan"
                actions={mics.map((m) => ({
                  label: m.where ? `${m.label} (${m.where})` : m.label,
                  checked: m.id === linkedMic?.id,
                  onSelect: () => {
                    setMic({ planId: m.planId, id: m.id });
                    setSource(m.label);
                  },
                }))}
              />
            )}
          </span>
        </Field>
        <Field label="Device">
          <Input
            value={device}
            maxLength={80}
            placeholder="Optional"
            onChange={(e) => setDevice(e.target.value)}
          />
        </Field>
        <Field label="Cable">
          <Input
            value={cable}
            maxLength={40}
            placeholder="Optional"
            onChange={(e) => setCable(e.target.value)}
          />
        </Field>
        <Field label="Notes" className="@xl/app:col-span-2">
          <Input
            value={notes}
            maxLength={200}
            placeholder="Optional"
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}
