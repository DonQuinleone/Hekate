import { createClient } from "@hekate/server/client";
import { watchedFetch } from "./connection";

// Each request's outcome feeds the shell's connection state (#616).
export const api = createClient("/api", { fetch: watchedFetch });
