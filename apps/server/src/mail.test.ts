import { describe, expect, it } from "vitest";
import { createMailer, mailTransportOf } from "./mail.ts";

/** A fetch that answers from a list, in turn, and keeps every request it was given. */
function provider(...answers: Response[]) {
  const asked: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
    asked.push({ url: String(url), init });
    const next = answers.shift();
    if (!next) throw new Error("No answer left");
    return next;
  }) as typeof fetch;
  return { asked, fetcher };
}

const message = {
  to: "mira@example.test",
  subject: "A review is waiting",
  text: "Booklet sign-off is waiting on you.",
  html: "<p>Booklet sign-off is waiting on you.</p>",
};
const from = "Hekate <hekate@endlesshall.example>";

describe("mail providers (#71)", () => {
  it("chooses the transport the settings name, else the log", () => {
    expect(mailTransportOf({}).kind).toBe("log");
    expect(mailTransportOf({ SMTP_URL: "smtp://mail.example:587" })).toEqual({
      kind: "smtp",
      url: "smtp://mail.example:587",
    });
    expect(
      mailTransportOf({
        MAIL_GRAPH_TENANT: "t",
        MAIL_GRAPH_CLIENT_ID: "c",
        MAIL_GRAPH_CLIENT_SECRET: "s",
      }).kind,
    ).toBe("microsoft");
    expect(
      mailTransportOf({ MAIL_MAILCOACH_URL: "https://x.mailcoach.app", MAIL_MAILCOACH_TOKEN: "k" })
        .kind,
    ).toBe("mailcoach");
  });

  it("sends through Microsoft Graph as the sender's mailbox, signing in once", async () => {
    const { asked, fetcher } = provider(
      Response.json({ access_token: "token-1", expires_in: 3600 }),
      new Response(null, { status: 202 }),
      new Response(null, { status: 202 }),
    );
    const mailer = createMailer({
      transport: { kind: "microsoft", tenant: "endlesshall", clientId: "app", clientSecret: "sh" },
      from,
      fetch: fetcher,
    });
    await mailer.send(message);
    await mailer.send({ ...message, subject: "Another" });
    // One sign-in for both messages, with the app's own credentials.
    expect(asked.map((a) => a.url)).toEqual([
      "https://login.microsoftonline.com/endlesshall/oauth2/v2.0/token",
      "https://graph.microsoft.com/v1.0/users/hekate%40endlesshall.example/sendMail",
      "https://graph.microsoft.com/v1.0/users/hekate%40endlesshall.example/sendMail",
    ]);
    const form = new URLSearchParams(String(asked[0]?.init.body));
    expect(Object.fromEntries(form)).toEqual({
      client_id: "app",
      client_secret: "sh",
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });
    const send = asked[1]?.init;
    expect((send?.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer token-1",
    );
    // The whole message as MIME, plain text and HTML together.
    const mime = Buffer.from(String(send?.body), "base64").toString("utf8");
    expect(mime).toContain("Subject: A review is waiting");
    expect(mime).toContain("To: mira@example.test");
    expect(mime).toContain("multipart/alternative");
    expect(mime).toContain("text/plain");
    expect(mime).toContain("text/html");
  });

  it("says what Microsoft refused, without the secret", async () => {
    const { fetcher } = provider(Response.json({ error: "invalid_client" }, { status: 401 }));
    const mailer = createMailer({
      transport: { kind: "microsoft", tenant: "t", clientId: "app", clientSecret: "very-secret" },
      from,
      fetch: fetcher,
    });
    const failure = await mailer.send(message).catch((error: Error) => error);
    expect(String(failure)).toContain("Microsoft sign-in answered 401");
    expect(String(failure)).not.toContain("very-secret");
  });

  it("sends through Mailcoach's transactional API, keeping no copy there", async () => {
    const { asked, fetcher } = provider(new Response(null, { status: 204 }));
    const mailer = createMailer({
      transport: { kind: "mailcoach", url: "https://endlesshall.mailcoach.app/", token: "mc" },
      from,
      fetch: fetcher,
    });
    await mailer.send(message);
    expect(asked[0]?.url).toBe("https://endlesshall.mailcoach.app/api/transactional-mails/send");
    expect((asked[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer mc",
    );
    expect(JSON.parse(String(asked[0]?.init.body))).toEqual({ from, ...message, store: false });
    const refusal = () =>
      new Response('{"message":"The from address is not verified"}', { status: 422 });
    const { fetcher: refusing } = provider(refusal(), refusal());
    const failing = createMailer({
      transport: { kind: "mailcoach", url: "https://endlesshall.mailcoach.app", token: "mc" },
      from,
      fetch: refusing,
    });
    // The health check asks who the token belongs to.
    await expect(failing.verify?.()).rejects.toThrow(/Mailcoach answered 422/);
    await expect(failing.send(message)).rejects.toThrow(/Mailcoach answered 422: .*not verified/);
  });
});
