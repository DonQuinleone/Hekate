import { createContext, type ReactNode, useContext } from "react";

/**
 * Who is looking: a member, or a guest reviewer. Pages shared by both (a review, a file)
 * read this to link within the right area and to offer only what the viewer may do; the
 * server decides either way.
 */
export interface Viewer {
  guest: boolean;
}

const ViewerContext = createContext<Viewer>({ guest: false });

export function ViewerProvider({ viewer, children }: { viewer: Viewer; children: ReactNode }) {
  return <ViewerContext.Provider value={viewer}>{children}</ViewerContext.Provider>;
}

export const useViewer = () => useContext(ViewerContext);
