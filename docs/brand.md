# Brand system

Direction: **Signal.** Modern and slick, a premium experience that stays understated, with an edge of class. Dark. References: Linear, Vercel, Raycast, Teenage Engineering, Leica.

Principles:

1. Near-black ground, never pure black.
2. One colour, used once per surface.
3. Hairlines, not borders, cards or shadows.
4. Type and spacing do the work. No ornament.

## Mark

Two heavy stems and a single point where the crossbar of an H would be. It reads as an initial, as a threshold with a light inside it, and as two posts at a junction. The mythology stays implicit.

Construction on a 24 unit grid:

| Part | Value |
| --- | --- |
| Stems | 3.4 wide, 18 tall, 6.2 apart |
| Point | radius 2.0, centred, at 49% of the stem height |
| At 16 px and below | stems 3.6, gap 6.0, point radius 2.2 (`brand/mark-small.svg`) |

Rules: the point is the only coloured element. On monochrome surfaces the point takes the ink colour. Never add a crossbar, outline the mark, or rotate it. Minimum size 12 px.

Files in `brand/`: `mark.svg`, `mark-small.svg`, `mark-on-light.svg`, `mark-mono-light.svg`, `mark-mono-dark.svg`, `app-icon.svg`, `favicon.svg`.

## Wordmark

"Hekate" in Schibsted Grotesk 500 at minus 0.02em tracking, outlined in `brand/wordmark.svg`. In lockups the mark sits to the left at 1.0 to 1.2 times the cap height, with a gap of about a third of the mark width.

Above 64 px, the display variant (`brand/wordmark-display.svg`) replaces the crossbar of the H with the point. Do not use it in running UI.

## Palette

Cool near-black, one signal.

| Token | Hex | Use |
| --- | --- | --- |
| `ground` | `#0A0A0B` | page background |
| `surface` | `#111113` | panels, cards, comment threads |
| `raised` | `#18181B` | hover, active row, selected tool |
| `hairline` | `#222226` | every divider |
| `edge` | `#2E2E33` | control borders, focus outlines at rest |
| `ink` | `#F4F4F5` | primary text, the mark |
| `ink-2` | `#A1A1AA` | secondary text |
| `ink-3` | `#86868F` | labels, metadata (4.5:1 on every surface, overlays included) |
| `signal` | `#F0762E` | the one colour: playhead, anchors, primary action, the point |
| `paper` | `#E9E8E3` | score pages and documents rendered in the viewer |

Status is shown by dot shape and fill (open ring for in review, signal dot for changes requested, ink dot for approved), not by a traffic-light palette.

A comment's category (Noise, Edit, Balance, Performance, Information, or whatever the project names) is a 3 px bar at the thread's left edge, never a pill: `category-1` to `category-6`, given by the category's place among the project's categories and coming round again after six. They are drawn from the families above (`signal`, the workflow node colours, `wave-warm`), so a theme covers them with nothing more. The category's name is in the thread's menu and on the bar's hover.

### Themes

The palette above is the brand, and the default. People may choose another in Appearance, or follow their device, which is dark or light (`apps/web/src/styles/themes.css`):

- **Signal, light:** the same ladder of surfaces on a warm off-white. Its signal darkens to `#B53C0A` so it holds 4.5:1 on every surface and under white text.
- **Alternatives people know:** Catppuccin, Dracula, Gruvbox, Rosé Pine, Osaka Jade, Kanagawa and Solarized, each using its own accent as the signal.

A theme overrides tokens and nothing else. Every text colour (`ink`, `ink-2`, `ink-3`, `signal`) is checked against every surface in each theme for 4.5:1, and the visual suite runs axe on sign-in and the player in light and in Dracula. The choice is applied before the first paint (`public/theme-boot.js`) and kept per person.

## Type

- **Schibsted Grotesk** for the interface and display. Weights 400 and 500 only. Display from 36 px at minus 0.025em; UI text at 13 and 14 px with no tracking.
- One typeface throughout. Data (timecodes, bar numbers, frame numbers, counts) is set in Schibsted Grotesk with tabular figures; there is no monospace face. Labels over a group or a column are 13 px, weight 500, sentence case, in the tertiary ink.

Anchors are always written the same way: `BAR 112.1`, `BARS 118–124`, `04:31.250`, `00:01:12:08`, `F 1736`.

## Shape and space

- Radius 6 px for controls, 8 px for panels, 4 px for chips. Full round only for status pills, avatars and markers.
- 4 px spacing scale. Rows are 34 px; toolbars 40 px; the top bar 52 px.
- Hit targets at least 28 px in dense tool bars and 44 px elsewhere.
- Shadows only for what floats: menus, popovers, dialogs and the paper of a score, at a soft, layered weight. Everything that sits on the page is elevated by a step up the surface scale plus a hairline, never a shadow.

### Density

Rows of lists and settings take their vertical room from five tokens (`--hk-row`, `--hk-row-tight`, `--hk-row-snug`, `--hk-row-loose`, `--hk-row-min`; in Tailwind `py-row`, `py-row-tight`, `py-row-snug`, `py-row-loose`, `min-h-row-min`). A member's Compact choice (Account, Appearance) sets `data-density="compact"` on the page, which tightens all five on the same scale; nothing else changes, and no list sets its own compact spacing. A new list reads these tokens rather than fixed padding.

## Icons

Hekate draws no icons of its own. They are [Lucide](https://lucide.dev)'s (ISC licence), through `lucide-react`, at a fixed 1.5 px stroke whatever the size, and named for what they mean in Hekate rather than how they look: `Icon name="track"`, not a disc. `components/icons.tsx` holds the map, identical in `apps/web` and `apps/prototype`; a new icon is a new name there, never an SVG drawn in a screen. Another programme or service (an editing system, a sign-in provider, a chat) is shown by its own logo, never a generic glyph: the marks come from existing sets, [Simple Icons](https://simpleicons.org) (CC0) where it has them, [FontAudio](https://github.com/fefanto/fontaudio) (CC BY 4.0, by fefanto) for Reaper and [theSVG](https://thesvg.org) (MIT) for Avid, drawn in one colour at the text's height. They are their owners' trademarks, used only to name the programme. In a form, a choice known by its mark is a field-style `Dropdown`, since a native select cannot show it. An icon carries its meaning alone: never a label saying what the icon already says.

## Components

One set, in `apps/web/src/components/ui`, restyled on the tokens and never stock: button, field and its label, input (with small, inline and bare forms), select, textarea, checkbox, radio, choice card, switch, slider, segmented, menu and dropdown, dialog, tabs, chip and count, status dot and pill. Screens build from it and nothing else; a test fails on a form control made anywhere else. Settings rows, cards, section heads and empty states sit beside it in `components/`.

Every piece, in each of its states, is on the reference page at `/reference`. It exists in `pnpm dev` and in the build the visual suite captures, never in a release: it is a reference for whoever builds screens, not part of the product.

## Voice

The words are part of the design, and read as one person wrote them.

- Direct and concrete. Say what the thing is for and what happens next, in one or two short sentences. Second person where it helps ("Ask the group, and everyone in it is asked together").
- Nouns from `docs/domain.md`: track, version, variant, take, session, review, approval, guest, group, workflow. Copy says "workspace", never "organisation".
- A description or hint earns its place by adding what the label cannot: the purpose, the consequence, the limit. One that repeats its label is removed, not padded.
- Never "seamlessly", "powerful", "simply", "easily", "effortlessly", "robust" or "leverage". No marketing register anywhere, and no exclamation marks.
- British English (colour, organisation in code, licence as a noun, behaviour). Sentence case. No em-dashes: commas, colons, semicolons or parentheses.
- Errors say what went wrong and what to do; empty states say what will appear here and how to make it so.

## A workspace's own branding

A workspace may show its own logo and accent on its sign-in page, its guest pages and its email (#185, decision 226). The logo takes the lockup's place there; the lockup stays in the member's shell and the foot of every email. The accent stands in for the signal in Signal's dark and light themes only, and is held to the signal's rule: 4.5:1 on every surface in the dark theme, refused otherwise, with a darker cut computed for the light theme that holds 4.5:1 there (`packages/shared/src/branding.ts`). Other palettes keep their own signal.

## Imagery

Photography is matte, low-key and quiet: dark surfaces, a single hairline, a single point of light. Generated imagery is for mood and marketing only; product UI and the mark are always vector and code.
