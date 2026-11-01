/**
 * Whether the person last used a pointer or the keyboard, kept on the page as `data-input`.
 * The focus ring is for finding your place with the keyboard: a button, a tab or a link
 * clicked with a pointer keeps no ring after it (#605), whatever the browser decides about
 * `:focus-visible` (Chromium shows it on a tab focused as it is clicked, for one). A field
 * keeps its focused border either way, as it takes typing.
 */
export function followInputModality(root: HTMLElement = document.documentElement) {
  const pointer = () => {
    root.dataset.input = "pointer";
  };
  const keyboard = (event: KeyboardEvent) => {
    // A modifier alone (Shift before a click) is not a move with the keyboard.
    if (event.key === "Shift" || event.key === "Control" || event.key === "Alt") return;
    if (event.key === "Meta") return;
    root.dataset.input = "keyboard";
  };
  window.addEventListener("pointerdown", pointer, true);
  window.addEventListener("keydown", keyboard, true);
  return () => {
    window.removeEventListener("pointerdown", pointer, true);
    window.removeEventListener("keydown", keyboard, true);
  };
}
