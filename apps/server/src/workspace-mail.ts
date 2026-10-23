import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { type Database, inOrg, schema } from "@hekate/db";
import {
  isBounceProvider,
  MAIL_PAUSE_AFTER,
  MAIL_PAUSE_MINUTES,
  type MailStepInput,
  mailProviders,
  mailSettingsOf,
  mailStepInput,
  type WorkspaceMail,
  type WorkspaceMailInput,
  workspaceMailTarget,
} from "@hekate/shared";
import { eq, sql } from "drizzle-orm";
import { createTransport } from "nodemailer";
import type { Keyring } from "./keyring.ts";
import { createMailer, type Mailer, type Message, mailTransportOf } from "./mail.ts";
import { suppressed, suppressedCount } from "./mail-bounces.ts";
import { openSecret, sealSecret } from "./secrets.ts";
import { privateAddress, publicLookup } from "./sso.ts";

const { workspaceMail } = schema;

/**
 * A workspace's own mail (#161): the provider its members, guests and invitations are sent
 * through instead of the instance's. Its details are sealed with the workspace's key. Mail that
 * names a workspace goes through that workspace's mail while it works; a failure is sent by the
 * instance's mail instead, so nothing is lost, and five failures in a row pause the workspace's
 * mail for a quarter of an hour.
 */

export const mailSealContext = (organisationId: string) => `workspace-mail:${organisationId}`;

type Row = typeof workspaceMail.$inferSelect;

/** What settings show of it: everything but the secret. */
/** The details a workspace's mail is sealed with: the provider's, and its bounce secret. */
export type StoredMail = MailStepInput & { webhookSecret?: string };

/** Where a workspace's provider sends its bounce reports. */
export const bounceUrlOf = (publicUrl: string, organisationId: string) =>
  new URL(`/api/hooks/mail/workspaces/${organisationId}`, publicUrl).toString();

export function viewOf(
  row: Row,
  mail: StoredMail,
  extra: { publicUrl: string; suppressed: number },
  now = new Date(),
): WorkspaceMail {
  return {
    provider: row.provider,
    from: row.from,
    target: row.target,
    host: mail.host ?? null,
    port: mail.port ?? null,
    username: mail.username ?? null,
    tenant: mail.tenant ?? null,
    clientId: mail.clientId ?? null,
    url: mail.url ?? null,
    hasSecret: Boolean(mail.password),
    hasWebhookSecret: Boolean(mail.webhookSecret),
    bounceUrl: isBounceProvider(row.provider)
      ? bounceUrlOf(extra.publicUrl, row.organisationId)
      : null,
    suppressed: extra.suppressed,
    pausedUntil: row.pausedUntil && row.pausedUntil > now ? row.pausedUntil.toISOString() : null,
    failures: row.failures,
    lastSentAt: row.lastSentAt?.toISOString() ?? null,
    lastError: row.lastError,
  };
}

async function rowOf(db: Pick<Database, "select">, organisationId: string) {
  const [row] = await db.select().from(workspaceMail).where(inOrg(workspaceMail, organisationId));
  return row ?? null;
}

export async function opened(keyring: Keyring, row: Row): Promise<StoredMail> {
  const key = await keyring.version(row.organisationId, row.keyVersion);
  return JSON.parse(
    openSecret(key, row.configSealed, mailSealContext(row.organisationId)),
  ) as StoredMail;
}

/** The workspace's mail as settings show it, or null where it leaves mail to the instance. */
export async function workspaceMailOf(
  db: Database,
  keyring: Keyring,
  organisationId: string,
  publicUrl: string,
) {
  const row = await rowOf(db, organisationId);
  if (!row) return null;
  return viewOf(row, await opened(keyring, row), {
    publicUrl,
    suppressed: await suppressedCount(db, organisationId),
  });
}

/** A workspace's mail as its bounce reports need it: the provider and the secret, or null. */
export async function bounceConfigOf(db: Database, keyring: Keyring, organisationId: string) {
  const row = await rowOf(db, organisationId);
  if (!row || !isBounceProvider(row.provider)) return null;
  const mail = await opened(keyring, row);
  return { provider: row.provider, secret: mail.webhookSecret ?? "" };
}

export class MailRefused extends Error {}

/**
 * The details a save comes to: the stored secret kept where none is given and the provider is
 * the same, then checked whole as the installer's mail step checks them.
 */
export async function mergedMail(
  db: Database,
  keyring: Keyring,
  organisationId: string,
  input: WorkspaceMailInput,
): Promise<StoredMail> {
  const row = await rowOf(db, organisationId);
  const stored = row ? await opened(keyring, row) : null;
  // A secret left out is kept, but only one of the same provider's.
  const same = stored && stored.provider === input.provider ? stored : null;
  const password = input.password || same?.password || undefined;
  const webhookSecret = input.webhookSecret || same?.webhookSecret || undefined;
  const parsed = mailStepInput.safeParse({ ...input, ...(password ? { password } : {}) });
  if (!parsed.success)
    throw new MailRefused(parsed.error.issues[0]?.message ?? "Those details do not fit together");
  return { ...parsed.data, ...(webhookSecret ? { webhookSecret } : {}) };
}

/** Save the workspace's mail, sealed; it is used from the next message on. */
export async function saveWorkspaceMail(
  db: Database,
  keyring: Keyring,
  organisationId: string,
  mail: StoredMail,
) {
  const { version, key } = await keyring.current(organisationId);
  const values = {
    provider: mail.provider,
    from: mail.from,
    target: workspaceMailTarget(mail),
    configSealed: sealSecret(key, JSON.stringify(mail), mailSealContext(organisationId)),
    keyVersion: version,
    // New details start afresh: whatever failed before may be what was just put right.
    failures: 0,
    pausedUntil: null,
    lastError: null,
    updatedAt: new Date(),
  };
  await db
    .insert(workspaceMail)
    .values({ organisationId, ...values })
    .onConflictDoUpdate({ target: workspaceMail.organisationId, set: values });
}

export async function removeWorkspaceMail(db: Database, organisationId: string) {
  await db.delete(workspaceMail).where(inOrg(workspaceMail, organisationId));
}

/** The first of a host's addresses, refused where any is private and the operator has not allowed it. */
async function publicAddressOf(host: string, trusted: boolean): Promise<string> {
  if (isIP(host)) {
    if (!trusted && privateAddress(host)) throw new Error(`${host} is on a private network`);
    return host;
  }
  const addresses = await lookup(host, { all: true });
  const first = addresses[0];
  if (!first) throw new Error(`${host} could not be found`);
  if (!trusted && addresses.some((a) => privateAddress(a.address)))
    throw new Error(`${host} is on a private network`);
  return first.address;
}

/**
 * A `fetch` for an address a workspace gave (Mailcoach's): connected only to a public address
 * (checked at the connection itself, so a name that turns private after a check is refused),
 * an address given as a number checked too, no redirect followed, a megabyte of answer at most.
 * Origins the operator trusts may be private.
 */
export function pinnedFetch(trusted: string[]): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    const allowed = trusted.includes(target.origin);
    if (target.protocol !== "https:" && !(allowed && target.protocol === "http:"))
      throw new Error("Only https:// addresses are reached");
    const host = target.hostname.replace(/^\[|\]$/g, "");
    if (!allowed && isIP(host) && privateAddress(host))
      throw new Error(`${host} is on a private network`);
    const request = target.protocol === "https:" ? httpsRequest : httpRequest;
    const body = typeof init.body === "string" ? init.body : undefined;
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        target,
        {
          method: init.method ?? "GET",
          headers: {
            ...(init.headers as Record<string, string> | undefined),
            ...(body !== undefined ? { "content-length": String(Buffer.byteLength(body)) } : {}),
          },
          timeout: 20_000,
          ...(init.signal ? { signal: init.signal } : {}),
          ...(allowed ? {} : { lookup: publicLookup }),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1_000_000) req.destroy(new Error("The answer is too large"));
            else chunks.push(chunk);
          });
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            // A redirect is an answer like any other, never followed: Response cannot carry
            // every status, so those outside its range read as 502.
            resolve(
              new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), {
                status: status >= 200 && status <= 599 ? status : 502,
              }),
            );
          });
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error("Timed out")));
      req.on("error", reject);
      req.end(body);
    });
  }) as typeof fetch;
}

/**
 * The mailer a workspace's details come to. SMTP connects to the address it checked, never a
 * second lookup's, so a name that turns private between the two is refused; Mailcoach's
 * address must be public each time it is reached. Origins the operator trusts
 * (`WEBHOOK_TRUSTED_ORIGINS`, `smtp://host:port` for SMTP) may be private.
 */
export function workspaceMailer(
  mail: MailStepInput,
  trusted: string[],
  fetcher: typeof fetch = fetch,
): Mailer {
  const preset = mailProviders[mail.provider];
  if (preset.transport === "smtp") {
    const host = preset.host ?? mail.host ?? "";
    const port = mail.port ?? preset.port ?? 587;
    const username = preset.username ?? mail.username;
    const allowed = trusted.includes(`smtp://${host}:${port}`);
    const transport = async () =>
      createTransport({
        host: await publicAddressOf(host, allowed),
        port,
        secure: port === 465,
        ...(username ? { auth: { user: username, pass: mail.password ?? "" } } : {}),
        // The certificate is checked against the name, not the address connected to.
        ...(isIP(host) ? {} : { tls: { servername: host } }),
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 20_000,
      });
    return {
      async send(message) {
        await (await transport()).sendMail({
          from: mail.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
        });
      },
      verify: async () => (await transport()).verify(),
    };
  }
  // Mailcoach is reached only through `pinnedFetch`: the address checked is the one connected
  // to, and no redirect is followed. A test may give its own.
  const reach = fetcher === fetch ? pinnedFetch(trusted) : fetcher;
  return createMailer({
    transport: mailTransportOf(
      Object.fromEntries(Object.entries(mailSettingsOf(mail)).map(([k, v]) => [k, v ?? undefined])),
    ),
    from: mail.from,
    fetch: preset.transport === "mailcoach" ? reach : fetcher,
  });
}

export interface RoutedMailDeps {
  db: Database;
  keyring: Keyring;
  /** The instance's own mail: for mail that names no workspace, and standing in. */
  instance: Mailer;
  trusted: string[];
  /** For tests: the mailer a workspace's details come to. */
  build?: (mail: MailStepInput) => Mailer;
  now?: () => Date;
}

/**
 * The mailer every part of Hekate sends through: a message that names a workspace goes through
 * that workspace's own mail, if it has one that is not paused; anything else, and anything the
 * workspace's mail refuses, through the instance's.
 */
export function routedMailer(deps: RoutedMailDeps): Mailer {
  const build = deps.build ?? ((mail: MailStepInput) => workspaceMailer(mail, deps.trusted));
  const now = deps.now ?? (() => new Date());
  // One mailer for each saved version of a workspace's details, so a Microsoft 365 token is kept.
  const built = new Map<string, { version: string; mailer: Mailer }>();
  const mailerOf = async (row: Row) => {
    // The seal changes with every save (a fresh nonce), and with nothing else.
    const version = row.configSealed;
    const known = built.get(row.organisationId);
    if (known?.version === version) return known.mailer;
    const mailer = build(await opened(deps.keyring, row));
    built.set(row.organisationId, { version, mailer });
    return mailer;
  };
  return {
    async send(message: Message) {
      const organisationId = message.organisationId;
      // An address a provider reported as bounced or complaining is not sent to again (#161).
      if (await suppressed(deps.db, message.to, organisationId)) return "suppressed";
      const row = organisationId ? await rowOf(deps.db, organisationId) : null;
      const at = now();
      if (!organisationId || !row || (row.pausedUntil && row.pausedUntil > at))
        return deps.instance.send(message);
      // Only the provider's answer decides: what the books say afterwards is written apart, so
      // a failed write neither sends a message twice nor stops the instance standing in.
      let refusal: unknown = null;
      try {
        await (await mailerOf(row)).send(message);
      } catch (error) {
        refusal = error;
      }
      const where = inOrg(workspaceMail, organisationId, eq(workspaceMail.id, row.id));
      if (refusal === null) {
        await deps.db
          .update(workspaceMail)
          .set({ failures: 0, pausedUntil: null, lastSentAt: at })
          .where(where)
          .catch((error: unknown) =>
            console.error("Could not note the workspace's mail as working:", error),
          );
        return "sent";
      }
      const said = (refusal instanceof Error ? refusal.message : String(refusal)).slice(0, 500);
      // Counted in one statement, so two failing at once both count.
      await deps.db
        .update(workspaceMail)
        .set({
          failures: sql`${workspaceMail.failures} + 1`,
          lastError: said,
          pausedUntil: sql`case when ${workspaceMail.failures} + 1 >= ${MAIL_PAUSE_AFTER}
            then ${new Date(at.getTime() + MAIL_PAUSE_MINUTES * 60_000).toISOString()}::timestamptz
            else ${workspaceMail.pausedUntil} end`,
        })
        .where(where)
        .catch((error: unknown) =>
          console.error("Could not count the workspace's mail failing:", error),
        );
      console.warn(`Workspace mail refused a message; the instance's mail sends it: ${said}`);
      return deps.instance.send(message);
    },
    ...(deps.instance.verify ? { verify: deps.instance.verify } : {}),
  };
}

/** Send a test through the saved details, and nothing else: a failure here is the answer. */
export async function testWorkspaceMail(
  deps: Pick<RoutedMailDeps, "db" | "keyring" | "trusted" | "build">,
  organisationId: string,
  message: Message,
) {
  const row = await rowOf(deps.db, organisationId);
  if (!row) throw new MailRefused("Set the workspace's mail first");
  const mail = await opened(deps.keyring, row);
  await (deps.build ?? ((m) => workspaceMailer(m, deps.trusted)))(mail).send(message);
}
