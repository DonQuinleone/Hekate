import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  // The drift test generates into a copy of the migrations, leaving these untouched.
  out: process.env.DRIZZLE_OUT ?? "./migrations",
  casing: "snake_case",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://hekate:hekate@localhost:5432/hekate",
  },
});
