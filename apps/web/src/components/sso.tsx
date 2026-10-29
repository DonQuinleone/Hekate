import {
  notEntitledMessage,
  type SsoProtocol,
  type SsoServiceProvider,
  type SsoSettings,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ssoQuery, useSaveSso } from "~/lib/queries";
import { Row, Section, SwitchRow } from "./settings";
import { Button } from "./ui/button";
import { Input, Select, Textarea } from "./ui/input";

/**
 * The workspace's single sign-on: one identity provider, by OIDC or SAML. Members sign in
 * through it, join on their first sign-in, and are made admins by the groups named here; it
 * can be made the only way in for everyone but the owners.
 */
export function SsoSection() {
  const { data } = useQuery(ssoQuery);
  if (!data) return null;
  // Keyed on what was saved, so a save starts the form again from the server's copy.
  return (
    <SsoForm
      key={JSON.stringify(data.sso)}
      saved={data.sso}
      serviceProvider={data.serviceProvider}
      entitled={data.entitled}
    />
  );
}

/** Group names, one per comma, as the admin rules hold them. */
const groupsOf = (text: string) =>
  text
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);

/** An address the identity provider is given, to copy. */
function Given({ name, value }: { name: string; value: string }) {
  return (
    <Row name={name}>
      <Input
        readOnly
        aria-label={name}
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        className="w-full font-mono text-[12px] @3xl/app:w-96"
      />
    </Row>
  );
}

function SsoForm({
  saved,
  serviceProvider,
  entitled,
}: {
  saved: SsoSettings;
  serviceProvider: SsoServiceProvider;
  /** Whether the workspace's plan includes it (#177); one already on can still be turned off. */
  entitled: boolean;
}) {
  const save = useSaveSso();
  const { hasClientSecret, ...initial } = saved;
  const [form, setForm] = useState(initial);
  const [clientSecret, setClientSecret] = useState<string | undefined>(undefined);
  const [admins, setAdmins] = useState(
    saved.roles
      .filter((r) => r.role === "admin")
      .map((r) => r.group)
      .join(", "),
  );
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({
      ...form,
      roles: groupsOf(admins).map((group) => ({ group, role: "admin" as const })),
      ...(clientSecret === undefined ? {} : { clientSecret }),
    });
  };
  const oidc = form.protocol === "oidc";
  return (
    <form onSubmit={submit} className="contents">
      <Section
        title="Single sign-on"
        intro="One identity provider, by OIDC or SAML. Members sign in through it, and their first sign-in makes their account."
      >
        <SwitchRow
          name="Sign in with single sign-on"
          hint={
            entitled
              ? "Turned off, nobody new can join through it, and its members sign in with a password or passkey."
              : notEntitledMessage("sso")
          }
          checked={form.enabled}
          disabled={!entitled && !form.enabled}
          onChange={(enabled) => set("enabled", enabled)}
        />
        <Row name="Provider">
          <Select
            aria-label="Provider"
            className="w-40"
            value={form.protocol}
            onChange={(e) => set("protocol", e.target.value as SsoProtocol)}
          >
            <option value="oidc">OIDC</option>
            <option value="saml">SAML</option>
          </Select>
        </Row>
        {oidc ? (
          <>
            <Row name="Issuer" hint="Its discovery document is read when you save.">
              <Input
                aria-label="Issuer"
                placeholder="https://login.example/realms/studio"
                className="w-full @3xl/app:w-96"
                value={form.issuer}
                onChange={(e) => set("issuer", e.target.value)}
              />
            </Row>
            <Row name="Client" hint="The client secret is never shown again.">
              <span className="flex flex-wrap gap-2">
                <Input
                  aria-label="Client ID"
                  placeholder="hekate"
                  className="w-48"
                  value={form.clientId}
                  onChange={(e) => set("clientId", e.target.value)}
                />
                <Input
                  type="password"
                  aria-label="Client secret"
                  autoComplete="new-password"
                  placeholder={hasClientSecret ? "Kept" : "Secret"}
                  className="w-40"
                  value={clientSecret ?? ""}
                  onChange={(e) => setClientSecret(e.target.value)}
                />
              </span>
            </Row>
            <Given name="Redirect URI" value={serviceProvider.redirectUri} />
          </>
        ) : (
          <>
            <Row name="Sign-in address" hint="Where the identity provider takes requests.">
              <Input
                aria-label="Sign-in address"
                placeholder="https://login.example/saml"
                className="w-full @3xl/app:w-96"
                value={form.entryPoint}
                onChange={(e) => set("entryPoint", e.target.value)}
              />
            </Row>
            <Row name="Entity ID" hint="As the identity provider's metadata states it.">
              <Input
                aria-label="Entity ID"
                className="w-full @3xl/app:w-96"
                value={form.idpEntityId}
                onChange={(e) => set("idpEntityId", e.target.value)}
              />
            </Row>
            <Row name="Certificate" hint="The one it signs with, in PEM." stacked>
              <Textarea
                aria-label="Certificate"
                rows={4}
                placeholder="-----BEGIN CERTIFICATE-----"
                className="w-full font-mono text-[12px]"
                value={form.certificate}
                onChange={(e) => set("certificate", e.target.value)}
              />
            </Row>
            <Given name="Hekate's entity ID" value={serviceProvider.entityId} />
            <Given name="Reply address (ACS)" value={serviceProvider.acsUrl} />
          </>
        )}
        <Row
          name="Groups"
          hint={`The ${oidc ? "claim" : "attribute"} that lists a person's groups.`}
        >
          <Input
            aria-label="Groups claim"
            className="w-40"
            value={form.groupsClaim}
            onChange={(e) => set("groupsClaim", e.target.value)}
          />
        </Row>
        <Row
          name="Admins"
          hint="Groups whose people are admins here, separated by commas. Everyone else is a member; owners stay owners."
        >
          <Input
            aria-label="Admin groups"
            placeholder="producers"
            className="w-full @3xl/app:w-96"
            value={admins}
            onChange={(e) => setAdmins(e.target.value)}
          />
        </Row>
        <SwitchRow
          name="Enforce single sign-on"
          hint="Members sign in only through it. Owners keep their password, so a broken provider never locks the workspace out."
          checked={form.enforce}
          onChange={(enforce) => set("enforce", enforce)}
        />
        <Row name="Save" hint="Saving an OIDC issuer checks that it answers.">
          <Button variant="primary" type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving" : "Save"}
          </Button>
        </Row>
        {save.error && (
          <p role="alert" className="px-4 py-2 text-[13px] text-signal">
            {save.error.message}
          </p>
        )}
      </Section>
    </form>
  );
}
