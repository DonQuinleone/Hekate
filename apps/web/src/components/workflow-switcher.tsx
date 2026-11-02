import type { WorkflowSummary } from "@hekate/shared";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Dropdown, MenuList, usePopover } from "~/components/ui/menu";
import { WorkflowDot } from "~/components/workflow-state";
import { problemsOf, stepsOf } from "~/lib/workflow-summary";

/**
 * The project's workflows, one chosen (#582): one control in the toolbar of every view, as
 * Figma's page list stays put across its modes. Each says its state by its dot, its steps and
 * what it breaks.
 */
export function WorkflowSwitcher({
  workflows,
  current,
  onChoose,
}: {
  workflows: WorkflowSummary[];
  current: string | null | undefined;
  onChoose: (id: string) => void;
}) {
  const chosen = workflows.find((w) => w.id === current) ?? workflows[0];
  if (!chosen) return null;
  return (
    <Dropdown
      size="sm"
      label="Workflow"
      className="text-ink"
      value={
        <>
          <WorkflowDot active={chosen.active} />
          <span className="truncate">{chosen.name}</span>
          <span className="sr-only">, {chosen.active ? "active" : "draft"}</span>
        </>
      }
      actions={workflows.map((w) => ({
        label: w.name,
        icon: <WorkflowDot active={w.active} />,
        hint: [w.active ? "Active" : "Draft", stepsOf(w.definition), problemsOf(w.problems)]
          .filter(Boolean)
          .join(" · "),
        checked: w.id === chosen.id,
        onSelect: () => onChoose(w.id),
      }))}
    />
  );
}

/** A template the builder offers, as the files they ship as. */
export interface OfferedTemplate {
  id: string;
  name: string;
  text: string;
}

/**
 * New workflow (#587): blank, from one of the templates the profile is offered, or copied from
 * another project. Each makes a new workflow and leaves every other as it is.
 */
export function NewWorkflowMenu({
  templates,
  blankHint,
  disabled,
  onBlank,
  onTemplate,
  onCopy,
}: {
  templates: readonly OfferedTemplate[];
  /** What starts a blank one, in the profile's words: "Starts when a cut is uploaded". */
  blankHint: string;
  disabled?: boolean;
  onBlank: () => void;
  onTemplate: (template: OfferedTemplate) => void;
  onCopy: () => void;
}) {
  const [open, setOpen, box] = usePopover();
  return (
    <div ref={box} className="relative shrink-0">
      <Button
        variant="secondary"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <Icon name="plus" size={13} />
        New workflow
        <Icon name="chevronDown" size={12} className="text-ink-3" />
      </Button>
      {open && (
        <MenuList
          anchor={box}
          align="right"
          label="New workflow"
          onClose={() => setOpen(false)}
          actions={[
            { label: "Blank workflow", hint: blankHint, onSelect: onBlank },
            "divider",
            { heading: "From a template" },
            ...templates.map((t) => ({ label: t.name, onSelect: () => onTemplate(t) })),
            "divider",
            { label: "From another project…", onSelect: onCopy },
          ]}
        />
      )}
    </div>
  );
}
