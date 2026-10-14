import type { GuestInput } from "@hekate/shared";
import { useState } from "react";
import { cn } from "~/lib/cn";
import { Button } from "./ui/button";

const control =
  "h-8 rounded-control border border-edge bg-ground px-3 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-ink-3";

/** Add a guest reviewer by name and email: someone outside the organisation, without an account. */
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
      <input
        className={cn(control, "min-w-36 flex-1")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name"
        aria-label="Guest name"
      />
      <input
        className={cn(control, "min-w-44 flex-1")}
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
        aria-label="Guest email"
      />
      <input
        className={cn(control, "w-32")}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Role (optional)"
        aria-label="Guest role"
      />
      <Button size="sm" disabled={!valid} onClick={add}>
        {submitLabel}
      </Button>
    </div>
  );
}
