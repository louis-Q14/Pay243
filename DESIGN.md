---
name: Pay243
description: Wallet et passerelle de paiement pour la RDC, en noir de raphia et or brossé tissés de géométrie Kuba.
colors:
  raffia-ground: "#0d0c0a"
  raffia-deep: "#0a0907"
  field-ground: "#100e0b"
  woven-panel: "#15130f"
  raised-panel: "#1d1a14"
  hairline: "#2a2620"
  hairline-strong: "#3d362b"
  ivory-ink: "#f2ead8"
  raffia-mute: "#a79c86"
  raffia-faint: "#8d8576"
  brushed-gold: "#d4ad5a"
  gold-light: "#ebcb84"
  gold-deep: "#9c7a35"
  on-gold: "#16120a"
  ok: "#86d6a4"
  ok-ground: "#11251a"
  warn: "#ecc46f"
  warn-ground: "#2d2310"
  err: "#ff948a"
  err-ground: "#2e1514"
  rdc-blue: "#007fff"
  rdc-yellow: "#f7d618"
  rdc-red: "#ce1021"
typography:
  display:
    fontFamily: "Plus Jakarta Sans, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
    fontSize: "34px"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.02em"
    fontFeature: "tnum"
  headline:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 800
    letterSpacing: "-0.02em"
    fontFeature: "tnum"
  title:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 700
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    letterSpacing: "0em"
  status:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 700
rounded:
  hairframe: "2px"
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "14px"
  xl: "16px"
  modal: "18px"
  pill: "99px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "10px"
  "4": "12px"
  "5": "14px"
  "6": "16px"
  "7": "20px"
components:
  button-primary:
    backgroundColor: "{colors.brushed-gold}"
    textColor: "{colors.on-gold}"
    rounded: "{rounded.md}"
    padding: "11px 16px"
  button-primary-hover:
    backgroundColor: "{colors.gold-light}"
  button-ghost:
    backgroundColor: "{colors.raised-panel}"
    textColor: "{colors.ivory-ink}"
    rounded: "{rounded.md}"
    padding: "11px 16px"
  button-link:
    textColor: "{colors.brushed-gold}"
  action-tile:
    backgroundColor: "{colors.woven-panel}"
    textColor: "{colors.ivory-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    padding: "14px 6px 12px"
  action-tile-lead:
    backgroundColor: "{colors.brushed-gold}"
    textColor: "{colors.on-gold}"
    rounded: "{rounded.lg}"
  action-tile-lead-hover:
    backgroundColor: "{colors.gold-light}"
  card:
    backgroundColor: "{colors.woven-panel}"
    textColor: "{colors.ivory-ink}"
    rounded: "{rounded.xl}"
    padding: "20px"
  balance-panel:
    backgroundColor: "{colors.woven-panel}"
    textColor: "{colors.ivory-ink}"
    typography: "{typography.display}"
    rounded: "{rounded.xl}"
    padding: "18px 20px 42px"
  input:
    backgroundColor: "{colors.field-ground}"
    textColor: "{colors.ivory-ink}"
    rounded: "{rounded.md}"
    padding: "11px 12px"
  tab:
    textColor: "{colors.raffia-faint}"
    typography: "{typography.label}"
    padding: "12px 0 14px"
  tab-active:
    textColor: "{colors.ivory-ink}"
  pill-succeeded:
    backgroundColor: "{colors.ok-ground}"
    textColor: "{colors.ok}"
    typography: "{typography.status}"
    rounded: "{rounded.pill}"
  pill-pending:
    backgroundColor: "{colors.warn-ground}"
    textColor: "{colors.warn}"
    typography: "{typography.status}"
    rounded: "{rounded.pill}"
  pill-failed:
    backgroundColor: "{colors.err-ground}"
    textColor: "{colors.err}"
    typography: "{typography.status}"
    rounded: "{rounded.pill}"
  history-icon:
    backgroundColor: "{colors.raised-panel}"
    textColor: "{colors.brushed-gold}"
    rounded: "{rounded.md}"
    size: "38px"
---

# Design System: Pay243

## Overview

**Creative North Star: "Raphia Kuba"**

Pay243 is black raffia cloth with gold woven into it. The ground is a warm near-black, never a cold neutral; panels sit on it as slightly lighter woven squares edged by a brown-gold hairline. Gold is not a glow or an accent sprinkled over darkness: it is a material that does work. It fills the one action that matters most, rings the person's avatar, frames the logo, and above all runs as a stepped Kuba band along the foot of every balance. That band is the signature of money held. Under it, and only there (and at the foot of the sign-in art), a 3px thread in the colours of the DRC flag ties the product to the country.

Density is calm and phone-first. Figures are large, tabular and ivory, with the currency unit set in gold at half size so CDF and USD are told apart at a glance in full sun. Every status reads by shape and word as well as colour: a filled dot for done, an empty ring and dashed border for pending, a cross for failed. Motion is limited to two woven gestures, the Kuba underline that slides between tabs and the band that re-weaves left to right when an amount changes, both removed under reduced motion.

The system rejects the category default of a black screen with a lone gold accent and glowing cards. Nothing glows; depth comes from tone and hairlines.

Migration state: the wallet (`public/app.html`) is the only page on this system today. `kuba.css` loads after `style.css` and the page's inline styles and remaps the legacy tokens (`--ink`, `--blue`, `--bg`, `--card`, `--line`, `--ok`, `--warn`, `--err`, `--r`) onto the Kuba palette, so existing classes and JavaScript keep working. The other pages (index, settings, signup, messages, marchand, checkout, admin, docs, aide) still render the previous blue look and will adopt `kuba.css` later; that blue look is not part of this system.

**Key Characteristics:**
- Warm near-black raffia ground, woven panels, brown-gold hairlines; dark only (`color-scheme: dark`).
- Gold is a working material: lead action, avatar ring, logo frame, focus, links, the Kuba band.
- Rectilinear stepped Kuba motifs; corners softened to 14-16px on containers.
- Large tabular ivory figures, currency unit in gold at .5em.
- Vivid colour confined to operator logos, statuses and the DRC tricolour thread.
- Status is always doubled by shape and word.

## Colors

A warm, low-chroma black-and-ivory scale carried by one brushed gold, with vivid colour rationed to meaning.

### Primary
- **Brushed Gold** (`brushed-gold`): the lead action tile, primary buttons, focus outline, links, avatar ring, currency unit, Kuba patterns, converter swap control, text selection.
- **Gold Light** (`gold-light`): hover state of gold surfaces and links; output figures in the converter; code and secrets.
- **Gold Deep** (`gold-deep`): the secondary stroke of the Kuba band, hover border of tiles and ghost buttons, the border of the converter result and of the activation gate.
- **On Gold** (`on-gold`): text and icons on gold fills.

### Tertiary (the DRC thread)
- **RDC Blue, Yellow, Red** (`rdc-blue`, `rdc-yellow`, `rdc-red`): only as the tricolour thread (blue 0-62%, yellow 62-69%, red 69-76%, blue to the end), 3px under the balance band and 4px under the sign-in art. Red also marks the unread support badge.

### Neutral
- **Raffia Ground** (`raffia-ground`): page background.
- **Raffia Deep** (`raffia-deep`): the header bar, secrets, the deepest end of the card wallet gradient.
- **Field Ground** (`field-ground`): input and select backgrounds, a step below the panel so fields read as sunk.
- **Woven Panel** (`woven-panel`): cards, balance panels, action tiles, modals.
- **Raised Panel** (`raised-panel`): hover, ghost buttons, pills, history icons, chips, toasts.
- **Hairline** (`hairline`) and **Hairline Strong** (`hairline-strong`): panel borders, list dividers, tab baseline; the strong one for interactive borders (tiles, inputs, ghost buttons, modals).
- **Ivory Ink** (`ivory-ink`): all primary text and figures.
- **Raffia Mute** (`raffia-mute`, 6.6:1 on panel): secondary text, labels, captions.
- **Raffia Faint** (`raffia-faint`, 4.9:1 on panel): inactive tabs, placeholders. Never lower than this for text.

### Status
- **Ok / Warn / Err** on their dark grounds (`ok` on `ok-ground`, `warn` on `warn-ground`, `err` on `err-ground`), each with a matching darker border. Credits are green; pending amounts fall back to mute, not green, until the money has arrived.

### Named Rules
**The Gold Does Work Rule.** Gold appears where it carries meaning: the lead action, the held-money band, focus, the unit of a figure, the person's ring. It is never a decorative glow or gradient wash.

**The Rationed Colour Rule.** Saturated colour is reserved for operator logos (shown on an ivory chip so their own colours stay true), statuses, and the DRC thread. Nothing else on the screen is vivid.

**The Shape And Word Rule.** No state is signalled by colour alone. Done is a filled dot, pending an empty ring (and a dashed icon border), failed a cross, each with its word.

## Typography

**Display Font:** Plus Jakarta Sans (variable 200-800, self-hosted; fallback system-ui, Segoe UI, Roboto, Arial)
**Body Font:** Plus Jakarta Sans
**Label/Mono Font:** ui-monospace, SFMono-Regular, Menlo for codes and references (13px, in gold light)

**Character:** One geometric sans, tightened for figures and opened slightly between words (`word-spacing: .08em`, `.14em` on h1/h2) because its native space is narrow.

### Hierarchy
- **Display** (700, 34px, 32px on phones, line-height 1.15, -0.02em, tabular): balance figures only. The currency unit follows at .5em, 700, in gold.
- **Headline** (800, 28px, 24px on phones, -0.02em, tabular): the amount at the head of a transaction detail.
- **Title** (700, 16px, -0.01em): card headings such as "Historique".
- **Body** (400, 15px, line-height 1.5): running text and list rows.
- **Label** (600, 13px, no tracking, sentence case): field labels, balance captions, action tile names, tabs (tabs at 600, body size).
- **Status** (700, 12px): pills.

### Named Rules
**The Tabular Money Rule.** Every amount (balances, history, transaction detail, converter) uses `font-variant-numeric: tabular-nums`, so columns of figures align and changing values do not jitter.

**The Sentence Case Rule.** Captions and labels are sentence case with no letter-spacing. The legacy uppercase tracked captions are switched off on balances and are not to return.

## Layout

A single centred column (max 980px, 20px gutter; 10-14px on phones under 560px). The header is a full-width black bar, sticky. Tabs sit on a hairline baseline. On the home tab the two balance panels share a row on wide screens (auto-fit grid, minimum 260px) and stack one per line on phones so figures keep their size. Below them, four action tiles in a single row of four at every width, then the history card. Spacing follows a small rhythm of 4, 8, 10, 12, 14, 16 and 20px; gaps between panels are 10-16px. Touch targets in the action row stay at least as tall as the icon plus label (about 64px).

## Elevation & Depth

Flat at rest. Depth comes from tonal steps (ground, panel, raised) and hairline borders, never from glow. Shadows exist only for things that float above the page.

### Shadow Vocabulary
- **Floating message** (`box-shadow: 0 12px 32px rgba(0,0,0,.55)`): toasts.
- **Window** (`box-shadow: 0 24px 60px rgba(0,0,0,.6)`): modals, over a `rgba(5,4,3,.72)` scrim; the card wallet uses the same depth at .45.
- **Hair ring** (`box-shadow: 0 0 0 1px rgba(212,173,90,.55)`): the gold frame around the logo; `0 0 0 1.5px` solid gold for the avatar ring; `0 0 0 2px` gold for a selected operator.

### Named Rules
**The No Glow Rule.** No coloured shadows, no gold blur, no glowing cards. A gold edge is always a crisp ring or hairline.

## Shapes

Rectilinear and stepped. Containers have softened corners: panels and balances 16px (14px on phones), action tiles 14px (12px on phones), buttons, inputs and history icons 10px, modals 18px. Pills are fully round; history icons are rounded squares, like the cells of a weave, not circles. The Kuba motifs are drawn as inline SVG data URIs and are always orthogonal: a 12x6 stepped crenellation (the tab underline), a 44x22 meander band in gold with gold-deep ticks (the balance foot; the USD panel offsets it half a step so the two currencies are two weaves), and a 96x96 cloth tile used at 50% under a diagonal mask on the sign-in art.

**The Orthogonal Motif Rule.** Kuba ornament is built from horizontal and vertical steps only. No curves, diagonals or generic "African" pattern clip art.

## Components

### Buttons
Solid, quiet, confident.
- **Shape:** gently rounded (10px).
- **Primary:** brushed gold fill, on-gold text, 700, 11px 16px.
- **Hover / Focus:** hover lightens by `filter: brightness(1.1)` (or to gold light where the fill is set explicitly); focus is a 2px gold outline offset 2px. Transitions 150ms on colour and border.
- **Ghost:** raised panel fill, ivory text, strong hairline border; hover deepens the fill and turns the border gold deep.
- **Link:** no fill, gold text, gold light on hover.
- **Destructive:** err on err-ground with its border; when armed, solid red with white text.

### Action Tiles
The four money verbs (Recharger, Envoyer, Retirer, Convertir) as square-ish tiles: woven panel, strong hairline, 14px corners, a 22px stroke icon in gold above a 13px label. The first tile is always solid gold with on-gold icon and text; it is the one-tap default. Hover: raised fill and gold-deep border.

### Cards / Containers
- **Corner Style:** 16px (12px on phones).
- **Background:** woven panel.
- **Shadow Strategy:** none (see Elevation).
- **Border:** 1px hairline.
- **Internal Padding:** 20px (14px on phones).

### Inputs / Fields
- **Style:** field ground fill, strong hairline, 10px corners, ivory text, faint placeholder, gold caret.
- **Focus:** border turns gold with a 2px gold outline at 30% opacity.
- **Operator picker:** each operator sits on an ivory chip so its logo keeps its own colours; selected adds a gold border and a 2px gold ring.

### Chips
Amount shortcuts in the converter: raised fill, strong hairline, pill shape; hover turns border and text gold.

### Status Pills
Pill-shaped, 12px 700, each led by a 6px marker: filled dot (succeeded, green), empty ring (pending/processing, amber), cross (failed/canceled/expired, red). Neutral pills use raised fill and ivory text.

### Navigation
- **Header:** raffia-deep bar with a hairline bottom; logo framed by a gold hair ring; avatar ringed in gold; secondary links in mute, gold light on hover.
- **Tabs:** text-only, 600, faint when inactive, ivory when active or hovered; no pill or box. The active tab is underlined by the stepped Kuba indicator, which slides and resizes between tabs (380ms, `cubic-bezier(.2,.8,.2,1)`), static under reduced motion.

### Balance Panel (signature)
Woven panel, 16px corners, a mute caption, then the display figure with its gold unit. Its foot carries the Kuba band (22px, 18px on phones, hairline above) and under it the 3px DRC thread. On load the band weaves in left to right (900ms, `cubic-bezier(.2,.8,.2,1)`, clip-path); when the amount changes it re-weaves. Reduced motion removes the animation and shows the band whole.

### History Row
Full-bleed hairline dividers; a 38px (34px on phones) rounded-square icon (10px) per row: gold on raised for neutral operations, green for credits, amber with a dashed border for pending, red for failed. Amount right-aligned and tabular; a pending amount stays mute.

## Do's and Don'ts

### Do:
- **Do** put the Kuba band and DRC thread at the foot of every panel that shows money held, and nowhere as filler.
- **Do** make the first action in a row of money verbs solid gold and keep the rest woven panel.
- **Do** set every amount in tabular figures, with the unit in gold at .5em on balances.
- **Do** double every status with a shape and a word (filled dot, empty ring or dashed border, cross).
- **Do** show operator and card-network logos on an ivory chip so their own colours stay true.
- **Do** keep secondary text at raffia mute (6.6:1) and never below raffia faint (4.9:1) on panels.
- **Do** drop the tab slide and band weave under `prefers-reduced-motion: reduce`.

### Don't:
- **Don't** add glow, gold blur or coloured shadows to cards or buttons; depth is tonal.
- **Don't** introduce vivid colour outside logos, statuses and the DRC thread.
- **Don't** reintroduce the legacy blue gradients, the yellow circle on balances, or uppercase tracked captions.
- **Don't** draw Kuba motifs with curves or diagonals; they are orthogonal steps.
- **Don't** colour a pending amount green before the money has arrived.
- **Don't** load external fonts or assets; the CSP forbids it and Plus Jakarta Sans is self-hosted.
