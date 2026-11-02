import { describe, expect, it } from "vitest";
import { listsNeedsYou, sectionAt } from "./sidebar";

const id = "0190a1b2-0000-7000-8000-00000000000a";

describe("the sidebar's current section", () => {
  it("is the project's section its address names", () => {
    expect(sectionAt(`/projects/${id}`)).toBe("");
    expect(sectionAt(`/projects/${id}/files`)).toBe("files");
    expect(sectionAt(`/projects/${id}/reviews/new`)).toBe("reviews");
  });

  it("puts import and the other production tools in Production, and the workflow in Settings", () => {
    expect(sectionAt(`/projects/${id}/import`)).toBe("sessions");
    expect(sectionAt(`/projects/${id}/venues`)).toBe("sessions");
    expect(sectionAt(`/projects/${id}/workflow`)).toBe("settings");
  });

  it("finds the section of a page outside the project's address", () => {
    expect(sectionAt(`/files/${id}`)).toBe("files");
    expect(sectionAt(`/tracks/${id}/compare`)).toBe("files");
    expect(sectionAt(`/reviews/${id}`)).toBe("reviews");
    expect(sectionAt(`/takes/${id}`)).toBe("sessions");
    expect(sectionAt(`/sessions/${id}/log`)).toBe("sessions");
  });

  it("is none elsewhere", () => {
    expect(sectionAt("/projects")).toBeNull();
    expect(sectionAt("/inbox")).toBeNull();
  });

  it("leaves Needs you out where the page already lists it", () => {
    expect(listsNeedsYou("/")).toBe(true);
    expect(listsNeedsYou("/inbox")).toBe(true);
    expect(listsNeedsYou("/projects")).toBe(false);
  });
});
