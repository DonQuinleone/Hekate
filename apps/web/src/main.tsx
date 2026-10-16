import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ShortcutMapHost } from "./components/shortcut-map";
import { ShortcutsProvider } from "./lib/shortcuts";
import { queryClient, router } from "./router";
import "./styles/app.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* Screens size themselves to this container (@3xl/app and so on), as in the prototype. */}
      <div className="@container/app relative h-full bg-canvas">
        <ShortcutsProvider>
          <RouterProvider router={router} />
          <ShortcutMapHost />
        </ShortcutsProvider>
      </div>
    </QueryClientProvider>
  </StrictMode>,
);
