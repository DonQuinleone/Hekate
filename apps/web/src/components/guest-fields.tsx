import type { GuestInput } from "@hekate/shared";
import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/**
 * What a guest's label is called on every form (#557): it is shown beside their name, and is
 * no role, which in a project is a set of permissions.
 */
export const shownAs = {
  label: "Shown as",
  hint: "Beside their name, for example Conductor, Composer or Violin.",
} as const;

/** Add a guest reviewer by name and email: someone outside the workspace, without an account. */
export function GuestFields({
  onAdd,
  submitLabel = "Add guest",
}: {
  onAdd: (guest: GuestInput) => void;
  submitLabel?: string;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [label, setLabel] = useState("");
  const valid = name.trim() && /^[^\s@]+@[^\s@]+$/.test(email.trim());
  const add = () => {
    if (!valid) return;
    onAdd({ name: name.trim(), email: email.trim(), label: label.trim() || undefined });
    setName("");
    setEmail("");
    setLabel("");
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        className="h-8 w-auto min-w-36 flex-1 text-[13px]"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name"
        aria-label="Guest name"
      />
      <Input
        className="h-8 w-auto min-w-44 flex-1 text-[13px]"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
        aria-label="Guest email"
      />
      <Input
        className="h-8 w-32 text-[13px]"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Shown as (optional)"
        aria-label={`${shownAs.label}: ${shownAs.hint}`}
      />
      <Button size="sm" disabled={!valid} onClick={add}>
        {submitLabel}
      </Button>
    </div>
  );
}
