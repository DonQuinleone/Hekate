import type { ReactNode } from "react";
import { useViewer } from "./context.tsx";

/** The lamps in the room: slow, warm and cool, behind the chrome. */
export function Ambient() {
  return (
    <div className="ambient" aria-hidden="true">
      <div className="lamp lamp-warm" />
      <div className="lamp lamp-cool" />
      <div className="lamp lamp-deep" />
    </div>
  );
}

/**
 * The app runs inside one container, so its breakpoints are the container's: at phone
 * width it is shown in a 390 by 844 frame on the desk, the way it would be held.
 */
export function Frame({ children }: { children: ReactNode }) {
  const { settings } = useViewer();
  if (settings.width === "phone") {
    return (
      <div className="relative flex h-full items-center justify-center overflow-auto bg-canvas p-6">
        <Ambient />
        <div
          className="@container/app relative z-10 h-[844px] w-[390px] shrink-0 overflow-hidden rounded-[32px] border border-edge bg-ground shadow-4"
          data-flat={settings.shadows ? undefined : ""}
        >
          {children}
        </div>
      </div>
    );
  }
  return (
    <div
      className="@container/app relative h-full bg-canvas"
      data-flat={settings.shadows ? undefined : ""}
    >
      <Ambient />
      <div className="relative z-10 h-full">{children}</div>
    </div>
  );
}
