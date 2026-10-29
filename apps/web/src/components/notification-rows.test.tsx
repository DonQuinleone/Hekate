import { notificationCatalogue, notificationKinds } from "@hekate/shared";
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationRows } from "./notification-rows";

describe("the account's notification rows", () => {
  afterEach(cleanup);

  it("reads Event, description, App, Mail on every row (#504)", () => {
    const onChange = vi.fn();
    const { getByText } = render(
      <NotificationRows preferences={{ kinds: {} }} onChange={onChange} />,
    );
    for (const kind of notificationKinds) {
      const { title, description } = notificationCatalogue[kind];
      const row = getByText(title).closest("div.flex.gap-4");
      expect(row, kind).not.toBeNull();
      if (!row) continue;
      const inRow = within(row as HTMLElement);
      // The description on its own line, under the event.
      expect(inRow.getByText(description)).toBeTruthy();
      // The switches are headed by the channel's name alone, and named for the event with it.
      const switches = inRow.getAllByRole("switch");
      expect(switches.map((s) => s.nextElementSibling?.textContent)).toEqual(["App", "Mail"]);
      expect(switches.map((s) => s.getAttribute("aria-label"))).toEqual([
        `${title}, App`,
        `${title}, Mail`,
      ]);
    }
  });

  it("keeps the always-in-app kinds on, and reports the rest as they are flipped", () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <NotificationRows
        preferences={{ kinds: { version: { app: true, mail: false } } }}
        onChange={onChange}
      />,
    );
    expect(getByRole("switch", { name: "Review asked of me, App" })).toHaveProperty(
      "disabled",
      true,
    );
    const mail = getByRole("switch", { name: "New version, Mail" });
    expect(mail.getAttribute("aria-checked")).toBe("false");
    mail.click();
    expect(onChange).toHaveBeenCalledWith("version", "mail", true);
  });
});
