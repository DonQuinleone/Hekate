import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The prototype is one page with no backend. It is built with relative paths and a single
 * script, so scripts/artifact.mjs can fold it into one file for publishing as an artifact.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  resolve: { alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: 5174 },
  build: {
    chunkSizeWarningLimit: 2000,
    rolldownOptions: { output: { codeSplitting: false } },
  },
});
