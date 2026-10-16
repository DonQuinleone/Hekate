import {
  type EmailTemplateId,
  emailTemplateIds,
  emailTemplates,
  unknownPlaceholders,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import {
  emailPreviewQuery,
  useSaveWorkspaceSettings,
  useSendTestEmail,
  workspaceSettingsQuery,
} from "~/lib/queries";
import { Row, Section } from "./settings";
import { Button } from "./ui/button";
import { Input, Select } from "./ui/input";
import { Segmented } from "./ui/segmented";

type View = "light" | "dark" | "text";

/** The message drawn as a mail client would: HTML in a frame that runs nothing, or the text part. */
function Preview({ template, view }: { template: EmailTemplateId; view: View }) {
  const { data, error } = useQuery(emailPreviewQuery(template, view === "dark" ? "dark" : "light"));
  const [height, setHeight] = useState(480);
  if (error) return <p className="m-0 px-4 py-6 text-[13px] text-signal">{error.message}</p>;
  if (!data) return <div className="h-[480px] animate-pulse bg-raised/40" />;
  if (view === "text")
    return (
      <pre className="tabular m-0 max-h-[560px] overflow-auto bg-ground/60 px-5 py-5 font-mono text-[12.5px] leading-[19px] whitespace-pre-wrap text-ink-2">
        {`Subject: ${data.subject}\n\n${data.text}`}
      </pre>
    );
  return (
    <iframe
      title={`${emailTemplates[template].name}, as a ${view} mail client shows it`}
      // No scripts; same origin only so the frame can be sized to the message.
      sandbox="allow-same-origin"
      srcDoc={data.html}
      onLoad={(e) => {
        const body = e.currentTarget.contentDocument?.body;
        if (body) setHeight(Math.max(320, body.scrollHeight));
      }}
      className="block w-full border-0"
      style={{ height }}
    />
  );
}

/** One template's subject line: the workspace's own, or the default. */
function SubjectRow({ template, current }: { template: EmailTemplateId; current?: string }) {
  const save = useSaveWorkspaceSettings();
  const fallback = emailTemplates[template].subject;
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? current ?? fallback;
  const unknown = unknownPlaceholders(template, value);
  const placeholders = Object.keys(emailTemplates[template].sample).map((p) => `{${p}}`);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (unknown.length || !value.trim()) return;
    save.mutate(
      { emailSubjects: { [template]: value === fallback ? null : value } },
      { onSuccess: () => setDraft(null) },
    );
  };
  const changed = value !== (current ?? fallback);
  return (
    <Row
      name="Subject"
      hint={
        unknown.length ? (
          <span className="text-signal">
            Not a placeholder here: {unknown.map((u) => `{${u}}`).join(", ")}
          </span>
        ) : (
          `Placeholders: ${placeholders.join(", ")}`
        )
      }
    >
      <form onSubmit={submit} className="flex w-full flex-wrap items-center gap-2 @3xl/app:w-auto">
        <Input
          aria-label="Subject"
          value={value}
          maxLength={150}
          onChange={(e) => setDraft(e.target.value)}
          className="w-full @3xl/app:w-80"
        />
        <Button
          type="submit"
          variant="secondary"
          disabled={save.isPending || !changed || unknown.length > 0 || !value.trim()}
        >
          Save
        </Button>
        {current && (
          <Button
            variant="ghost"
            disabled={save.isPending}
            onClick={() =>
              save.mutate(
                { emailSubjects: { [template]: null } },
                { onSuccess: () => setDraft(null) },
              )
            }
          >
            Use the default
          </Button>
        )}
      </form>
      {save.error && <p className="m-0 text-[12px] text-signal">{save.error.message}</p>}
    </Row>
  );
}

/** Workspace settings, Email templates: each message previewed, its subject, and a test send. */
export function EmailTemplatesSection() {
  const { data: settings } = useQuery(workspaceSettingsQuery);
  const [template, setTemplate] = useState<EmailTemplateId>("review_requested");
  const [view, setView] = useState<View>("light");
  const test = useSendTestEmail();
  return (
    <>
      <Section
        title="Templates"
        intro="Every message is the same shape: who did what, one action, and a line about why you got it. Each goes as plain text and HTML together."
        action={
          <Select
            aria-label="Template"
            value={template}
            onChange={(e) => {
              setTemplate(e.target.value as EmailTemplateId);
              test.reset();
            }}
            className="w-48"
          >
            {emailTemplateIds.map((id) => (
              <option key={id} value={id}>
                {emailTemplates[id].name}
              </option>
            ))}
          </Select>
        }
      >
        <div className="px-4 py-2">
          <Segmented
            label="Preview as"
            value={view}
            options={[
              { value: "light", label: "Light client" },
              { value: "dark", label: "Dark client" },
              { value: "text", label: "Plain text" },
            ]}
            onChange={setView}
            className="w-fit"
          />
        </div>
        <Preview template={template} view={view} />
        <SubjectRow
          key={template}
          template={template}
          current={settings?.emailSubjects[template]}
        />
        <Row name="Try it" hint="This message, with sample content, to your own address.">
          <Button
            variant="secondary"
            disabled={test.isPending}
            onClick={() => test.mutate(template)}
          >
            Send me a test
          </Button>
          {test.data && <span className="text-[13px] text-ink-2">Sent to {test.data.to}</span>}
          {test.error && <span className="text-[13px] text-signal">{test.error.message}</span>}
        </Row>
      </Section>
      <Section title="Rules" intro="What keeps every message recognisable.">
        <Row
          name="One action"
          hint="One button, in the signal colour, that goes straight to the thing. No second links in the body."
        />
        <Row
          name="Plain words, and plain text"
          hint="Who did what, and what is asked. The text part is written to be read as it is, not squeezed out of the HTML."
        />
        <Row
          name="Why you got it"
          hint="A line at the foot, every time, with the way to change it."
        />
        <Row
          name="Both clients, nothing fetched"
          hint="Set for light and dark mail clients; the mark is drawn, not an image, so nothing reports that a message was opened."
        />
      </Section>
    </>
  );
}
