import { settingGroups, settings } from "./config.ts";

/**
 * The configuration reference (docs/configuration.md), written from the settings schema so it
 * can never say something the server does not do. `pnpm --filter @hekate/server
 * config:reference` writes it; a test fails when the file is out of date.
 */
export function configurationReference(): string {
  const all = settings();
  const cell = (text: string) => text.replaceAll("|", "\\|");
  const sections = settingGroups.map((group) => {
    const rows = all
      .filter((s) => s.info.group === group)
      .map((s) => {
        const value = s.required
          ? "**required**"
          : s.fallback === undefined || s.fallback === ""
            ? "unset"
            : `\`${String(s.fallback)}\``;
        const notes = [
          cell(s.info.description),
          s.info.example ? `Example: \`${cell(s.info.example)}\`.` : "",
          s.info.secret ? `Or \`${s.name}_FILE\`, naming a file that holds it.` : "",
        ]
          .filter(Boolean)
          .join(" ");
        return `| \`${s.name}\` | ${value} | ${notes} |`;
      });
    return [
      `## ${group}`,
      "",
      "| Setting | Default | What it does |",
      "| --- | --- | --- |",
      ...rows,
    ].join("\n");
  });
  return [
    "# Configuration",
    "",
    "<!-- Written by `pnpm --filter @hekate/server config:reference` from apps/server/src/config.ts. Do not edit by hand. -->",
    "",
    "Hekate is configured through environment variables, in `.env` for the Compose file. Every one is checked at start-up: if any is missing or wrong, Hekate lists them all, says what would be valid, and does not start.",
    "",
    "A setting marked as secret may instead name a file that holds it, with `_FILE` added to its name (for Docker secrets): `AUTH_SECRET_FILE=/run/secrets/auth_secret`.",
    "",
    ...sections.flatMap((section) => [section, ""]),
    "## Storage",
    "",
    "Storage backends are named in `STORAGE_BACKENDS` (default `local`), and each is configured by settings carrying its name: for a backend called `archive`, `STORAGE_ARCHIVE_DRIVER` and so on. `STORAGE_DEFAULT` names the backend new files go to (the first listed, unless set). Every backend is checked at start-up; Hekate will not start with one it cannot reach or write to.",
    "",
    "| Setting | Default | What it does |",
    "| --- | --- | --- |",
    "| `STORAGE_BACKENDS` | `local` | The backends, comma separated: lower-case letters, digits and hyphens. |",
    "| `STORAGE_DEFAULT` | the first listed | Where new files go. |",
    "| `STORAGE_<NAME>_DRIVER` | `local` or `s3` for backends of those names | `local` or `s3`. |",
    "| `STORAGE_<NAME>_PATH` | `data/storage` for `local` | Local: the directory objects are kept in. |",
    "| `STORAGE_<NAME>_BUCKET` | **required** for S3 | S3: the bucket. |",
    "| `STORAGE_<NAME>_REGION` | unset | S3: the region. |",
    "| `STORAGE_<NAME>_ENDPOINT` | unset | S3: the endpoint, for an S3-compatible service other than AWS. |",
    "| `STORAGE_<NAME>_FORCE_PATH_STYLE` | `false` | S3: address the bucket in the path, as most S3-compatible services need. |",
    "| `STORAGE_<NAME>_ACCESS_KEY_ID` | unset | S3: the access key; set with the secret, or neither to use the environment's credentials. Or `_FILE`. |",
    "| `STORAGE_<NAME>_SECRET_ACCESS_KEY` | unset | S3: the secret key. Or `_FILE`. |",
    "| `STORAGE_<NAME>_PREFIX` | unset | S3: a prefix for every object, to share a bucket. |",
    "",
    "Whatever the backend, it holds only ciphertext: every file is encrypted with its own key before it is written (docs/security.md).",
    "",
  ].join("\n");
}
