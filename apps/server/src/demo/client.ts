import {
  apiOf,
  type Client,
  type Session,
  type SessionInit,
  type SessionResponse,
} from "./seed.ts";

/**
 * The seed's sessions over Node's fetch, for the demo (decision 265): each a cookie jar of its
 * own, as a browser context would be, against the one server at `baseUrl`. The jar is as small
 * as the seed needs: names and values, taken and given back as `set-cookie` says.
 */

/** Keeps or forgets what one `set-cookie` line says. */
export function remember(jar: Map<string, string>, setCookie: string) {
  const [pair, ...attributes] = setCookie.split(";");
  const at = pair?.indexOf("=") ?? -1;
  if (!pair || at <= 0) return;
  const name = pair.slice(0, at).trim();
  const value = pair.slice(at + 1).trim();
  const gone = attributes.some((attribute) => {
    const [key, given] = attribute.trim().split("=");
    const lower = key?.toLowerCase();
    return (
      (lower === "max-age" && Number(given) <= 0) ||
      (lower === "expires" && Date.parse(given ?? "") < Date.now())
    );
  });
  if (gone || value === "") jar.delete(name);
  else jar.set(name, value);
}

/** The `cookie` header for what the jar holds. */
export const cookieHeader = (jar: Map<string, string>) =>
  [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

export function fetchClient(baseUrl: string): Client {
  const origin = new URL(baseUrl).origin;
  const open = (): Session => {
    const jar = new Map<string, string>();
    const send = async (path: string, init: SessionInit = {}): Promise<SessionResponse> => {
      const headers = new Headers(init.headers);
      // As a browser sends it, so the server's own checks see the request as the app's.
      headers.set("origin", origin);
      if (jar.size > 0) headers.set("cookie", cookieHeader(jar));
      const response = await fetch(new URL(path, baseUrl), {
        method: init.method ?? "GET",
        headers,
        body: typeof init.body === "string" ? init.body : init.body && new Uint8Array(init.body),
        redirect: "manual",
      });
      for (const line of response.headers.getSetCookie()) remember(jar, line);
      return {
        status: response.status,
        ok: response.ok,
        text: () => response.text(),
        json: () => response.json(),
      };
    };
    return { fetch: send, api: apiOf(send) };
  };
  return { owner: open(), session: async () => open() };
}
