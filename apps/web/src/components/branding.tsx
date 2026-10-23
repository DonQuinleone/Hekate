import {
  accentRefusal,
  type BrandScheme,
  brandSurfaces,
  leastContrast,
  lightAccent,
  logoContentTypes,
  logoPath,
  type PublicBranding,
  signalColours,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { WorkspaceLogo } from "~/components/brand";
import { Button } from "~/components/ui/button";
import { ColourInput, FileInput } from "~/components/ui/input";
import { brandingQuery, meQuery, useBranding } from "~/lib/queries";
import { Row, Section } from "./settings";

const whole = (value: string) => /^#[0-9a-f]{6}$/i.test(value);

/**
 * What a guest or someone signing in sees, in each of Signal's themes: the logo, or the
 * workspace's name, over a primary action in the accent. The grounds and the accent are the
 * very colours being judged, so they are data here rather than tokens.
 */
function Preview({
  scheme,
  name,
  logo,
  accent,
}: {
  scheme: BrandScheme;
  name: string;
  logo: PublicBranding["logo"];
  accent: string;
}) {
  const surfaces = brandSurfaces[scheme];
  const ink = scheme === "dark" ? brandSurfaces.light.ground : brandSurfaces.dark.ground;
  return (
    <figure
      className="m-0 flex min-w-0 flex-1 flex-col gap-4 rounded-panel border border-line p-4"
      style={{ background: surfaces.ground, color: ink }}
    >
      <div className="flex h-8 items-center">
        {logo ? (
          <WorkspaceLogo logo={logo} name={name} height={32} maxWidth={180} />
        ) : (
          <span className="truncate text-[15px] font-medium">{name}</span>
        )}
      </div>
      <span
        aria-hidden="true"
        className="flex h-9 items-center justify-center rounded-control text-[14px] font-medium"
        style={{ background: accent, color: surfaces.ground }}
      >
        Open the review
      </span>
      <figcaption className="tabular text-[12px]">
        {scheme === "dark" ? "Dark" : "Light"} · {accent}
      </figcaption>
    </figure>
  );
}

/**
 * `/settings/branding` (#185): the workspace's logo and accent, on its sign-in page at its own
 * address, on guest pages and in its email. Hekate's own lockup stays in the app.
 */
export function BrandingSection() {
  const { data: stored } = useQuery(brandingQuery);
  const { data: me } = useQuery(meQuery);
  const { accent, upload, remove } = useBranding();
  const picker = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState<string | null>(null);
  if (!stored || !me) return null;
  const workspace = me.organisations.find((o) => o.id === me.activeOrganisationId);
  const name = workspace?.name ?? "Workspace";
  const value = typed ?? stored.accent ?? "";
  const candidate = whole(value) ? value.toLowerCase() : null;
  const refusal = candidate ? accentRefusal(candidate) : null;
  const shownAccent = candidate && !refusal ? candidate : (stored.accent ?? signalColours.dark);
  const logo = stored.logo
    ? {
        url: logoPath(me.activeOrganisationId ?? "", stored.logo.blobId),
        width: stored.logo.width,
        height: stored.logo.height,
      }
    : null;
  const changed = candidate !== null && candidate !== stored.accent;
  const failed = upload.error ?? remove.error;
  return (
    <>
      <Section
        title="Logo"
        intro="Shown on the sign-in page at the workspace's own address, on guest pages and at the top of its email."
      >
        <Row
          name={logo ? "Current logo" : "No logo yet"}
          hint="PNG, JPEG or WebP, up to 2 MB. It is drawn again at up to 512 pixels a side; one with its own background, or that reads on dark and light alike, works best."
        >
          {logo && (
            <span className="flex h-11 items-center rounded-control border border-line bg-ground px-3">
              <WorkspaceLogo logo={logo} name={name} height={28} maxWidth={160} />
            </span>
          )}
          <FileInput
            ref={picker}
            accept={logoContentTypes.join(",")}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload.mutate(file);
              e.target.value = "";
            }}
          />
          <Button
            variant="secondary"
            disabled={upload.isPending}
            onClick={() => picker.current?.click()}
          >
            {upload.isPending ? "Uploading" : logo ? "Replace" : "Upload logo"}
          </Button>
          {logo && (
            <Button variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate()}>
              Remove
            </Button>
          )}
        </Row>
        {failed && (
          <p role="alert" className="px-4 py-2 text-[13px] text-signal">
            {failed.message}
          </p>
        )}
      </Section>
      <Section
        title="Accent"
        intro="Stands in for the signal on those pages, and colours the action in its email."
      >
        <Row
          name="Accent colour"
          hint="It must read on the dark ground at 4.5:1; light themes take a darker cut of it that reads there too."
        >
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (candidate && !refusal && changed)
                accent.mutate(candidate, { onSuccess: () => setTyped(null) });
            }}
          >
            <ColourInput
              label="Accent colour"
              value={value}
              invalid={Boolean(refusal) || (value !== "" && !candidate)}
              disabled={accent.isPending}
              onChange={setTyped}
            />
            <Button
              type="submit"
              variant="secondary"
              disabled={accent.isPending || !changed || Boolean(refusal)}
            >
              Save
            </Button>
            {stored.accent && (
              <Button
                variant="ghost"
                disabled={accent.isPending}
                onClick={() => accent.mutate(null, { onSuccess: () => setTyped(null) })}
              >
                Use the signal
              </Button>
            )}
          </form>
        </Row>
        {(refusal || candidate || accent.error) && (
          <p
            role={refusal || accent.error ? "alert" : "status"}
            className="px-4 py-2 text-[13px] text-ink-2"
          >
            {accent.error?.message ??
              refusal ??
              (candidate &&
                `${leastContrast(candidate, "dark").toFixed(1)}:1 at its lowest on the dark ground. Light themes show ${lightAccent(candidate)}.`)}
          </p>
        )}
      </Section>
      <Section title="Preview" intro="A guest's page in each theme, with what is saved or chosen.">
        <div className="flex flex-col gap-3 p-4 @3xl/app:flex-row">
          <Preview scheme="dark" name={name} logo={logo} accent={shownAccent} />
          <Preview
            scheme="light"
            name={name}
            logo={logo}
            accent={
              candidate && !refusal
                ? lightAccent(candidate)
                : stored.accent
                  ? lightAccent(stored.accent)
                  : signalColours.light
            }
          />
        </div>
      </Section>
    </>
  );
}
