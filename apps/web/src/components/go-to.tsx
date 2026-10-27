import { useState } from "react";
import { cn } from "~/lib/cn";
import { Input } from "./ui/input";

/**
 * A number typed and Enter pressed: the page (or bar) to go to, as a PDF reader's page field
 * works. The field empties once it has been used; a number below `min` is let go.
 */
export function GoToField({
  label,
  onGo,
  min = 1,
  className,
}: {
  /** What it goes to, as its label and placeholder: "Go to page", "Go to bar". */
  label: string;
  onGo: (n: number) => void;
  min?: number;
  className?: string;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        const n = Number.parseInt(value, 10);
        if (n >= min) onGo(n);
        setValue("");
      }}
    >
      <Input
        size="sm"
        inputMode="numeric"
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className={cn("w-28", className)}
      />
    </form>
  );
}
