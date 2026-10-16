/** A user agent as a person would say it: "Firefox on macOS". Null when there is none. */
export function shortAgent(ua: string | null): string | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\/|CriOS\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : null;
  const system = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? ua.slice(0, 40);
}
