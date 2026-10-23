import { Row, Section } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { organisation } from "~/data";

/**
 * A workspace's branding (#185): its logo and accent, on its sign-in page at its own address,
 * on guest pages and in its email. Hekate's own lockup stays in the app. The sample accent and
 * its light cut are what packages/shared's `lightAccent` gives.
 */
const accent = { dark: "#4fb3a9", light: "#30736c", least: "6.7" };
/** Signal's grounds: the colours the accent is judged against, so data here. */
const grounds = {
  dark: { ground: "#0a0a0b", ink: "#f4f4f2" },
  light: { ground: "#f4f4f2", ink: "#0a0a0b" },
};

/** The sample logo: the workspace's name set as a wordmark, in place of an uploaded image. */
function SampleLogo({ ink }: { ink: string }) {
  return (
    <span
      className="inline-flex h-7 items-center gap-1.5 text-[15px] font-medium tracking-[-0.02em]"
      style={{ color: ink }}
    >
      <span
        aria-hidden="true"
        className="inline-block size-5 rounded-full"
        style={{ background: accent.dark }}
      />
      Endless Hall
    </span>
  );
}

function Preview({ scheme }: { scheme: "dark" | "light" }) {
  const g = grounds[scheme];
  return (
    <figure
      className="m-0 flex min-w-0 flex-1 flex-col gap-4 rounded-panel border border-line p-4"
      style={{ background: g.ground, color: g.ink }}
    >
      <div className="flex h-8 items-center">
        <SampleLogo ink={g.ink} />
      </div>
      <span
        aria-hidden="true"
        className="flex h-9 items-center justify-center rounded-control text-[14px] font-medium"
        style={{ background: accent[scheme], color: g.ground }}
      >
        Open the review
      </span>
      <figcaption className="tabular text-[12px]">
        {scheme === "dark" ? "Dark" : "Light"} · {accent[scheme]}
      </figcaption>
    </figure>
  );
}

export function BrandingSection() {
  return (
    <>
      <Section
        title="Logo"
        intro="Shown on the sign-in page at the workspace's own address, on guest pages and at the top of its email."
      >
        <Row
          name="Current logo"
          hint="PNG, JPEG or WebP, up to 2 MB. It is drawn again at up to 512 pixels a side; one with its own background, or that reads on dark and light alike, works best."
        >
          <span className="flex h-11 items-center rounded-control border border-line bg-ground px-3">
            <SampleLogo ink={grounds.dark.ink} />
          </span>
          <Button variant="secondary" size="md">
            Replace
          </Button>
          <Button variant="ghost" size="md">
            Remove
          </Button>
        </Row>
      </Section>
      <Section
        title="Accent"
        intro="Stands in for the signal on those pages, and colours the action in its email."
      >
        <Row
          name="Accent colour"
          hint="It must read on the dark ground at 4.5:1; light themes take a darker cut of it that reads there too."
        >
          <span
            aria-hidden="true"
            className="size-9 shrink-0 rounded-control border border-line-strong shadow-1"
            style={{ background: accent.dark }}
          />
          <Input defaultValue={accent.dark} aria-label="Accent colour" className="tabular w-28" />
          <Button variant="secondary" size="md">
            Save
          </Button>
          <Button variant="ghost" size="md">
            Use the signal
          </Button>
        </Row>
        <p role="status" className="px-4 py-2 text-[13px] text-ink-2">
          {accent.least}:1 at its lowest on the dark ground. Light themes show {accent.light}.
        </p>
      </Section>
      <Section title="Preview" intro="A guest's page in each theme, with what is saved or chosen.">
        <div className="flex flex-col gap-3 p-4 @3xl/app:flex-row">
          <Preview scheme="dark" />
          <Preview scheme="light" />
        </div>
      </Section>
      <p className="max-w-[620px] text-[13px] text-ink-3">
        {organisation.name}'s sign-in page and guest pages show the logo where Hekate's lockup would
        be, and the accent in place of the signal, in Signal's dark and light themes. An accent too
        dark to read on the dark ground is refused, saying how far short it falls.
      </p>
    </>
  );
}
