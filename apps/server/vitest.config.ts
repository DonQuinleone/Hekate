import { defineProject } from "vitest/config";

// API and job tests share one test database and truncate it between cases, so the
// server's test files run one at a time.
export default defineProject({ test: { name: "server", fileParallelism: false } });
