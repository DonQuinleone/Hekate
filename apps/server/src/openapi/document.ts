import {
  API_VERSION,
  type ApiScope,
  apiErrorBody,
  apiErrorCodes,
  apiScopeLabels,
  apiScopes,
  scopeFor,
} from "@hekate/shared";
import type { z } from "zod";
import { type ApiOperation, apiOperations, type BinaryBody } from "./operations.ts";
import {
  exampleOf,
  type JsonSchema,
  jsonSchemaOf,
  openapiPath,
  samplePath,
  successStatus,
} from "./schema.ts";
import { validatedBy } from "./validator.ts";

/**
 * The public API's OpenAPI 3.1 document (#197, decision 224), read from the routes themselves:
 * which calls there are from Hono's route table, which a token may make (and with which scope)
 * from `scopeFor`, and what each takes from the zod schemas its validators check. Only the words
 * (a summary, sometimes a description and examples) are written by hand, in `operations.ts`.
 */

/** A public route, as the router holds it. */
export interface PublicRoute {
  method: string;
  /** The path as Hono writes it, under `/api`: `/files/:id/comments`. */
  route: string;
  /** The path as OpenAPI writes it, under the version's base: `/files/{id}/comments`. */
  path: string;
  scope: ApiScope;
  validators: Partial<Record<"json" | "query" | "param" | "header", z.ZodType>>;
  /** The handler's source, which says how it answers. */
  source: string;
}

/** `GET /files/{id}`: how `operations.ts` names an operation. */
export const operationKey = (method: string, path: string) => `${method} ${path}`;

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** What the document is read from: a Hono app's route table. */
export interface RouteTable {
  routes: readonly { method: string; path: string; handler: unknown }[];
}

/** Every route an API token may reach, in the order the router holds them. */
export function publicRoutes(api: RouteTable): PublicRoute[] {
  const found = new Map<string, PublicRoute>();
  for (const entry of api.routes) {
    if (!METHODS.has(entry.method)) continue;
    const scope = scopeFor(entry.method, `/api${samplePath(entry.path)}`);
    if (!scope) continue;
    const key = operationKey(entry.method, entry.path);
    const route = found.get(key) ?? {
      method: entry.method,
      route: entry.path,
      path: openapiPath(entry.path).path,
      scope,
      validators: {},
      source: "",
    };
    const validated = validatedBy(entry.handler);
    if (validated) {
      if (
        validated.target === "json" ||
        validated.target === "query" ||
        validated.target === "param" ||
        validated.target === "header"
      )
        route.validators[validated.target] = validated.schema;
    } else route.source = String(entry.handler);
    found.set(key, route);
  }
  return [...found.values()];
}

/** Which group an operation is listed under, by its path; `operations.ts` may say otherwise. */
const tagRules: [RegExp, string][] = [
  [/^\/files\/\{id\}\/(comments|mentionable|attachments\/\{\w+\}$)/, "Comments"],
  [/^\/(comments|comment-carries)\b|^\/tracks\/\{id\}\/carry$/, "Comments"],
  [/downloads?\b/, "Downloads"],
  [/^\/reviews\b|^\/projects\/\{id\}\/(reviews|guests|groups|reviewer-grants)\b/, "Reviews"],
  [/workflow/, "Workflows"],
  [/^\/uploads\b/, "Uploads"],
  [/upload-requests/, "Uploads"],
  [/^\/(versions|variations)\b|^\/tracks\/\{id\}\/versions$/, "Versions and variations"],
  [/takes|sessions/, "Takes and sessions"],
  [/score-marks|score-categories/, "Scores"],
  [/patch|stage-|personnel|repertoire|works|venues|schedule/, "Production"],
  [/tasks|board|calendar/, "Tasks"],
  [/^\/tags\b/, "Tags and categories"],
  [/categories/, "Tags and categories"],
  [/^\/(search|home)\b/, "Search"],
  [/^\/organisation\b/, "Workspace"],
  [/^\/folders\b/, "Folders"],
  [/\/folders$/, "Folders"],
  [/^\/tracks\b/, "Tracks"],
  [/\/tracks$/, "Tracks"],
  [/^\/files\b/, "Files"],
  [/\/files$/, "Files"],
  [/^\/projects\b/, "Projects"],
];

/** The groups, in the order the reference lists them. */
export const apiTags = [
  ["Projects", "Projects, their storage and their overview."],
  ["Folders", "Folders in a project."],
  ["Files", "Files of any kind: details, measurements, checks, tags and captions."],
  ["Tracks", "Tracks, pieces of music, with their references and comparisons."],
  ["Versions and variations", "A track's successive versions, and each version's variations."],
  ["Uploads", "Sending files in chunks, and upload requests for people outside."],
  ["Comments", "Comments on a file, their anchors, attachments and to-dos."],
  ["Reviews", "Approvals and feedback, reviewers, guests and groups."],
  ["Downloads", "Originals and proxies, watermarked for the token's member and logged."],
  ["Workflows", "A project's workflows, statuses and runs."],
  ["Takes and sessions", "Recording sessions, and the takes made in them."],
  ["Scores", "Score marks and their categories."],
  ["Production", "Schedules, stage plans, the patch, personnel and repertoire."],
  ["Tasks", "Tasks, the board and the project calendar."],
  ["Tags and categories", "The workspace's tags and comment categories."],
  ["Search", "Searching the workspace, saved searches, and the home page."],
  ["Workspace", "The workspace's members, plan and settings, read-only."],
] as const;

export const tagOf = (path: string): string =>
  tagRules.find(([pattern]) => pattern.test(path))?.[1] ?? "Projects";

/** `getProjectsIdFolders`: stable, so generated clients keep their method names. */
export const operationIdOf = (method: string, path: string) =>
  method.toLowerCase() +
  path
    .split("/")
    .filter(Boolean)
    .map((part) =>
      part
        .replace(/[{}]/g, "")
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((w) => w[0]?.toUpperCase() + w.slice(1))
        .join(""),
    )
    .join("");

export interface DocumentOptions {
  /** Where the version's calls go: the instance's own address, or a placeholder for the docs. */
  server: { url: string; description?: string; variables?: Record<string, unknown> };
  /** The documentation site, linked from the document. */
  docsUrl?: string;
}

const errorResponse = (description: string, example: unknown, headers?: JsonSchema) => ({
  description,
  ...(headers ? { headers } : {}),
  content: {
    "application/json": { schema: { $ref: "#/components/schemas/Error" }, example },
  },
});

const codeList = (status: number) =>
  Object.entries(apiErrorCodes)
    .filter(([, c]) => c.status === status)
    .map(([code, c]) => `- \`${code}\`: ${c.meaning}`)
    .join("\n");

const components = {
  securitySchemes: {
    token: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "hk_pat_… (a member's) or hk_svc_… (a service token)",
      description: `An API token, sent in each call's \`Authorization\` header. Each operation names the scope it needs:\n\n${apiScopes.map((s) => `- \`${s}\`: ${apiScopeLabels[s]}`).join("\n")}`,
    },
  },
  schemas: { Error: jsonSchemaOf(apiErrorBody) },
  headers: {
    "Retry-After": {
      description: "Seconds to wait before calling again.",
      schema: { type: "integer", minimum: 1 },
    },
  },
  responses: {
    InvalidRequest: errorResponse(`The request did not validate.\n\n${codeList(400)}`, {
      error: {
        code: "invalid_request",
        message: "name: Give it a name",
        issues: [{ path: "name", message: "Give it a name" }],
      },
    }),
    Unauthorised: errorResponse(`The token does not work.\n\n${codeList(401)}`, {
      error: {
        code: "token_invalid",
        message: "That API token does not work: it may have been revoked, or have expired.",
      },
    }),
    Forbidden: errorResponse(`The call is refused.\n\n${codeList(403)}`, {
      error: {
        code: "insufficient_scope",
        message:
          "That needs the files:write scope (upload versions and variations, make folders, change files), which this token does not have.",
      },
    }),
    NotFound: errorResponse(`Nothing there that the token may see.\n\n${codeList(404)}`, {
      error: { code: "not_found", message: "File not found" },
    }),
    RateLimited: errorResponse(
      `Too many calls.\n\n${codeList(429)}`,
      {
        error: {
          code: "rate_limited",
          message: "This token has made too many calls. Wait a moment and try again.",
        },
      },
      { "Retry-After": { $ref: "#/components/headers/Retry-After" } },
    ),
    Failure: errorResponse(
      `Hekate failed. The \`reference\` leads the instance's operator to what happened (#159).\n\n${codeList(500)}`,
      { error: { code: "internal", message: "Something went wrong", reference: "HK-7F3A-2C" } },
    ),
  },
};

/** The document's opening words: how to authenticate, what a version promises, errors. */
const introduction = (docsUrl: string) =>
  [
    "Hekate's public API: the calls an API token may make, versioned and stable.",
    "",
    "**Authentication.** Send an API token in each call's `Authorization` header (`Bearer hk_pat_…`). A member's token acts as them, within its scopes; a service token acts for the workspace. Each operation names the scope it needs.",
    "",
    `**Versions.** This is version ${API_VERSION}, under \`/api/v${API_VERSION}\`. Within a version, changes only add: new operations, new optional fields in a request, new fields in an answer, new error codes. Read answers leniently and ignore fields you do not know. Anything that would break a script (removing or renaming an operation or a field, a field newly required, a narrower type) waits for the next version, and a version is answered for at least two releases after the next one arrives, its answers carrying \`Deprecation\` and \`Sunset\` headers meanwhile.`,
    "",
    '**Errors.** Every refusal and failure is `{ "error": { "code", "message" } }`: act on the `code`; the message is for people. A request that does not validate adds `issues`; a failure (5xx) adds a `reference` to quote to the instance\'s operator. Every answer carries `X-Request-Id`.',
    "",
    `**Limits.** Each token may make 600 calls a minute; past that, \`429\` with \`Retry-After\`. Every call is written to the workspace's API log. See ${docsUrl}/use/api/ for the guide.`,
  ].join("\n");

function parametersOf(route: PublicRoute, operation: ApiOperation | undefined) {
  const out: JsonSchema[] = [];
  const declared = route.validators.param ? jsonSchemaOf(route.validators.param) : null;
  const props = (declared?.properties ?? {}) as Record<string, JsonSchema>;
  for (const p of openapiPath(route.route).parameters) {
    const schema =
      props[p.name] ?? (p.choices ? { type: "string", enum: p.choices } : { type: "string" });
    out.push({ name: p.name, in: "path", required: true, schema });
  }
  for (const target of ["query", "header"] as const) {
    const given = route.validators[target];
    if (!given) continue;
    const schema = jsonSchemaOf(given);
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    for (const [name, inner] of Object.entries(
      (schema.properties ?? {}) as Record<string, JsonSchema>,
    )) {
      const { description, ...rest } = inner;
      out.push({
        name,
        in: target,
        required: required.has(name),
        ...(typeof description === "string" ? { description } : {}),
        schema: rest,
      });
    }
  }
  for (const header of operation?.headers ?? [])
    out.push({
      name: header.name,
      in: "header",
      required: header.required,
      description: header.description,
      schema: { type: "string" },
    });
  return out;
}

const binaryRequest = (body: BinaryBody) => ({
  required: true,
  description: body.description,
  content: { [body.type]: { schema: { type: "string", contentMediaType: body.type } } },
});

/** The example a call's body is shown with: its own, else one made from its schema. */
export function requestExampleOf(route: PublicRoute, operation: ApiOperation | undefined) {
  if (operation?.request !== undefined) return operation.request;
  const json = route.validators.json;
  return json ? exampleOf(jsonSchemaOf(json)) : undefined;
}

function responsesOf(route: PublicRoute, operation: ApiOperation | undefined) {
  const status = operation?.status ?? successStatus(route.source);
  const produces = operation?.produces ?? "application/json";
  const types = Array.isArray(produces) ? produces : [produces];
  const said = {
    200: "The answer.",
    201: "Made.",
    202: "Queued.",
    204: "Done; nothing to answer.",
  };
  const success =
    status === 204
      ? { description: operation?.responds ?? said[204] }
      : {
          description: operation?.responds ?? said[status],
          content: Object.fromEntries(
            types.map((type) => [
              type,
              type === "application/json"
                ? operation?.response === undefined
                  ? { schema: {} }
                  : { schema: {}, example: operation.response }
                : { schema: { type: "string", contentMediaType: type } },
            ]),
          ),
        };
  const ref = (name: string) => ({ $ref: `#/components/responses/${name}` });
  return {
    [String(status)]: success,
    ...(Object.keys(route.validators).length > 0 ? { "400": ref("InvalidRequest") } : {}),
    "401": ref("Unauthorised"),
    "403": ref("Forbidden"),
    ...(route.path.includes("{") ? { "404": ref("NotFound") } : {}),
    "429": ref("RateLimited"),
    "500": ref("Failure"),
  };
}

/** The whole document. */
export function openapiDocument(api: RouteTable, options: DocumentOptions) {
  const docsUrl = options.docsUrl ?? "https://docs.hekate.studio";
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of publicRoutes(api)) {
    const operation = apiOperations[operationKey(route.method, route.path)];
    const example = requestExampleOf(route, operation);
    const json = route.validators.json;
    const parameters = parametersOf(route, operation);
    const scopeLine = `Needs the \`${route.scope}\` scope.`;
    const item = {
      operationId: operationIdOf(route.method, route.path),
      tags: [operation?.tag ?? tagOf(route.path)],
      summary: operation?.summary ?? `${route.method} ${route.path}`,
      description: operation?.description ? `${operation.description}\n\n${scopeLine}` : scopeLine,
      security: [{ token: [route.scope] }],
      "x-hekate-scope": route.scope,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(json
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: jsonSchemaOf(json),
                  ...(example === undefined ? {} : { example }),
                },
              },
            },
          }
        : operation?.body
          ? { requestBody: binaryRequest(operation.body) }
          : {}),
      responses: responsesOf(route, operation),
    };
    paths[route.path] ??= {};
    (paths[route.path] as Record<string, unknown>)[route.method.toLowerCase()] = item;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Hekate API",
      version: String(API_VERSION),
      description: introduction(docsUrl),
      license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
    },
    externalDocs: { description: "The API guide", url: `${docsUrl}/use/api/` },
    servers: [options.server],
    security: [{ token: [] }],
    tags: apiTags.map(([name, description]) => ({ name, description })),
    paths,
    components,
  };
}

export type OpenApiDocument = ReturnType<typeof openapiDocument>;
