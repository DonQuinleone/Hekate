// The documentation site (#151): Starlight, on the Hekate brand, built from this repository.
// Operator pages that already live in docs/ are copied in at build time (scripts/sync.ts), so
// there is one source for each.
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: process.env.DOCS_SITE ?? "https://donquinleone.github.io",
  base: process.env.DOCS_BASE ?? "/Hekate",
  integrations: [
    starlight({
      title: "Hekate",
      description: "Self-hosted review and approval for sound and picture.",
      logo: { src: "../../brand/mark.svg", alt: "" },
      favicon: "/favicon.svg",
      customCss: ["@fontsource-variable/schibsted-grotesk", "./src/styles/brand.css"],
      social: [{ icon: "github", label: "Source", href: "https://github.com/DonQuinleone/Hekate" }],
      editLink: { baseUrl: "https://github.com/DonQuinleone/Hekate/edit/master/docs/site/" },
      lastUpdated: true,
      sidebar: [
        {
          label: "Install",
          items: ["install", "install/configuration", "install/storage", "install/proxies"],
        },
        {
          label: "Operate",
          items: [
            "operate/backup",
            "operate/recovery",
            "operate/replicas",
            "operate/upgrades",
            "operate/upgrade-notes",
            "operate/keys",
            "operate/monitoring",
          ],
        },
        { label: "Security", items: ["security/model", "security/reporting"] },
        {
          label: "Use",
          items: ["use/reviews", "use/takes", "use/guests", "use/workflow-files"],
        },
      ],
    }),
  ],
});
