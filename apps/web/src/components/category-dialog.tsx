import { type CategoryHandling, categoryHandlings, handlingWords } from "@hekate/shared";
import { type FormEvent, useState } from "react";
import type { CategoryMutations, CommentCategory } from "~/lib/queries";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Input, Select } from "./ui/input";

/**
 * A new comment category, or one renamed or handled differently: a project's own, or one of
 * the workspace's set for new projects (decision 247), whichever `mutations` saves to.
 */
export function CategoryDialog({
  mutations,
  category,
  onClose,
}: {
  mutations: CategoryMutations;
  category: CommentCategory | null;
  onClose: () => void;
}) {
  const { create, update } = mutations;
  const [name, setName] = useState(category?.name ?? "");
  const [handling, setHandling] = useState<CategoryHandling>(category?.handling ?? "normal");
  const [stage, setStage] = useState(category?.stage ?? "");
  const saving = category ? update : create;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = { name, handling, stage: handling === "deferred" ? stage : null };
    if (category) update.mutate({ id: category.id, ...input }, { onSuccess: onClose });
    else create.mutate(input, { onSuccess: onClose });
  };
  return (
    <Dialog
      title={category ? `Change ${category.name}` : "New category"}
      onClose={onClose}
      width="sm"
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Name
          <Input
            value={name}
            required
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
            placeholder="For example Noise"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Handling
          <Select
            value={handling}
            onChange={(event) => setHandling(event.target.value as CategoryHandling)}
          >
            {categoryHandlings.map((h) => (
              <option key={h} value={h}>
                {handlingWords[h]}
              </option>
            ))}
          </Select>
        </label>
        {handling === "deferred" && (
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            Stage
            <Input
              value={stage}
              required
              maxLength={80}
              onChange={(event) => setStage(event.target.value)}
              placeholder="For example Noise reduction"
            />
          </label>
        )}
        {saving.error && <p className="text-[13px] text-signal">{saving.error.message}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="md" disabled={saving.isPending}>
            {category ? "Save" : "Add category"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
