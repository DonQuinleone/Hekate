import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { router } from "~/router";
import css from "~/styles/app.css?inline";

// The page is published inside another document, whose own stylesheet would otherwise reach
// the app (it coloured headings for its light theme). A shadow root keeps the two apart.
const host = document.getElementById("root");
if (!host) throw new Error("No root element");
for (const el of [document.documentElement, document.body, host]) {
  el.style.height = "100%";
  el.style.margin = "0";
}
const shadow = host.attachShadow({ mode: "open" });
const style = document.createElement("style");
style.textContent = css;
shadow.append(style);
const mount = document.createElement("div");
mount.className = "hk";
shadow.append(mount);

createRoot(mount).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
