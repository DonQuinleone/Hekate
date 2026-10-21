import { formatBytes } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type DragEvent, useRef, useState } from "react";
import { Icon } from "~/components/icons";
import { FileInput } from "~/components/ui/input";
import { cn } from "~/lib/cn";
import { formatDates } from "~/lib/locale";
import { uploadLinkQuery } from "~/lib/queries";
import { sendToRequest } from "~/lib/upload";
import { ErrorLine, Field, Frame } from "./auth-pages";

const dayFormat = formatDates({ day: "numeric", month: "long", year: "numeric" });

interface Sending {
  key: string;
  file: File;
  sent: number;
  status: "waiting" | "sending" | "arrived" | "failed";
  error?: string;
}

/**
 * The page an upload request's link opens (#139), for someone with no account: what is asked
 * for, their name, and the files. It shows nothing of the project but the request's own words;
 * what is sent goes straight into the folder the request names.
 */
export function UploadLinkPage({ token }: { token: string }) {
  const { data, error, refetch } = useQuery(uploadLinkQuery(token));
  const [sender, setSender] = useState("");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [queue, setQueue] = useState<Sending[]>([]);
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const pending = useRef<Sending[]>([]);
  const busy = useRef(false);

  if (error)
    return (
      <Frame
        title="This link does not lead anywhere"
        intro="It may have been replaced or closed. Ask whoever sent it for a new one."
      >
        {null}
      </Frame>
    );
  if (!data) return null;
  const { request } = data;
  const until = dayFormat.format(new Date(request.expiresAt));
  if (request.state === "expired" || request.state === "closed")
    return (
      <Frame
        title="This request has closed"
        intro={
          request.state === "expired"
            ? `Uploads were accepted until ${until}. Ask ${request.workspace} to open it again.`
            : `${request.workspace} closed it. Ask them for a new link if you still have files to send.`
        }
      >
        {null}
      </Frame>
    );
  const sending = queue.filter((s) => s.status === "waiting" || s.status === "sending").length;
  const places = request.fileLimit - request.arrived - sending;
  if (request.state === "full" && sending === 0)
    return (
      <Frame
        title="The limit is reached"
        intro={`This request accepted ${request.fileLimit} ${request.fileLimit === 1 ? "file" : "files"}, and ${request.arrived} have arrived.`}
      >
        {null}
      </Frame>
    );

  const ready = sender.trim().length > 0 && (!request.needsPassword || password.length > 0);
  const update = (key: string, change: Partial<Sending>) =>
    setQueue((q) => q.map((s) => (s.key === key ? { ...s, ...change } : s)));

  /** Sends what waits, one file at a time, so a full request refuses only what is over. */
  const run = async () => {
    if (busy.current) return;
    busy.current = true;
    for (let item = pending.current.shift(); item; item = pending.current.shift()) {
      update(item.key, { status: "sending" });
      try {
        await sendToRequest(item.file, {
          token,
          sender: sender.trim(),
          password: request.needsPassword ? password : undefined,
          signal: new AbortController().signal,
          onProgress: (p) => update(item.key, { sent: p.sent }),
        });
        update(item.key, { status: "arrived", sent: item.file.size });
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure);
        update(item.key, { status: "failed", error: message });
        if (message.includes("password")) {
          setPasswordError(message);
          // The rest would be refused alike: they are chosen again once it is right.
          for (const rest of pending.current.splice(0))
            update(rest.key, { status: "failed", error: "Not sent" });
          break;
        }
      }
      await refetch();
    }
    busy.current = false;
  };

  const add = (files: File[]) => {
    setProblem(null);
    setPasswordError(null);
    if (!ready) {
      setProblem(
        request.needsPassword
          ? "Say who you are and give the password first."
          : "Say who you are first.",
      );
      return;
    }
    const taken = files.slice(0, Math.max(places, 0));
    if (taken.length < files.length)
      setProblem(
        places <= 0
          ? "This request has all the files it asked for."
          : `Only ${places} more ${places === 1 ? "file fits" : "files fit"}; the rest were left out.`,
      );
    const items = taken.map((file) => ({
      key: `${file.name}:${file.size}:${file.lastModified}:${Math.random()}`,
      file,
      sent: 0,
      status: "waiting" as const,
    }));
    setQueue((q) => [...q, ...items]);
    pending.current.push(...items);
    void run();
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    add([...event.dataTransfer.files]);
  };

  return (
    <Frame
      title={request.name}
      intro={`${request.workspace} asks for up to ${request.fileLimit} ${request.fileLimit === 1 ? "file" : "files"}, until ${until}.`}
    >
      {request.wanted && (
        <p className="m-0 -mt-4 whitespace-pre-line text-[14px] leading-normal text-ink-2">
          {request.wanted}
        </p>
      )}
      <Field
        id="sender"
        label="Your name"
        placeholder="So they know who sent them"
        autoComplete="name"
        value={sender}
        onChange={(e) => setSender(e.target.value)}
      />
      {request.needsPassword && (
        <div className="flex flex-col gap-2">
          <Field
            id="password"
            label="Password"
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setPasswordError(null);
            }}
          />
          <ErrorLine message={passwordError} />
        </div>
      )}
      <FileInput
        ref={picker}
        multiple
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          add([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => (ready ? picker.current?.click() : add([]))}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        className={cn(
          "flex flex-col items-center gap-2 rounded-panel-lg border border-dashed border-line-strong px-6 py-10 text-center transition-colors hover:border-edge-strong hover:bg-raised/40",
          over && "border-edge-strong bg-raised/40",
        )}
      >
        <Icon name="upload" size={20} className="text-ink-3" />
        <span className="text-[14px] text-ink">Drop files here, or choose them</span>
        <span className="text-[13px] text-ink-3">
          Any kind of file. If the connection drops, choose the same file again to carry on.
        </span>
      </button>
      <ErrorLine message={problem} />
      {queue.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {queue.map((s) => (
            <li key={s.key} className="flex flex-col gap-1 text-[13px]">
              <span className="flex items-center gap-3">
                <Icon name="file" size={14} className="shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1 truncate text-ink-2">{s.file.name}</span>
                <span className="tabular shrink-0 text-ink-3">
                  {s.status === "arrived"
                    ? "Arrived"
                    : s.status === "failed"
                      ? "Not sent"
                      : s.status === "waiting"
                        ? "Waiting"
                        : formatBytes(s.file.size)}
                </span>
                <span
                  aria-hidden="true"
                  className="h-1 w-20 shrink-0 overflow-hidden rounded-full bg-raised"
                >
                  <span
                    className={cn("block h-full", s.status === "failed" ? "bg-signal" : "bg-ink-2")}
                    style={{ width: `${s.file.size ? (100 * s.sent) / s.file.size : 100}%` }}
                  />
                </span>
              </span>
              {s.status === "failed" && s.error && s.error !== "Not sent" && (
                <span className="pl-[26px] text-[12px] text-ink-3">{s.error}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="m-0 text-[13px] text-ink-3">
        {request.arrived} of {request.fileLimit} sent. The files go straight into the project's
        folder; only its members see them.
      </p>
    </Frame>
  );
}
