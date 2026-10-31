import {
  type BucketTestResult,
  bucketLine,
  notOnPlanMessage,
  type WorkspaceBucket,
  type WorkspaceStorage,
} from "@hekate/shared";
import { type FormEvent, useState } from "react";
import { useSaveBucket, useTestBucket, useWorkspaceStorage } from "~/lib/queries";
import { Icon } from "./icons";
import { Row, Section } from "./settings";
import { Button } from "./ui/button";
import { ChoiceCard } from "./ui/choice";
import { Input, Select } from "./ui/input";
import { Switch } from "./ui/toggle";

/**
 * Where the workspace's new files go (#508): the instance's storage, or, on a plan that
 * includes it, an S3-compatible bucket of its own. Owners choose; admins see the choice. The
 * bucket's access key and secret go in and never come back: once saved they read as kept.
 */
export function WhereFilesGo({
  data,
  owner,
}: {
  data: WorkspaceStorage;
  /** Only an owner changes it. */
  owner: boolean;
}) {
  const choose = useWorkspaceStorage();
  const [picked, setPicked] = useState<"instance" | "bucket">(
    data.usesBucket ? "bucket" : "instance",
  );
  const { entitled, plan } = data.ownStorage;
  // On a plan without it, a workspace already using its bucket may still move back.
  const mayPickBucket = owner && (entitled || data.usesBucket);
  const bucketHint = !entitled
    ? notOnPlanMessage("ownStorage", plan)
    : data.usesBucket && data.bucket
      ? `Taking new files: ${data.bucket.bucket}${data.bucket.prefix ? `/${data.bucket.prefix}` : ""}`
      : "Amazon S3, or any service that speaks its API. Backing it up is yours.";
  return (
    <Section
      title="Where new files go"
      intro="Existing files stay where they are; the choice applies to new ones. Files are encrypted before they leave Hekate, so a bucket holds ciphertext only."
    >
      <div className="flex flex-col gap-2 px-4 py-row">
        <fieldset className="grid w-full gap-2 @3xl/app:grid-cols-2">
          <legend className="sr-only">Where new files go</legend>
          <ChoiceCard
            name="workspace-storage"
            value="instance"
            checked={picked === "instance"}
            disabled={!owner}
            onChange={() => setPicked("instance")}
            title="Instance storage"
            hint={
              data.usesBucket
                ? "Kept and backed up by this instance's operators."
                : `Taking new files${data.available.length > 1 ? `: ${data.backend ?? data.defaultBackend}` : ""}. Kept and backed up by this instance's operators.`
            }
          />
          <ChoiceCard
            name="workspace-storage"
            value="bucket"
            checked={picked === "bucket"}
            disabled={!mayPickBucket}
            onChange={() => setPicked("bucket")}
            title="Your own S3-compatible bucket"
            hint={bucketHint}
          />
        </fieldset>
        {!owner && <p className="m-0 text-[13px] text-ink-3">Only an owner can change it.</p>}
      </div>
      {owner && picked === "instance" && data.usesBucket && (
        <Row
          name="Move new files to the instance's storage"
          hint="Files already in your bucket stay there and keep working. The bucket's details are kept, for coming back."
        >
          <Button variant="primary" disabled={choose.isPending} onClick={() => choose.mutate(null)}>
            {choose.isPending ? "Switching" : "Switch"}
          </Button>
        </Row>
      )}
      {owner && picked === "instance" && !data.usesBucket && data.available.length > 1 && (
        <Row name="Backend" hint="The instance default unless you choose another of its backends.">
          <Select
            aria-label="Backend for new files"
            value={data.backend ?? ""}
            onChange={(e) => choose.mutate(e.target.value || null)}
            className="w-56"
          >
            <option value="">The default ({data.defaultBackend})</option>
            {data.available.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
        </Row>
      )}
      {choose.error && (
        <p className="m-0 px-4 py-2 text-[13px] text-signal">{choose.error.message}</p>
      )}
      {picked === "bucket" &&
        (owner && entitled ? (
          // Keyed on what was saved, so a save starts the form again from the server's copy.
          <BucketForm
            key={data.bucket?.savedAt ?? "new"}
            saved={data.bucket}
            using={data.usesBucket}
          />
        ) : (
          data.bucket && <Row name="Bucket" hint={bucketLine(data.bucket)} />
        ))}
    </Section>
  );
}

function BucketForm({ saved, using }: { saved: WorkspaceBucket | null; using: boolean }) {
  const save = useSaveBucket();
  const test = useTestBucket();
  const [form, setForm] = useState({
    endpoint: saved?.endpoint ?? "",
    region: saved?.region ?? "",
    bucket: saved?.bucket ?? "",
    prefix: saved?.prefix ?? "",
    pathStyle: saved?.pathStyle ?? false,
  });
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  // Credentials are kept only for the endpoint they were saved for.
  const kept = Boolean(saved?.credentialsSet) && (saved?.endpoint ?? "") === form.endpoint.trim();
  const [result, setResult] = useState<BucketTestResult | null>(null);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setResult(null);
  };
  const input = () => ({
    ...form,
    ...(accessKeyId ? { accessKeyId } : {}),
    ...(secretAccessKey ? { secretAccessKey } : {}),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setResult(null);
    save.mutate(input());
  };
  const runTest = () => {
    setResult(null);
    test.mutate(input(), { onSuccess: setResult });
  };
  const failure =
    save.error?.message ?? test.error?.message ?? (result?.ok ? null : result?.message);
  return (
    <form onSubmit={submit} className="contents">
      <Row name="Endpoint" hint="The service's address. Empty for Amazon S3.">
        <Input
          aria-label="Endpoint"
          placeholder="https://fsn1.your-objectstorage.com"
          className="w-full @3xl/app:w-96"
          value={form.endpoint}
          onChange={(e) => set("endpoint", e.target.value)}
        />
      </Row>
      <Row name="Bucket" hint="Its name and region; us-east-1 where the service has none.">
        <span className="flex w-full flex-wrap gap-2 @3xl/app:w-96">
          <Input
            aria-label="Bucket"
            placeholder="endless-hall-masters"
            className="min-w-0 flex-[2_1_10rem]"
            value={form.bucket}
            onChange={(e) => set("bucket", e.target.value)}
          />
          <Input
            aria-label="Region"
            placeholder="eu-central-1"
            className="min-w-0 flex-[1_1_7rem]"
            value={form.region}
            onChange={(e) => set("region", e.target.value)}
          />
        </span>
      </Row>
      <Row
        name="Prefix"
        hint="Optional. Hekate's objects go under it, in a bucket shared with other things."
      >
        <Input
          aria-label="Prefix"
          placeholder="hekate"
          className="w-full @3xl/app:w-96"
          value={form.prefix}
          onChange={(e) => set("prefix", e.target.value)}
        />
      </Row>
      <Row
        name="Path-style addressing"
        hint="Reach the bucket as endpoint/bucket rather than bucket.endpoint, as most self-hosted services need."
        inline
      >
        <Switch
          label="Path-style addressing"
          checked={form.pathStyle}
          onChange={(on) => set("pathStyle", on)}
        />
      </Row>
      <Row
        name="Access key"
        hint={
          kept
            ? "Saved, and never shown again. Type both to replace them."
            : "Sealed with the workspace's key, and never shown again once saved."
        }
      >
        <span className="flex w-full flex-wrap gap-2 @3xl/app:w-96">
          <Input
            aria-label="Access key ID"
            autoComplete="off"
            spellCheck={false}
            placeholder={kept ? "Access key ID, kept" : "Access key ID"}
            className="min-w-0 flex-[1_1_10rem]"
            value={accessKeyId}
            onChange={(e) => {
              setAccessKeyId(e.target.value);
              setResult(null);
            }}
          />
          <Input
            type="password"
            aria-label="Secret access key"
            autoComplete="new-password"
            placeholder={kept ? "Secret, kept" : "Secret"}
            className="min-w-0 flex-[1_1_10rem]"
            value={secretAccessKey}
            onChange={(e) => {
              setSecretAccessKey(e.target.value);
              setResult(null);
            }}
          />
        </span>
      </Row>
      <Row
        name={using ? "Save changes" : "Use this bucket"}
        hint={
          failure ? (
            <span className="flex items-start gap-1.5 text-signal" role="alert">
              <Icon name="warning" size={13} className="mt-[3px] shrink-0" />
              {failure}
            </span>
          ) : result?.ok ? (
            <span className="text-ink-2" role="status">
              {result.message}
            </span>
          ) : (
            "Saving tests it first: a small probe object is written and deleted again. New files go there from then on."
          )
        }
      >
        <span className="flex gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={test.isPending || save.isPending}
            onClick={runTest}
          >
            {test.isPending ? "Testing" : "Test connection"}
          </Button>
          <Button type="submit" variant="primary" disabled={save.isPending || test.isPending}>
            {save.isPending ? "Saving" : "Save"}
          </Button>
        </span>
      </Row>
    </form>
  );
}
