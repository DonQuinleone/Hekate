import { describe, expect, it } from "vitest";
import { ownedByTarget, typingIn } from "./shortcuts";

const html = (markup: string, selector: string) => {
  document.body.innerHTML = markup;
  return document.querySelector(selector);
};

describe("ownedByTarget", () => {
  it("leaves Space and Enter to buttons and tabs", () => {
    expect(ownedByTarget(" ", html("<button>Play</button>", "button"))).toBe(true);
    expect(ownedByTarget("Enter", html('<div role="tab">QA</div>', "div"))).toBe(true);
    expect(ownedByTarget(" ", html("<div>Page</div>", "div"))).toBe(false);
  });

  it("leaves the arrows to tabs, menus and other composite controls", () => {
    const tab = html('<div role="tablist"><button role="tab">Review</button></div>', "button");
    expect(ownedByTarget("ArrowRight", tab)).toBe(true);
    expect(ownedByTarget("ArrowDown", html('<ul role="listbox"><li>A</li></ul>', "li"))).toBe(true);
    expect(ownedByTarget("ArrowLeft", html("<button>Play</button>", "button"))).toBe(false);
    expect(ownedByTarget("k", tab)).toBe(false);
  });
});

describe("typingIn", () => {
  it("holds every key in a text field", () => {
    const input = html('<input type="text">', "input");
    expect(typingIn("k", input)).toBe(true);
    expect(typingIn(" ", input)).toBe(true);
  });

  it("lets Space through from a range input, but not the arrows", () => {
    const range = html('<input type="range">', "input");
    expect(typingIn(" ", range)).toBe(false);
    expect(typingIn("ArrowLeft", range)).toBe(true);
  });

  it("holds nothing outside a field", () => {
    expect(typingIn("k", html("<div>Page</div>", "div"))).toBe(false);
    expect(typingIn("k", null)).toBe(false);
  });
});
