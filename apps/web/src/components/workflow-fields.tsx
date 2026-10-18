import type { WorkflowNode } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Input, Select } from "~/components/ui/input";
import { cn } from "~/lib/cn";
import { projectGroupsQuery, projectRolesQuery } from "~/lib/queries";
import type { NodeField } from "~/lib/workflow-nodes";

/**
 * One setting of a step: chosen from its options or the project's people, or written, as the
 * prototype has them. Written words are kept when the field is left or Return pressed.
 */
export function StepField({
  projectId,
  node,
  field,
  editing,
  onChange,
  stacked = false,
}: {
  projectId: string;
  node: WorkflowNode;
  field: NodeField;
  editing: boolean;
  onChange: (value: string) => void;
  /** Its label above it, full width, as the canvas's inspector has it. */
  stacked?: boolean;
}) {
  const { data: roles } = useQuery({ ...projectRolesQuery(projectId), enabled: !!field.people });
  // Groups are asked as themselves by a review; a task or a notification reaches roles only.
  const withGroups = !!field.people && (node.type === "approval" || node.type === "feedback");
  const { data: groups } = useQuery({ ...projectGroupsQuery(projectId), enabled: withGroups });
  const value = node.config[field.id] ?? "";
  const label = `${node.name}: ${field.label.toLowerCase()}`;
  const options = field.people
    ? [
        ...(field.id === "to" ? ["Everyone in the project"] : []),
        ...(roles ?? []).map((r) => r.name),
        ...(withGroups ? (groups ?? []) : []).map((g) => g.name),
      ]
    : field.options;
  return (
    // The control is named on its own, so this only lays the words beside it.
    <span
      className={cn(
        "flex text-[12px] text-ink-3",
        stacked ? "flex-col gap-1.5" : "items-center gap-1.5 whitespace-nowrap",
      )}
    >
      <span aria-hidden="true">{field.label}</span>
      {options ? (
        <Select
          className={stacked ? undefined : "w-auto"}
          size={stacked ? "md" : "sm"}
          aria-label={label}
          value={field.people ? value : value || options[0]}
          disabled={!editing}
          onChange={(e) => onChange(e.target.value)}
        >
          {field.people && <option value="">Nobody yet</option>}
          {/* Someone named another way (a guest, several at once) stays as named. */}
          {value && !options.includes(value) && <option value={value}>{value}</option>}
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      ) : (
        <Committed
          label={label}
          value={value}
          placeholder={field.placeholder}
          className={stacked ? undefined : "w-28"}
          size={stacked ? "md" : "sm"}
          disabled={!editing}
          onCommit={onChange}
        />
      )}
    </span>
  );
}

/** Words kept when the field is left or Return is pressed, not at every key. */
export function Committed({
  label,
  value,
  placeholder,
  className,
  size = "sm",
  disabled,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  className?: string;
  size?: "sm" | "md";
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  return (
    <Input
      size={size}
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      className={className}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(value);
      }}
    />
  );
}
