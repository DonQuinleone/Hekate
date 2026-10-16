import type { DirectorySettings } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { directoryQuery, useSaveDirectory, useTestDirectory } from "~/lib/queries";
import { Row, Section, SwitchRow } from "./settings";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/**
 * The workspace's directory (LDAP or Active Directory): members sign in with the username and
 * password it knows, join on their first sign-in, and are made admins by the groups named here.
 */
export function DirectorySection() {
  const { data } = useQuery(directoryQuery);
  if (!data) return null;
  // Keyed on what was saved, so a save starts the form again from the server's copy.
  return (
    <DirectoryForm
      key={JSON.stringify(data.directory)}
      saved={data.directory}
      workspace={data.workspace}
    />
  );
}

/** Group names, one per comma, as the admin rules hold them. */
const groupsOf = (text: string) =>
  text
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);

function DirectoryForm({ saved, workspace }: { saved: DirectorySettings; workspace: string }) {
  const save = useSaveDirectory();
  const test = useTestDirectory();
  const { hasBindPassword, ...initial } = saved;
  const [form, setForm] = useState(initial);
  const [bindPassword, setBindPassword] = useState<string | undefined>(undefined);
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
    test.reset();
    save.mutate({
      ...form,
      roles: groupsOf(admins).map((group) => ({ group, role: "admin" as const })),
      ...(bindPassword === undefined ? {} : { bindPassword }),
    });
  };
  const field = (
    key: "url" | "userBase" | "userFilter" | "emailAttribute" | "nameAttribute",
    label: string,
    className: string,
  ) => (
    <Input
      aria-label={label}
      className={className}
      value={form[key]}
      onChange={(e) => set(key, e.target.value)}
    />
  );
  const outcome = test.data
    ? test.data.ok
      ? "Connected, signed in as the service account, and read the people."
      : test.data.problem
    : test.error?.message;
  return (
    <form onSubmit={submit} className="contents">
      <Section
        title="Directory (LDAP)"
        intro={`Members choose "Sign in with your workspace's directory" and enter ${workspace || "the workspace's short name"}. Their first sign-in makes their account.`}
      >
        <SwitchRow
          name="Sign in with the directory"
          hint="Turned off, nobody new can join through it, and its members sign in with a password or passkey."
          checked={form.enabled}
          onChange={(enabled) => set("enabled", enabled)}
        />
        <Row name="Server" hint="ldaps:// with its port; ldap:// only on a network you trust.">
          {field("url", "Server", "w-full @3xl/app:w-96")}
        </Row>
        <SwitchRow
          name="Verify the certificate"
          checked={form.verifyCertificate}
          onChange={(verifyCertificate) => set("verifyCertificate", verifyCertificate)}
        />
        <Row
          name="Service account"
          hint="Searches for people. Left empty, the search is anonymous. The password is never shown again."
        >
          <span className="flex flex-wrap gap-2">
            <Input
              aria-label="Service account DN"
              placeholder="cn=hekate,ou=services,dc=example"
              className="w-64"
              value={form.bindDn}
              onChange={(e) => set("bindDn", e.target.value)}
            />
            <Input
              type="password"
              aria-label="Service account password"
              autoComplete="new-password"
              placeholder={hasBindPassword ? "Kept" : "None"}
              className="w-32"
              value={bindPassword ?? ""}
              onChange={(e) => setBindPassword(e.target.value)}
            />
          </span>
        </Row>
        <Row name="People" hint="Where they are, and the filter that finds one by username.">
          <span className="flex flex-wrap gap-2">
            {field("userBase", "People base DN", "w-64")}
            {field("userFilter", "People filter", "w-40")}
          </span>
        </Row>
        <Row name="Attributes" hint="Which hold the email address and the name.">
          <span className="flex flex-wrap gap-2">
            {field("emailAttribute", "Email attribute", "w-32")}
            {field("nameAttribute", "Name attribute", "w-32")}
          </span>
        </Row>
        <Row name="Groups" hint="Where groups are, and the filter that finds a person's groups.">
          <span className="flex flex-wrap gap-2">
            <Input
              aria-label="Groups base DN"
              placeholder="None: everyone is a member"
              className="w-64"
              value={form.groupBase}
              onChange={(e) => set("groupBase", e.target.value)}
            />
            <Input
              aria-label="Groups filter"
              className="w-40"
              value={form.groupFilter}
              onChange={(e) => set("groupFilter", e.target.value)}
            />
          </span>
        </Row>
        <Row
          name="Admins"
          hint="Groups whose people are admins here, by name or DN, separated by commas. Everyone else is a member; owners stay owners."
        >
          <Input
            aria-label="Admin groups"
            className="w-full @3xl/app:w-96"
            placeholder="producers, cn=engineers,ou=groups,dc=example"
            value={admins}
            onChange={(e) => setAdmins(e.target.value)}
          />
        </Row>
        <Row name="Test" hint={outcome ?? "Connects with the saved settings."}>
          <span className="flex gap-2">
            <Button
              variant="secondary"
              disabled={test.isPending}
              onClick={() => {
                save.reset();
                test.mutate();
              }}
            >
              {test.isPending ? "Testing" : "Test connection"}
            </Button>
            <Button variant="primary" type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving" : "Save"}
            </Button>
          </span>
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
