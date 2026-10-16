import { describe, expect, it } from "vitest";
import { emailSubjectsChange, fillSubject, subjectFor, unknownPlaceholders } from "./email.ts";

describe("subject lines", () => {
  it("fills placeholders, drops ones without a value and keeps to one line", () => {
    expect(
      fillSubject("{review}: {decision}", { review: "Album masters", decision: "approved" }),
    ).toBe("Album masters: approved");
    expect(fillSubject("{review} {missing}\n done", { review: "Cut 3" })).toBe("Cut 3 done");
  });

  it("knows which placeholders each template offers", () => {
    expect(unknownPlaceholders("invitation", "Join {workspace}, from {inviter}")).toEqual([]);
    expect(unknownPlaceholders("invitation", "{review} for {kind}")).toEqual(["review", "kind"]);
  });

  it("refuses a subject with someone else's placeholders, and takes null as the default", () => {
    expect(emailSubjectsChange.safeParse({ invitation: "Join {review}" }).success).toBe(false);
    expect(emailSubjectsChange.safeParse({ invitation: null }).success).toBe(true);
    expect(emailSubjectsChange.safeParse({ nonsense: "x" }).success).toBe(false);
  });

  it("uses the workspace's line, else the template's", () => {
    const values = { workspace: "Endless Hall Records", inviter: "Ines Arlow" };
    expect(subjectFor("invitation", {}, values)).toBe("Join Endless Hall Records on Hekate");
    expect(subjectFor("invitation", { invitation: "{inviter} invites you" }, values)).toBe(
      "Ines Arlow invites you",
    );
  });
});
