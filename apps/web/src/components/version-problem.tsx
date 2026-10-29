import type { ReactNode } from "react";
import { ApiError } from "~/lib/queries";
import { Icon } from "./icons";
import { Button } from "./ui/button";

/**
 * What the upload dialog shows when a new version is refused by the project's checks (a true
 * peak over the ceiling, no edit decision list) or is still being measured: the reason, a way
 * to try again while it measures, and for those who may edit workflows a way to let it
 * through. Anything else is left to the dialog's own message.
 */
export const versionProblem =
  (mayLetThrough: boolean) =>
  (error: Error, again: (hint?: unknown) => void): ReactNode => {
    const refused = error instanceof ApiError && error.code === "version_refused";
    const measuring = error instanceof ApiError && error.code === "version_measuring";
    if (!refused && !measuring) return null;
    return (
      <div
        role="alert"
        className="flex flex-col gap-2 rounded-panel border border-signal/50 bg-signal/10 px-3 py-2 text-[14px] text-ink"
      >
        <p className="m-0 flex items-start gap-2">
          <Icon name="warning" className="mt-0.5 shrink-0 text-signal" />
          <span>{error.message}</span>
        </p>
        <div className="flex gap-2 pl-6">
          {measuring && (
            <Button variant="secondary" size="sm" onClick={() => again()}>
              Try again
            </Button>
          )}
          {refused && mayLetThrough && (
            <Button variant="secondary" size="sm" onClick={() => again("let-through")}>
              Let it through
            </Button>
          )}
        </div>
      </div>
    );
  };

/** Whether a retry from `versionProblem` asked for the version to be let through. */
export const letThrough = (hint: unknown) => hint === "let-through";
