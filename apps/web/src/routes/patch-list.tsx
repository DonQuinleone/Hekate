import type { PatchDirection, PatchRow, StageBox } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { ProductionNav } from "~/components/production-nav";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { ActionMenu, Dropdown } from "~/components/ui/menu";
import { patchQuery, usePatchList, useProjectCan } from "~/lib/queries";
import { ProjectFrame } from "./project";

const directionWords: Record<PatchDirection, { heading: string; one: string }> = {
  input: { heading: "In", one: "input" },
  output: { heading: "Out", one: "output" },
};

/**
 * The patch list (#54), in Production as the prototype has it: the project's stage boxes, each
 * with its inputs and outputs (source, device, cable or channel, notes). Those who see the
 * production tools read it; those who use them change it.
 */
export function PatchListPage({ projectId }: { projectId: string }) {
  const can = useProjectCan(projectId);
  const { data: boxes, error } = useQuery({
    ...patchQuery(projectId),
    enabled: can("view_production"),
  });
  return (
    <ProjectFrame projectId={projectId} title="Patch list">
      {(project) => (
        <div className="fade-in mx-auto flex w-full max-w-[1100px] flex-col gap-5 px-5 py-6 @3xl/app:px-10">
          <ProductionNav projectId={projectId} current="patch" can={can} />
          {!can("view_production") ? (
            <Empty
              title="Not among what your role shows"
              text="The patch list is shown to the roles the project's access gives the production tools."
            />
          ) : error ? (
            <p className="m-0 text-signal">{error.message}</p>
          ) : !boxes ? (
            <p className="m-0 text-ink-3">Loading</p>
          ) : (
            <PatchList
              projectId={projectId}
              boxes={boxes}
              canEdit={can("edit_production") && !project.archivedAt}
            />
          )}
        </div>
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
  const [editing, setEditing] = useState<Editing | null>(null);
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
            <span className="label">Stage boxes · {boxes.length}</span>
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
                  Stage box
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
                      { label: "Rename", onSelect: () => setEditing({ kind: "box", box }) },
                      "divider",
                      { label: "Remove", danger: true, onSelect: () => removeBox.mutate(box.id) },
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
                    <table className="w-full min-w-[520px] table-fixed text-[13px]">
                      <caption className="sr-only">
                        {box.name}, {words.one}s
                      </caption>
                      <colgroup>
                        <col className="w-14" />
                        <col className="w-[22%]" />
                        <col className="w-[22%]" />
                        <col className="w-[12%]" />
                        <col />
                        <col className="w-10" />
                      </colgroup>
                      <thead>
                        <tr className="text-left">
                          {[words.heading, "Source", "Device", "Cable", "Notes"].map((h) => (
                            <th key={h} className="px-3 py-2 font-normal">
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
                            <td className="truncate px-3 py-1.5 text-ink">{r.source}</td>
                            <td className="truncate px-3 py-1.5 text-ink-2">{r.device}</td>
                            <td className="truncate tabular px-3 py-1.5 text-ink-2">{r.cable}</td>
                            <td className="truncate px-3 py-1.5 text-ink-3">{r.notes}</td>
                            <td className="px-1 py-1 text-right">
                              {canEdit && (
                                <ActionMenu
                                  label={`${words.one} ${r.channel}`}
                                  actions={[
                                    {
                                      label: "Edit",
                                      onSelect: () =>
                                        setEditing({ kind: "row", box, direction, row: r }),
                                    },
                                    "divider",
                                    {
                                      label: "Remove",
                                      danger: true,
                                      onSelect: () => removeRow.mutate(r.id),
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
          <Input
            autoFocus
            value={name}
            maxLength={60}
            placeholder="Stage box A"
            onChange={(e) => setName(e.target.value)}
          />
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
  const words = directionWords[direction];
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
    if (row)
      changeRow.mutate(
        { id: row.id, ...fields, ...(number ? { channel: number } : {}) },
        { onSuccess: onClose },
      );
    else
      addRow.mutate(
        { boxId: box.id, direction, channel: number, ...fields },
        { onSuccess: onClose },
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
        <Field
          label="Channel"
          hint={row ? undefined : "Left blank, the next free one"}
          error={valid ? saving.error?.message : "A channel from 1 to 999"}
        >
          <Input inputMode="numeric" value={channel} onChange={(e) => setChannel(e.target.value)} />
        </Field>
        <Field label="Source">
          <Input
            autoFocus
            value={source}
            maxLength={80}
            placeholder={direction === "input" ? "Main L" : "Talkback"}
            onChange={(e) => setSource(e.target.value)}
          />
        </Field>
        <Field label="Device">
          <Input
            value={device}
            maxLength={80}
            placeholder={direction === "input" ? "DPA 4006" : "Headphone amp"}
            onChange={(e) => setDevice(e.target.value)}
          />
        </Field>
        <Field label="Cable or channel">
          <Input
            value={cable}
            maxLength={40}
            placeholder="A1"
            onChange={(e) => setCable(e.target.value)}
          />
        </Field>
        <Field label="Notes" className="@xl/app:col-span-2">
          <Input
            value={notes}
            maxLength={200}
            placeholder={direction === "input" ? "Lid on the short stick" : "To the piano"}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}
