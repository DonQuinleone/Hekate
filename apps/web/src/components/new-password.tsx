import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/cn";
import { passwordStrength } from "~/lib/password";

/** What a form says when the confirmation is not the password. */
export const PASSWORDS_DIFFER = "The two passwords are not the same.";

/** Whether a form's two password fields agree: its `password` and its `confirm`. */
export const passwordsAgree = (form: FormData) => form.get("password") === form.get("confirm");

/**
 * Setting a new password (#687), the one way everywhere: reset, sign-up, an invitation and the
 * installer. "New password" with its strength drawn as wide as the field and the rule under it,
 * then "Confirm password". The form reads them as `password` and `confirm`.
 */
export function NewPassword({
  value,
  onChange,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  const strength = passwordStrength(value);
  return (
    <>
      <Field
        label="New password"
        hint={
          <span className="flex items-baseline justify-between gap-3">
            <span>12 characters or more</span>
            <span aria-live="polite" className="text-ink-2">
              {value ? strength.label : ""}
            </span>
          </span>
        }
      >
        <Input
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-10"
        />
        <span aria-hidden="true" className="flex gap-1">
          {[1, 2, 3, 4].map((n) => (
            <span
              key={n}
              className={cn(
                "h-1 flex-1 rounded-full",
                n <= strength.score ? "bg-ink-2" : "bg-raised",
              )}
            />
          ))}
        </span>
      </Field>
      <Field label="Confirm password">
        <Input
          name="confirm"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          className="h-10"
        />
      </Field>
    </>
  );
}
