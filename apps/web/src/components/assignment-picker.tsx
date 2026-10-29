import type { CommentAssignment } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Select } from "~/components/ui/input";
import { projectMembersQuery, projectRolesQuery, useProjectCan } from "~/lib/queries";

/** A rule as the select's value: what it inherits (""), nobody, a member or a role. */
const optionOf = (rule: CommentAssignment | null | undefined): string => {
  if (!rule) return "";
  if (!rule.assign) return "none";
  return rule.assign.kind === "member"
    ? `member:${rule.assign.userId}`
    : `role:${rule.assign.roleId}`;
};

const ruleOf = (value: string): CommentAssignment | null => {
  if (value === "") return null;
  if (value === "none") return { assign: null };
  const [kind, id] = value.split(":", 2) as [string, string];
  return kind === "member"
    ? { assign: { kind: "member", userId: id } }
    : { assign: { kind: "role", roleId: id } };
};

/**
 * Whom new comments are for (#499, decision 279): one of the project's members or roles, nobody,
 * or (where the place it is set can defer to another) what it inherits. One control in the
 * project's settings, a track's override and a stage's inspector, so the choice reads alike.
 */
export function AssignmentPicker({
  projectId,
  value,
  inherits,
  disabled = false,
  size = "md",
  className,
  "aria-label": ariaLabel,
  onChange,
}: {
  projectId: string;
  value: CommentAssignment | null | undefined;
  /** What an unset rule falls back to ("Project default"); left out where there is nothing. */
  inherits?: string;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
  "aria-label": string;
  onChange: (rule: CommentAssignment | null) => void;
}) {
  // The lists need to see the project's people; the field still shows the rule without them.
  const can = useProjectCan(projectId);
  const sees = can("view_people");
  const { data: members = [] } = useQuery({ ...projectMembersQuery(projectId), enabled: sees });
  const { data: roles = [] } = useQuery({ ...projectRolesQuery(projectId), enabled: sees });
  const current = optionOf(value);
  const listed =
    current === "" ||
    current === "none" ||
    members.some((m) => `member:${m.userId}` === current) ||
    roles.some((r) => `role:${r.id}` === current);
  return (
    <Select
      size={size}
      className={className}
      aria-label={ariaLabel}
      value={current}
      disabled={disabled}
      onChange={(e) => onChange(ruleOf(e.target.value))}
    >
      {inherits !== undefined && <option value="">{inherits}</option>}
      <option value="none">Nobody</option>
      {/* A member or role since gone keeps its place until another is chosen. */}
      {!listed && <option value={current}>No longer in the project</option>}
      {roles.length > 0 && (
        <optgroup label="Whoever holds the role">
          {roles.map((r) => (
            <option key={r.id} value={`role:${r.id}`}>
              {r.name}
            </option>
          ))}
        </optgroup>
      )}
      {members.length > 0 && (
        <optgroup label="Members">
          {members.map((m) => (
            <option key={m.userId} value={`member:${m.userId}`}>
              {m.name}
            </option>
          ))}
        </optgroup>
      )}
    </Select>
  );
}
