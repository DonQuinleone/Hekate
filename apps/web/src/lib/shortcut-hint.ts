/**
 * Whether a menu item's hint is a keyboard shortcut (`⌘X`, `Ctrl+V`, `?`) rather than words
 * about the item (a step's kind, a role, a reason it is switched off). A shortcut means nothing
 * on a touch screen, so a menu hides it there (#630); words stay wherever the menu is.
 */
export function isShortcutHint(hint: string): boolean {
  return /^(?:(?:⌘|⌥|⇧|⌃|Ctrl\+|Alt\+|Shift\+)+\S{1,6}|[^\p{L}\p{N}\s])$/u.test(hint.trim());
}
