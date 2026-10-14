import type { ReactNode } from "react";
import { useViewer } from "./context.tsx";

/**
 * The app runs inside one container, so its breakpoints are the container's: at phone
 * width it is shown in a 390 by 844 frame on the desk, the way it would be held.
 */
export function Frame({ children }: { children: ReactNode }) {
  const { settings } = useViewer();
  if (settings.width === "phone") {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-sunken p-6">
        <div
          className="@container/app relative h-[844px] w-[390px] shrink-0 overflow-hidden rounded-[28px] border border-edge bg-ground shadow-4"
          data-flat={settings.shadows ? undefined : ""}
        >
          {children}
        </div>
      </div>
    );
  }
  return (
    <div className="@container/app h-full bg-ground" data-flat={settings.shadows ? undefined : ""}>
      {children}
    </div>
  );
}
