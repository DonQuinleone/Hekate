import {
  createHashHistory,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";

/** The prototype lives at one address, so the hash carries the route; where the hash cannot be written (a locked-down frame), memory does. */
function history() {
  try {
    const h = createHashHistory();
    h.location;
    return h;
  } catch {
    return createMemoryHistory();
  }
}

const root = createRootRoute({
  component: Outlet,
  notFoundComponent: () => <p className="p-8 text-ink-3">Not found.</p>,
});

const home = createRoute({
  getParentRoute: () => root,
  path: "/",
  component: () => (
    <div className="flex h-full items-center justify-center text-ink-3">Hekate prototype</div>
  ),
});

export const router = createRouter({
  routeTree: root.addChildren([home]),
  history: history(),
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
