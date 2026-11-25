---
name: Pay243
description: Wallet et passerelle de paiement pour la RDC, en noir de raphia et or brossé ; l'accueil est une pochette de rumba.
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
    fontFamily: "Bricolage Grotesque, Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "50px"
    fontWeight: 700
    lineHeight: 1.02
    letterSpacing: "-0.035em"
    fontFeature: "tnum"
  headline:
    fontFamily: "Bricolage Grotesque, Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 700
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
  sleeve-title:
    fontFamily: "Bricolage Grotesque, Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "calc(var(--sl) * .37)"
    fontWeight: 800
    lineHeight: 0.8
    letterSpacing: "-0.04em"
    fontFeature: "tnum"
  home-display:
    fontFamily: "Bricolage Grotesque, Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "clamp(40px, 4.1vw, 62px)"
    fontWeight: 700
    lineHeight: 0.98
    letterSpacing: "-0.035em"
  home-headline:
    fontFamily: "Bricolage Grotesque, Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "clamp(32px, 3.6vw, 54px)"
    fontWeight: 700
    lineHeight: 1.02
    letterSpacing: "-0.03em"
  home-title:
    fontFamily: "Bricolage Grotesque, Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "clamp(22px, 2.2vw, 30px)"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  home-body:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.55
  home-lead:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.55
  track:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
  track-fee:
    fontFamily: "Bricolage Grotesque, Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    fontFeature: "tnum"
  code:
    fontFamily: "ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.65
rounded:
  hairframe: "2px"
  xs: "6px"
  sm: "8px"
  md: "10px"
  bubble: "12px"
  lg: "14px"
  xl: "16px"
  modal: "18px"
  pill: "99px"
  round: "50%"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "10px"
  "4": "12px"
  "5": "14px"
  "6": "16px"
  "7": "20px"
  gutter: "clamp(16px, 4vw, 56px)"
  section: "clamp(72px, 9vw, 128px)"
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
  home-button-gold:
    backgroundColor: "{colors.brushed-gold}"
    textColor: "{colors.on-gold}"
    rounded: "{rounded.hairframe}"
    padding: "0 22px"
    height: "48px"
  home-button-gold-hover:
    backgroundColor: "{colors.gold-light}"
  home-button-gold-lg:
    padding: "0 28px"
    height: "56px"
  home-button-line:
    textColor: "{colors.ivory-ink}"
    rounded: "{rounded.hairframe}"
    padding: "0 22px"
    height: "48px"
  home-button-line-hover:
    textColor: "{colors.gold-light}"
  home-input:
    backgroundColor: "{colors.woven-panel}"
    textColor: "{colors.ivory-ink}"
    rounded: "{rounded.hairframe}"
    padding: "0 18px"
    height: "56px"
  sleeve:
    backgroundColor: "{colors.woven-panel}"
    textColor: "{colors.brushed-gold}"
    typography: "{typography.sleeve-title}"
    padding: "calc(var(--sl) * .075)"
    width: "min(540px, 37.5vw)"
  disc-label:
    backgroundColor: "{colors.brushed-gold}"
    textColor: "{colors.on-gold}"
    rounded: "{rounded.round}"
  side-switch-active:
    backgroundColor: "{colors.raised-panel}"
    textColor: "{colors.ivory-ink}"
    rounded: "{rounded.hairframe}"
    padding: "10px 18px 11px"
  track-row:
    textColor: "{colors.ivory-ink}"
    typography: "{typography.track}"
    padding: "11px 0"
  track-fee:
    textColor: "{colors.brushed-gold}"
    typography: "{typography.track-fee}"
  side-mark:
    backgroundColor: "{colors.brushed-gold}"
    textColor: "{colors.on-gold}"
    rounded: "{rounded.round}"
    size: "clamp(84px, 9vw, 128px)"
  receipt:
    backgroundColor: "{colors.woven-panel}"
    textColor: "{colors.ivory-ink}"
    rounded: "{rounded.hairframe}"
    padding: "6px 18px"
  status-tag-ok:
    backgroundColor: "{colors.ok-ground}"
    textColor: "{colors.ok}"
    rounded: "{rounded.hairframe}"
    padding: "3px 9px"
  status-tag-wait:
    backgroundColor: "{colors.warn-ground}"
    textColor: "{colors.warn}"
    rounded: "{rounded.hairframe}"
    padding: "3px 9px"
  whatsapp-bubble:
    backgroundColor: "#1f2a22"
    textColor: "{colors.ivory-ink}"
    rounded: "2px 12px 12px 12px"
    padding: "12px 14px 8px"
    width: "330px"
  code-block:
    backgroundColor: "{colors.raffia-ground}"
    textColor: "{colors.ivory-ink}"
    typography: "{typography.code}"
    rounded: "{rounded.hairframe}"
    padding: "16px 18px 18px"
---

# Design System: Pay243

<!-- MERGE STATE: two worlds share one palette while pages are redesigned one by one. A clean full rewrite is due once every page has moved. -->

## Overview

**Creative North Star: "Raphia Kuba" (the product), with "La pochette de rumba" for the home page**

Pay243 currently runs on two worlds made of the same materials: the same warm near-black, the same ivory, the same brushed gold, the same two self-hosted faces. Which world governs a page depends on the stylesheet it loads:

| World | Governs | Stylesheets |
|---|---|---|
| **Raphia Kuba** | no page is rendered in this world any more. `kuba.css` stays loaded underneath `app.html`, `marchand.html`, `checkout.html` and `docs.html` only as the token and operator-logo base that `wallet.css` and `rumba-app.css` re-skin; a clean rewrite of DESIGN.md around the rumba world alone is now due | `kuba.css` (tokens), over the legacy `style.css` |
| **La pochette de rumba (back-office)** | the staff back office (`public/admin.html`) | self-contained page; its rumba skin is the last block of its inline style: 2px corners on every control, status and card, the sign-in card as a sleeve (inset gold rule, equal-thirds RDC thread), the active side-menu entry framed by a hairline with gold text (no side bar), KPIs as one ruled band with display figures, sentence-case table headers, square chart bars, a drawn SVG menu icon instead of the ☰ glyph |
| **La pochette de rumba (documentation)** | the developer docs (`public/docs.html`) | `rumba-app.css` after `kuba.css`, plus its own block: home-style bar with a "Documentation API" tag, a sticky numbered table of contents (1–9, the reading order) beside a 760px text column, numbered gold section titles, 2px code blocks in the monospace code face, ruled tables with sentence-case headers, square GET/POST tags, and the minor-units warning as a small sleeve (inset gold rule, equal-thirds RDC thread). Under 900px the table of contents is hidden so the text comes first |
| **La pochette de rumba (paiement hébergé)** | the hosted checkout (`public/checkout.html`, served at `/checkout/:id`) | `rumba-app.css` after `kuba.css`, plus its own block: the amount on a sleeve (merchant name, large gold display figure, inset gold rule, equal-thirds RDC thread at its foot), payment methods as ruled rows (the chosen one framed in gold), square operator chips on ivory, drawn SVG icons instead of emoji (lock, wallet, card, warning, clock, check), and the waiting state as a small vinyl disc with a gold label turning at 33⅓ rpm (still under reduced motion) |
| **La pochette de rumba (aide)** | the help centre (`public/aide.html`) | `home.css` (same bar, mobile menu and buttons as the home page) plus its own inline block: left-aligned display title with the context line under it (no eyebrow), square search field with a gold button, square topic chips, articles as a ruled accordion, the five "other ways to get help" as a numbered tracklist (the old pastel illustrations are gone), and the message-centre entry as a sleeve (inset gold rule, equal-thirds RDC thread at its foot). `landing.css` is now loaded only by settings |
| **La pochette de rumba (messages)** | the support message centre (`public/messages.html`) | self-contained page (no shared stylesheet besides `fonts.css`); its rumba skin is the last block of its inline style: home-style 68px bar without the RDC rule under it, 1520 frame, large display "Messages" title, conversations as ruled rows (the open one framed in gold), 2px bubbles (the visitor's own bordered in gold-deep), 2px buttons, chips, attachments and fields; only the unread dot stays round |
| **La pochette de rumba (paramètres)** | settings (`public/settings.html`) | the page loads `landing.css` (not `kuba.css`, whose global `button` rule would paint its link-buttons gold), so its rumba skin is the last block of its own inline style: home-style 68px bar, gold-underlined tabs, 2px panels/options/fields/tags/dialogs, the profile banner as a sleeve (inset gold rule, equal-thirds RDC thread at its foot; the avatar stays round), square switches gold when on, limits as three ruled columns with gold display figures |
| **La pochette de rumba (pages connectées)** | the merchant payments monitor (`public/marchand.html`) | `rumba-app.css`, loaded after `kuba.css`: shared signed-in skin (68px header bar, gold-underlined tabs, 2px cards, fields, buttons, statuses, dialogs, square-cornered detail drawer) plus the merchant board scoped to `main.mon`: KPIs as one ruled band (no boxed cards), the available balance as a sleeve (inset gold rule, gold figure, equal-thirds RDC thread at its foot), sentence-case labels, two-face currency switch, square chart bars. The next signed-in pages (settings, messages) are meant to load this file too |
| **La pochette de rumba** | the home page (`public/index.html`), signup (`public/signup.html`), the sign-in screen (`#auth` inside `public/app.html`) and the signed-in wallet (`public/app.html`) | `home.css`, standalone, on index and signup; on `app.html` the sign-in screen carries a copy of the sleeve and disc scoped to `#auth`, and `wallet.css` (loaded after `kuba.css`, on `app.html` only) re-skins the wallet into this world: the balances sleeve with its inset gold rule and equal-thirds RDC thread, the four operations as a tracklist (A1 Recharger in solid gold), the carnet as ruled rows under gold day titles, 2px corners on cards, fields, buttons, statuses and dialogs. `kuba.css` stays loaded underneath for the shared tokens and the operator logo chips |

Shared sections below (palette, the two faces, the No Glow Rule, the Tabular Money Rule, the Shape And Word Rule, self-hosting) apply to both. Anything marked *Home page* applies only to `index.html`; anything marked *Raphia Kuba* applies to every other page. Do not carry home-page components onto the product pages, or Kuba components onto the home page, until a page is explicitly redesigned.

**Raphia Kuba.** Pay243 is black raffia cloth with gold woven into it. The ground is a warm near-black, never a cold neutral; panels sit on it as slightly lighter woven squares edged by a brown-gold hairline. Gold is not a glow or an accent sprinkled over darkness: it is a material that does work. It fills the one action that matters most, rings the person's avatar, frames the logo, and above all runs as a stepped Kuba band along the foot of every balance. That band is the signature of money held. Under it, and only there (and at the foot of the sign-in art), a 3px thread in the colours of the DRC flag ties the product to the country.

Density is calm and phone-first. Figures are large, tabular and ivory, with the currency unit set in gold at half size so CDF and USD are told apart at a glance in full sun. Every status reads by shape and word as well as colour: a filled dot for done, an empty ring and dashed border for pending, a cross for failed. Motion is limited to two woven gestures, the Kuba underline that slides between tabs and the band that re-weaves left to right when an amount changes, both removed under reduced motion.

**La pochette de rumba (home page).** The home page is a Congolese rumba LP. Its first screen is a square black-board sleeve with "Pay 243" stamped in giant hot-foil gold, the cities across its top, the operators on ivory chips and the DRC thread at its foot; the record slides halfway out of it with a gold centre label reading "Face A". The sections are the sides of the disc: Face A for individuals, Face B for merchants, then the liner notes (security) and the questions. Lists are tracklists: ruled lines, a track number, a dotted leader running to a tabular gold figure. Form language is hairline rules, squares and circles; corners are a near-square 2px, the only rounded surface being the WhatsApp message bubble, which depicts WhatsApp's own screen.

Both worlds reject the category default of a black screen with a lone gold accent and glowing cards. Nothing glows; depth comes from tone and hairlines.

**Key Characteristics:**
- Warm near-black ground, ivory ink, brushed gold as a working material; dark only (`color-scheme: dark`). Shared by both worlds.
- Bricolage Grotesque for money and titles, Plus Jakarta Sans for the interface; every figure tabular.
- Raphia Kuba: woven panels with 14-16px corners, stepped orthogonal Kuba motifs, the balance band.
- Pochette de rumba: 2px corners, hairline rules, circles (disc, label, side marks), tracklists with dotted leaders.
- Vivid colour confined to operator logos, statuses and the DRC tricolour thread.
- Status is always doubled by shape and word.

## Colors

A warm, low-chroma black-and-ivory scale carried by one brushed gold, with vivid colour rationed to meaning. Both worlds use the same values; `home.css` names them `--ground`, `--deep`, `--board`, `--raised`, `--hair`, `--hair-strong`, `--ivory`, `--mute`, `--faint`, `--gold`, `--gold-light`, `--gold-deep`, `--on-gold`, which map one to one onto the tokens below.

### Primary
- **Brushed Gold** (`brushed-gold`): the lead action, focus outline, links, avatar ring, currency unit, Kuba patterns, text selection. *Home page:* the sleeve title, the disc label and side marks, track numbers in the hero accent, every fee at the end of its leader, plage numbers, the hot-foil inset rule on the sleeve (at 38% opacity).
- **Gold Light** (`gold-light`): hover state of gold surfaces and links; output figures in the converter; code and secrets. *Home page:* the sleeve's top line, word fees ("taux affiché", "inclus"), links in running text.
- **Gold Deep** (`gold-deep`): the secondary stroke of the Kuba band, hover border of tiles and ghost buttons. Not used on the home page.
- **On Gold** (`on-gold`): text and icons on gold fills.

### Tertiary (the DRC thread)
- **RDC Blue, Yellow, Red** (`rdc-blue`, `rdc-yellow`, `rdc-red`): only as the tricolour thread. *Raphia Kuba:* blue 0-62%, yellow 62-69%, red 69-76%, blue to the end, 3px under the balance band and 4px under the sign-in art; red also marks the unread support badge. *Home page:* three equal thirds, 5px, at the foot of the sleeve only.

### Neutral
- **Raffia Ground** (`raffia-ground`): page background; on the home page also the code block and the disc's spindle hole.
- **Raffia Deep** (`raffia-deep`): the header bar, secrets, card wallet gradient. *Home page:* the Face B section band and the footer.
- **Field Ground** (`field-ground`): input backgrounds on Kuba pages. Not used on the home page, whose single field sits on woven panel.
- **Woven Panel** (`woven-panel`): cards, balance panels, action tiles, modals. *Home page:* the sleeve board, receipts, the email field.
- **Raised Panel** (`raised-panel`): hover, ghost buttons, pills, chips, toasts. *Home page:* the pressed side of the Face A / Face B switch.
- **Hairline** (`hairline`) and **Hairline Strong** (`hairline-strong`): borders and dividers; the strong one for interactive borders and, on the home page, for the rules that open and close each tracklist, plage and credits block, and for the dotted leaders.
- **Ivory Ink** (`ivory-ink`): all primary text and figures.
- **Raffia Mute** (`raffia-mute`, 6.6:1 on panel): secondary text, captions, leads.
- **Raffia Faint** (`raffia-faint`, 4.9:1 on panel): inactive tabs, placeholders, track numbers, fine print. Never lower than this for text.

### Status
- **Ok / Warn / Err** on their dark grounds (`ok` on `ok-ground`, `warn` on `warn-ground`, `err` on `err-ground`). Credits are green; pending amounts fall back to mute, not green, until the money has arrived. The home page uses ok and warn only.

### Named Rules
**The Gold Does Work Rule.** Gold appears where it carries meaning: the lead action, the held-money band, focus, the unit or fee of a figure, the person's ring, the sleeve's foil. It is never a decorative glow or gradient wash.

**The Rationed Colour Rule.** Saturated colour is reserved for operator logos (shown on an ivory chip so their own colours stay true), statuses, and the DRC thread. Nothing else is vivid. The home page's two depicted surfaces are the stated exceptions: the WhatsApp bubble keeps WhatsApp's green (`#1f2a22`) and link blue (`#9bd0ff`), and the API example uses that same blue for numbers.

**The Shape And Word Rule.** No state is signalled by colour alone. *Raphia Kuba:* done is a filled dot, pending an empty ring (and a dashed icon border), failed a cross. *Home page:* done is a check, pending a clock. Each always carries its word.

## Typography

**Display Font:** Bricolage Grotesque (variable 400-800, self-hosted in `public/assets/fonts`, SIL OFL; token `--font-display`), for money and headings
**Body Font:** Plus Jakarta Sans (variable 200-800, self-hosted; token `--font-sans`), for everything you read or tap
**Label/Mono Font:** *Raphia Kuba:* ui-monospace, SFMono-Regular, Menlo for codes, keys and references (13px, gold light). *Home page:* ui-monospace, Cascadia Mono, Consolas, used only inside the API example.

**Character:** Two clearly distinct voices. Bricolage Grotesque carries amounts and titles: compact, slightly irregular, set tight (-0.02 to -0.04em) and always with tabular figures for money. Plus Jakarta Sans stays the quiet interface voice, opened slightly between words (`word-spacing: .08em`, `.14em` on h1 and h2) because its native space is narrow. `fonts.css` is shared by every page.

### Hierarchy (Raphia Kuba)
- **Display** (Bricolage 700, 50px; 40px on phones; line-height 1.02, -0.035em, tabular): the CDF figure on the plaque. USD below it at 30px (26px on phones). The currency unit follows at .4em in Plus Jakarta 700, gold, raised.
- **Headline** (Bricolage 700, 22-32px, -0.02em): page titles, card titles, modal titles, transaction-detail amount, converter figures (38px, 32px on phones).
- **Title** (Bricolage 700, 16-24px, -0.02em): section and panel headings.
- **Body** (400, 15px, line-height 1.5): running text and list rows.
- **Label** (600, 13px, no tracking, sentence case): field labels, balance captions, action tile names, tabs.
- **Status** (700, 12px): pills.

### Hierarchy (Home page)
- **Sleeve title** (Bricolage 800, 37% of the sleeve width, line-height .8, -0.04em, tabular): "Pay / 243" stacked, the first line ivory, the second gold. Exists once.
- **Home display** (Bricolage 700, clamp 40-62px, line-height .98, -0.035em, balanced): the H1; its key words are set in gold, upright.
- **Home headline** (Bricolage 700, clamp 32-54px, line-height 1.02, -0.03em, max 20ch): section titles beside a side mark; 36-68px and 14ch for the closing "fin de face".
- **Home title** (Bricolage 700, clamp 22-30px, line-height 1.1): plage titles. Plage numbers (A1, B2) sit beside them in gold Bricolage 700, clamp 28-44px.
- **Track** (Plus Jakarta 600, 17px; 19px in the tarifs): tracklist rows. Track numbers in Bricolage 700 14px faint; fees in Bricolage 700 20px gold, tabular (clamp 22-30px in the tarifs); word fees in Plus Jakarta 600 15px gold light.
- **Home lead** (400, 18px, mute, 44-58ch): hero lead and section subtitles.
- **Home body** (400, 16px, line-height 1.55): running text; plage text at 17px mute, max 52ch.
- **Fine** (13px, faint): the reassurance line under the hero action, receipt captions (12px), legal.

### Named Rules
**The Tabular Money Rule.** Every amount and fee (balances, history, transaction detail, converter, tracklists, receipts, the sleeve title) uses `font-variant-numeric: tabular-nums`, so columns of figures align and changing values do not jitter.

**The Sentence Case Rule.** Captions and labels are sentence case with no letter-spacing. Uppercase tracked captions are not to return, on either world.

## Layout

**Raphia Kuba: "the plaque and the carnet".** On desktop (max 1120px) the wallet home tab is two columns: a sticky left column (400px) holding the plaque, the action bar and the limits line, and a right column holding the activation and sales cards and the carnet. Under 900px it becomes one column. Under 560px the tabs leave the top and become a fixed bottom dock, and operation windows open as bottom sheets. The header is a full-width raffia-deep bar, sticky. Spacing follows a small rhythm of 4, 8, 10, 12, 14, 16 and 20px; gaps between panels are 10-16px. Touch targets in the action row stay about 64px tall.

**Home page: the sleeve and its sides.** Content sits in a 1520px max wrap with a fluid gutter (`clamp(16px, 4vw, 56px)`). The hero is two columns: the square record on the left, sized by one variable (`--sl: min(540px, 37.5vw)`) from which the sleeve's padding, title, operator chips and label type are all derived, and the copy on the right, pushed clear of the disc by a column gap of 53% of the sleeve plus 16px. Sections breathe at `clamp(72px, 9vw, 128px)` top and bottom. Each side opens with a side head (side mark plus headline); its plages are three-column rows (number, text, proof up to 400px) separated by strong hairlines. Tarifs, liner notes and questions share a 1 : 1.5 two-column split with a `clamp(28px, 5vw, 80px)` gap. The sticky nav is 68px.

Breakpoints on the home page: at 1080px the menu folds into a burger and the footer goes to two columns; at 900px the hero becomes one column (sleeve `min(64vw, 340px)`, disc slides further out to 62%), plages and every split stack, and the closing disc fades to 45%; at 560px the side switch and every action go full width, tracklist rows tighten and the credits drop to one column.

## Elevation & Depth

Flat at rest on both worlds. Depth comes from tonal steps (ground, panel, raised) and hairline borders, never from glow.

### Shadow Vocabulary
- **Floating message** (`box-shadow: 0 12px 32px rgba(0,0,0,.55)`): toasts. *Raphia Kuba.*
- **Window** (`box-shadow: 0 24px 60px rgba(0,0,0,.6)`): modals, over a `rgba(5,4,3,.72)` scrim; the card wallet uses the same depth at .45. *Raphia Kuba.*
- **Hair ring** (`box-shadow: 0 0 0 1px rgba(212,173,90,.55)`): the gold frame around the logo; `0 0 0 1.5px` for the avatar ring; `0 0 0 2px` for a selected operator. *Raphia Kuba.*
- **Sleeve** (`box-shadow: 0 30px 60px -20px rgba(0,0,0,.8)`) and **Vinyl** (`0 24px 50px -16px rgba(0,0,0,.85)`): the two physical objects of the home hero, a board sleeve and a record resting on the page. *Home page only.*

### Named Rules
**The No Glow Rule.** No coloured shadows, no gold blur, no glowing cards. A gold edge is always a crisp ring or hairline. The home page's vinyl sheen (a faint ivory conic highlight, max 13%, masked off the label) is a lamp reflection on a black object, not a glow.

## Shapes

**Raphia Kuba.** Rectilinear and stepped. Containers have softened corners: panels and balances 16px (14px on phones), action tiles 14px (12px on phones), buttons, inputs and history icons 10px, modals 18px. Pills are fully round; history icons are rounded squares, like the cells of a weave. The Kuba motifs are inline SVG data URIs and always orthogonal: a 12x6 stepped crenellation (the tab underline), a 44x22 meander band in gold with gold-deep ticks (the balance foot), and a 96x96 cloth tile on the sign-in art.

**Home page.** Squares, circles and rules. Every rectangle (buttons, field, receipts, status tags, side switch, code block, operator chips) has a near-square 2px corner; the sleeve itself is square-cornered with a 1px gold inset rule at 3% of its width, like hot-foil framing. Circles are reserved for the record family: the disc (concentric groove rings), its gold label with a spindle hole, and the side marks (a small grooved disc with a gold centre bearing the side letter). Structure is drawn with hairline rules, never with boxes. The FAQ toggle is a gold plus drawn from two 2px bars that turns 45° into a cross.

**The Orthogonal Motif Rule.** *Raphia Kuba.* Kuba ornament is built from horizontal and vertical steps only. No curves, diagonals or generic "African" pattern clip art.

**The One Rounded Bubble Rule.** *Home page.* No rounded cards. The single rounded surface is the WhatsApp bubble (2px 12px 12px 12px), because it depicts WhatsApp's own interface.

## Components

### Buttons
**Raphia Kuba.** Solid, quiet, confident.
- **Shape:** gently rounded (10px).
- **Primary:** brushed gold fill, on-gold text, 700, 11px 16px.
- **Hover / Focus:** hover to gold light; focus is a 2px gold outline offset 2px. Transitions 150ms on colour and border.
- **Ghost:** raised panel fill, ivory text, strong hairline border; hover deepens the fill and turns the border gold deep.
- **Link:** no fill, gold text, gold light on hover.
- **Destructive:** err on err-ground with its border; when armed, solid red with white text.

**Home page.** Square-cut, like a sleeve sticker.
- **Shape:** 2px corners, 48px tall (56px large, 42px in the nav), 700 15px.
- **Gold:** gold fill, on-gold text; hover to gold light.
- **Line:** transparent with a strong hairline and ivory text; hover turns border gold and text gold light.
- **Press / Focus:** press nudges down 1px; focus is a 2px gold outline offset 3px. Transitions 200ms, transform on the expo ease.

### Action Bar *(Raphia Kuba)*
The four money verbs. Recharger is a full-width solid gold button (58px, 16px corners): the one-tap default. Envoyer, Retirer and Convertir follow as one segmented bar of three (50px, outer corners 14px, inner corners square, shared hairlines), icon beside label.

### Bottom Sheet *(Raphia Kuba, phones)*
Under 560px every operation window rises from the bottom: full width, 24px top corners, a 40x4 grab handle, 320ms rise, above the dock. Titles in Bricolage 22px; the primary button is 52px.

### Cards / Containers
- **Raphia Kuba:** woven panel, 16px corners (12px on phones), 1px hairline, 20px padding (14px on phones), no shadow.
- **Home page:** there are no cards. Proof is shown as a **receipt**: woven panel, 1px hairline, 2px corners, 6px 18px padding, label/value lines split by hairlines, values tabular, the key figure in gold Bricolage, an optional large conversion line (Bricolage 24px) and a faint caption stating that the amounts are examples.

### Inputs / Fields
- **Raphia Kuba:** field ground fill, strong hairline, 10px corners, faint placeholder, gold caret; focus turns the border gold with a 2px gold outline at 30%.
- **Home page:** one email field, woven panel fill, strong hairline, 2px corners, 56px tall beside the large gold button; focus turns the border gold with a 1px gold ring.
- **Operator chips (both):** each operator logo sits on an ivory chip so it keeps its own colours.

### Chips *(Raphia Kuba)*
Converter amount shortcuts: raised fill, strong hairline, pill shape; hover turns border and text gold.

### Status
- **Raphia Kuba pills:** pill-shaped, 12px 700, led by a 6px marker: filled dot (succeeded), empty ring (pending), cross (failed). Neutral pills use raised fill and ivory text.
- **Home status tags:** 2px corners, 13px 700, 3px 9px, led by a 13px stroke icon: a check on ok-ground for paid or received, a clock on warn-ground for pending.

### Navigation
- **Raphia Kuba header:** raffia-deep bar with a hairline bottom; logo in a gold hair ring; avatar ringed in gold.
- **Raphia Kuba tabs:** text with a 17px stroke icon, 600, faint inactive, ivory active, underlined by the stepped Kuba indicator that slides between tabs (380ms).
- **Raphia Kuba dock (phones):** tabs fixed at the bottom, 22px icon over an 11px label, gold when active, safe-area padding.
- **Home nav:** sticky 68px bar, ground at 94% with a hairline bottom. Menu items in mute 600 15px, each led by its side letter in gold Bricolage ("A Particuliers", "B Entreprises"); hover to ivory. Under 1080px a 46px square burger (2px corners) opens a full-width sheet of 52px rows.

### The Plaque *(Raphia Kuba signature)*
One object holding both balances. A deep gradient (#211b12 to #0b0a08), 24px corners (20px on phones), a gold-tinted hairline, a faint Kuba cloth engraved in the top-right corner. CDF first in display size, then the seam, then USD smaller. The seam is the Kuba band running edge to edge with the 3px DRC thread under it; it weaves in on load (900ms).

### The Carnet *(Raphia Kuba, history)*
History grouped by day: a day heading in Bricolage 15px gold, then rows showing only the time. A 1px vertical thread links the rounded-square icons of one day (38px, 10px corners): gold for neutral operations, green for credits, amber dashed for pending, red for failed. Amounts in Bricolage 17px, right-aligned and tabular; a pending amount stays mute.

### The Sleeve and Disc *(Home page signature)*
- **Sleeve:** a square of woven panel, padded 7.5% of its width, in three rows: a top line (cities left in gold light, currencies right in mute, 2.8% of the width, min 11px), the stacked sleeve title, and a foot holding the operator chips on ivory (2px corners) and the 5px DRC thread.
- **Disc:** 94% of the sleeve, behind it, drawn entirely in CSS: fine repeating grooves, darker rings at a third and two-thirds, a lip at the edge, and a non-rotating sheen. Its gold label (the middle third) carries "Pay243 / Face A" above the spindle hole and "Particuliers" below, offset toward the part of the disc that is out of the sleeve.
- **Motion:** on load the disc slides from 3% to 56% out of the sleeve (62% in one column) over 1.6s on the expo ease, after 0.25s. On devices that can hover, hovering the tracklist or the side switch spins it at 33⅓ rpm (one turn per 1.8s, linear); it never spins otherwise. Choosing Face B flips the disc 180° over 1.1s while the label text cross-fades (0.3s, after 0.35s). The closing "fin de face" reuses the disc, larger, half off the right edge. All of it is static under `prefers-reduced-motion`.

### Side Switch *(Home page)*
A two-cell segmented control (Face A Particuliers / Face B Entreprises) with a strong hairline and 2px corners; each cell stacks the side letter in Bricolage 13px over the audience in 600 15px. Pressed: raised fill, ivory text, gold letter. It swaps the H1, lead, tracklist and actions, and flips the disc.

### Tracklist *(Home page)*
Ruled rows, opened by a 13px faint head line ("Face A · Frais Pay243") on a strong hairline. Each row: the track number (A1-A4), the gesture, a 2px dotted leader in strong hairline that fills the gap, and the fee in gold Bricolage, tabular, at the end. Fees that are words ("taux affiché", "inclus", "gratuit") drop to Plus Jakarta in gold light so they never read as a number. The tarifs section is the same tracklist without numbers, at 19px with larger fees.

### Side Mark and Plage *(Home page)*
- **Side mark:** a small grooved disc (84-128px) with a gold centre (46%) carrying the side letter in Bricolage 800; it heads each side next to the headline.
- **Plage:** one row per feature: plage number in gold, title and text, and the proof on the right (a receipt, the WhatsApp exchange, or the API example). Rows are divided by strong hairlines.

### Liner-Notes Credits *(Home page)*
Security is set like the credits on the back of an album: two balanced columns with a hairline rule between them, bounded top and bottom by strong hairlines, 15px mute text at 1.6, each note led by its name in gold 700. One column under 560px.

### WhatsApp Bubble *(Home page)*
The depiction of a WhatsApp message: `#1f2a22` fill, corners 2px 12px 12px 12px, sender in ok green 13px 700, link in `#9bd0ff` underlined, time 11px mute right-aligned; max 330px. It is followed by a "paid" receipt aligned to the right.

### API Example *(Home page)*
Raffia-ground block, strong hairline, 2px corners, a 13px faint title bar, then monospace 13px/1.65: comments faint, keywords gold, strings ok green, properties gold light, numbers `#9bd0ff`. The only monospace on the page.

### FAQ *(Home page)*
Native disclosure rows on hairlines, 700 17px questions, the gold plus turning into a cross (0.3s, expo ease), answers in mute up to 62ch.

## Do's and Don'ts

### Do:
- **Do** check which stylesheet a page loads before designing on it: `home.css` means the rumba sleeve, `kuba.css` means Raphia Kuba.
- **Do** set every amount and fee in tabular figures, on both worlds.
- **Do** double every status with a shape and a word (filled dot, empty ring or dashed border, cross on Kuba pages; check or clock on the home page).
- **Do** show operator and card-network logos on an ivory chip so their own colours stay true.
- **Do** keep secondary text at raffia mute (6.6:1) and never below raffia faint (4.9:1).
- **Do** (Raphia Kuba) put the Kuba band and DRC thread at the foot of every panel that shows money held, and nowhere as filler.
- **Do** (Raphia Kuba) make the first action in a row of money verbs solid gold and keep the rest woven panel.
- **Do** (Home page) run every price as a tracklist row: number, gesture, dotted leader, gold tabular fee at the end.
- **Do** (Home page) keep rectangles at 2px and reserve circles for the disc, its label and the side marks.
- **Do** keep every motion off under `prefers-reduced-motion: reduce` (tab slide, band weave, disc slide, spin, flip, button and FAQ transitions), and keep the disc's spin behind `(hover: hover)`.

### Don't:
- **Don't** add glow, gold blur or coloured shadows to cards or buttons; depth is tonal.
- **Don't** introduce vivid colour outside logos, statuses, the DRC thread, and the home page's depicted WhatsApp and code surfaces.
- **Don't** reintroduce the legacy blue gradients, the yellow circle on balances, or uppercase tracked captions.
- **Don't** (Raphia Kuba) draw Kuba motifs with curves or diagonals; they are orthogonal steps.
- **Don't** (Home page) add rounded cards or a second rounded surface beside the WhatsApp bubble.
- **Don't** mix the worlds: no Kuba band, plaque or 16px panels on the home page, no sleeve, disc or tracklist on product pages until they are redesigned.
- **Don't** colour a pending amount green before the money has arrived.
- **Don't** load external fonts or assets; the CSP forbids it and both faces are self-hosted.
