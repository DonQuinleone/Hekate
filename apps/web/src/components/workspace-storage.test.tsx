import type { WorkspaceStorage } from "@hekate/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { WhereFilesGo } from "./workspace-storage";

const wrap = (children: ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

const storage = (over: Partial<WorkspaceStorage> = {}): WorkspaceStorage => ({
  backend: null,
  defaultBackend: "local",
  available: ["local"],
  usesBucket: false,
  bucket: null,
  ownStorage: { entitled: true, plan: null },
  ...over,
});

const saved = {
  id: "01a15000-0000-7000-8000-0000000000b1",
  endpoint: "https://s3.eu-central-1.amazonaws.com",
  region: "eu-central-1",
  bucket: "endless-hall-masters",
  prefix: "hekate",
  pathStyle: false,
  credentialsSet: true,
  savedAt: "2026-10-14T09:30:00Z",
};

describe("where a workspace's new files go (#508)", () => {
  afterEach(cleanup);

  it("shows its own bucket disabled, with the plan's name, on a plan without it", () => {
    const { getByRole, getByText, queryByRole } = render(
      wrap(
        <WhereFilesGo data={storage({ ownStorage: { entitled: false, plan: "Studio" } })} owner />,
      ),
    );
    expect(getByRole("radio", { name: /Instance storage/ })).toHaveProperty("checked", true);
    expect(getByRole("radio", { name: /Your own S3-compatible bucket/ })).toHaveProperty(
      "disabled",
      true,
    );
    expect(getByText("Your own storage is not on the Studio plan.")).toBeTruthy();
    expect(queryByRole("textbox", { name: "Endpoint" })).toBeNull();
  });

  it("asks for the bucket's details once chosen, never showing saved credentials", () => {
    const { getByRole, getByText } = render(
      wrap(<WhereFilesGo data={storage({ usesBucket: true, bucket: saved })} owner />),
    );
    expect(getByRole("radio", { name: /Your own S3-compatible bucket/ })).toHaveProperty(
      "checked",
      true,
    );
    expect(getByText("Taking new files: endless-hall-masters/hekate")).toBeTruthy();
    expect(getByRole("textbox", { name: "Bucket" })).toHaveProperty(
      "value",
      "endless-hall-masters",
    );
    const key = getByRole("textbox", { name: "Access key ID" });
    expect(key).toHaveProperty("value", "");
    expect(key.getAttribute("placeholder")).toBe("Access key ID, kept");
    // A new endpoint needs them again.
    fireEvent.change(getByRole("textbox", { name: "Endpoint" }), {
      target: { value: "https://fsn1.your-objectstorage.com" },
    });
    expect(key.getAttribute("placeholder")).toBe("Access key ID");
    expect(getByRole("button", { name: "Test connection" })).toBeTruthy();
    // Going back is a choice of its own, with the bucket kept.
    fireEvent.click(getByRole("radio", { name: /Instance storage/ }));
    expect(getByRole("button", { name: "Switch" })).toBeTruthy();
  });

  it("is an owner's to change", () => {
    const { getByRole, getByText } = render(wrap(<WhereFilesGo data={storage()} owner={false} />));
    expect(getByRole("radio", { name: /Instance storage/ })).toHaveProperty("disabled", true);
    expect(getByText("Only an owner can change it.")).toBeTruthy();
  });
});
