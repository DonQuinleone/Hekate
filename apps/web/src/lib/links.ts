/**
 * Where "View documentation" goes: HEKATE_DOCS_URL, which the server puts in the page as a
 * meta tag (#128), or the default (decision 041) where there is none, as in development.
 */
export const docsUrl =
  (typeof document === "undefined"
    ? undefined
    : document.querySelector<HTMLMetaElement>('meta[name="hekate-docs-url"]')?.content) ||
  "https://docs.hekate.studio";
