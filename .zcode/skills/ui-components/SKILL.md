---
name: ui-components
description: Vendor and migrate UI components in SSH Vault from the beUI (beui.dev) and uiarc (uiarc.dev) shadcn-style registries. Use whenever adding a new UI primitive, restyling existing screens, replacing raw <button>/<input>/<select>/<checkbox> markup, or when the user asks to change the look of the app or adopt a component library.
---

# UI Components (beUI + uiarc)

SSH Vault does not install a component package. Components are **copied into
the repo** and adapted in place, so every pixel is auditable and nothing
breaks when a registry updates. This skill is the repeatable procedure.

## Ground rules

1. **Never hand-roll a control that the registry already ships.** If you are
   about to write `<button`, `<input`, `<select`, `<input type="checkbox">`
   or `<input type="radio">`, stop and import from `components/ui.tsx`.
2. **Call sites keep using `components/ui.tsx`.** Wrappers preserve the app's
   existing props (`variant`, `size`, `label`, `invalid`). A migration must not
   change 11 files' worth of call-site arguments.
3. **Theme tokens only.** Components must reference the app's CSS variables
   (`--fg`, `--accent`, `--panel`…), never hard-coded colors. `styles.css`
   already exposes shadcn-style aliases under `@theme inline` for exactly this.
4. **Motion respects reduced motion.** Every `motion` animation is gated on
   `useReducedMotion()`.
5. **Adaptations are documented in a header comment** on each vendored file:
   what the source was, and what you changed.

## Registry endpoints

Both sites are shadcn-compatible registries. Fetch the raw JSON, read the
`content` field of each `files[]` entry — that is the source.

| Library | URL | Namespace | Notes |
| --- | --- | --- | --- |
| beUI | `https://beui.dev/r/<name>.json` | `@beui/<name>` | React 19 + Tailwind 4 + Motion . **No dialog/toast/textarea/badge** |
| uiarc | `https://uiarc.dev/r/<name>.json` | `@uiarc/<name>` | 240 components, Radix-based. **No `uiarc/` prefix in the URL** |

```bash
# Probe availability before committing to an approach (404 = not shipped)
for c in dialog tabs tooltip checkbox radio card modal; do
  printf '%s: ' "$c"
  curl -s -o /dev/null -w '%{http_code}\n' "https://beui.dev/r/$c.json"
done
```

### What each library actually provides

**beUI** (no dialog — this is why uiarc exists in this project):
`button` (Button, StatefulButton, MagneticButton, MetallicButton), `input`,
`select`, `switch`, `tabs`, `tooltip`, `checkbox`, `radio`, `card`,
`morphing-modal` (standalone focus-trapped modal, *not* a Radix dialog),
`bottom-sheet`, `drawer`, `command-palette`, `otp-input`, `range-slider`,
`accordion`, `toast` (**404** — not available).

**uiarc** is used for the pieces beUI lacks, currently just `dialog`. It needs
`arc-motion-tokens` (a registry dependency) plus CSS Modules.

## Procedure

### 1. Fetch

```bash
TMP=/c/Users/Administrator/AppData/Local/Temp/sshvault-ui
mkdir -p "$TMP" && cd "$TMP"
curl -s -O "https://beui.dev/r/tabs.json"
curl -s -O "https://uiarc.dev/r/dialog.json"
curl -s -O "https://uiarc.dev/r/arc-motion-tokens.json"   # if uiarc
```

Registry deps declared in `registryDependencies` / `dependencies` must be
fetched too. Check them before vendoring:

```bash
python -I -c "
import json,io,glob
for p in sorted(glob.glob('*.json')):
    d=json.load(io.open(p,encoding='utf-8'))
    print(p,'deps=',d.get('dependencies'),'regdeps=',d.get('registryDependencies'))
"
```

### 2. Vendor

Copy each `files[].content` to the **target path**, mapped onto this repo:

| Registry target | Repo path |
| --- | --- |
| `@components/motion/button.tsx` | `src/renderer/src/components/beui/button.tsx` |
| `@components/motion/tabs.tsx` | `src/renderer/src/components/beui/tabs.tsx` |
| `@lib/ease.ts` | `src/renderer/src/components/beui/lib/ease.ts` |
| `@lib/utils.ts` | *(do not vendor — use `src/renderer/src/lib/cn.ts`)* |
| `@components/arc/dialog.tsx` | `src/renderer/src/components/beui/dialog.tsx` |
| `@components/arc/lib/motion-tokens.ts` | `src/renderer/src/components/beui/lib/motion-tokens.ts` |
| `@components/arc/*.module.css` | colocated beside the `.tsx` |

### 3. Rewrite imports

The registries use path aliases this project does not have. Always rewrite:

| From | To |
| --- | --- |
| `@/lib/utils` | `../../lib/cn` (or `../lib/cn` from `beui/lib`) |
| `@/lib/ease` | `./lib/ease` (or `./ease` from inside `lib`) |
| `@/lib/hooks/<x>` | `./lib/<x>` |
| `../lib/motion-tokens` | `./lib/motion-tokens` (from `beui/`) |

Add to the file header:

```tsx
"use client";
// Vendored from beUI (https://beui.dev) — MIT license — components/motion/tabs
// Adapted: <exactly what you changed and why>
```

`"use client"` is inert in this Electron renderer but kept for upstream parity.

### 4. Adapt to the app's API

- **Variants**: map the registry's variant names onto ours
  (`primary | secondary | ghost | outline | danger`). Add app-specific
  variants (`danger`) rather than making call sites pass raw classes.
- **Props the app relies on**: keep them (`type`, `aria-label`, `title`,
  `loading`, `invalid`). `react-hook-form`'s `register()` requires a standard
  `onChange(event)` signature — this is why the vendored `BeUIInput` keeps
  `onChange` as the React event and adds beUI's `onValueChange` beside it.
- **Sizes**: our app's scale is `sm | md | lg | icon` with compact heights
  (`h-8`, `h-9`, `h-10`). Dense desktop UI is not the registry's default.
- **A `<button>` inside a `<form>` defaults to `type="submit"`** — any wrapper
  that renders a button must default `type="button"` and pass an explicit
  `type` through, or it will submit forms (the password-reveal toggle once
  closed its own dialog this way).

### 5. Export from `components/ui.tsx`

Wrappers live in `src/renderer/src/components/ui.tsx`. Existing exports:

`Button`, `IconButton`, `Input`, `PasswordInput`, `Field`, `Dialog`,
`Switch`, `Select`, `Spinner`, `StatusDot`, `Tag`.

Add new ones here so screens have a single import site. Do not import
`components/beui/*` directly from a screen.

### 6. Verify

```bash
npm run typecheck && npm run test && npm run lint
grep -rn "<button\|<input\|<select" src/renderer/src --include=*.tsx   # must be empty outside beui/
```

Then run the app (`npm run dev`) and check both themes and reduced-motion.

## Theme contract

`src/renderer/src/styles.css` owns the palette. Two layers:

```css
:root { --bg: #0a0d12; --panel: #10151d; --fg: #e8edf4; --accent: #2dd4bf; … }

@theme inline {
  --color-background: var(--bg);       /* shadcn alias  */
  --color-foreground: var(--fg);
  --color-muted-foreground: var(--muted);
  --color-ring: var(--accent);
  --color-primary: var(--accent);      /* beUI/shadcn   */
  --color-border: var(--line);
  --color-card: var(--panel);
  --color-destructive: var(--danger);
}
```

When a vendored component references a token that does not exist yet, add the
alias in `@theme inline` — **never** fork the component's colors.

> Trap: our palette defines `--color-muted` (a text/muted *color*). shadcn's
> `bg-muted` is a *surface*. Vendored components using `bg-muted` must be
> mapped to `bg-panel-2` or similar, otherwise they inherit a text color as a
> background.

## uiarc specifics (CSS Modules)

uiarc ships plain `.module.css`, and it depends on CSS variables the registry
does not create. When vendoring a uiarc component:

1. Keep the `.module.css` file colocated, unchanged except for token renames.
2. Add the variables it needs to `styles.css` (`--space-6`, `--radius-surface`,
   `--shadow-floating`, `--surface-raised`, `--text-lg`, `--duration-fast`,
   `--ease-enter`, `--ease-standard`, `--ease-spring`…). Vite supports CSS
   Modules out of the box — no config change is required.
3. Vendor `arc-motion-tokens.json`'s `motion-tokens.ts` to
   `components/beui/lib/motion-tokens.ts` and point the import at it.
4. uiarc's `Dialog` is Radix + `motion` and takes `title` / `description`
   props, rendering its own header and close button. Call sites that render
   their own `<Dialog.Title>` use the compound exports
   (`Dialog.Title`, `Dialog.Description`), which must keep working.

### Gotcha: unitless custom properties invalidate `min()`/`calc()`

Passing a unitless number as a custom property silently breaks the rule that
consumes it:

```tsx
style={{ '--dialog-width': 384 }}          // ✗ width becomes `min(..., 384)` → invalid
style={{ '--dialog-width': '384px' }}      // ✓
```

An invalid `width` on an element with `inset: 0` is dropped, so the element
stretches to the full viewport instead of erroring visibly. TypeScript cannot
catch this (`CSSProperties` allows any string), and the DOM snapshot looks
correct — only measuring `getBoundingClientRect()` or a screenshot reveals it.

**Always verify a vendored layout component by measuring it in a browser**, not
just by confirming it renders:

```js
const r = document.querySelector('[role="dialog"]').getBoundingClientRect()
// expect ~384 wide, not 1280
```

### Gotcha: `className` styles the field wrapper, not the `<input>`

beUI's `Input` puts `className` on the **root container** and `classNames.field`
on the bordered box, `classNames.input` on the inner `<input>`. Passing padding
to `className` shrinks the whole field instead of reserving space inside it:

```tsx
<Input className="pr-16" />                    // ✗ field narrower than its column
<Input classNames={{ input: 'pr-16' }} />      // ✓ text stops before the overlay
```

This bit twice: a search box rendered 384px inside a 448px slot (the shortcut
hint floated outside), and `PasswordInput` was 474px wide beside 514px
siblings in the same form. Both looked fine in a DOM snapshot.

**Rule:** sizing/typography that belongs to the text goes in `classNames.input`;
the border, background and radius belong in `classNames.field`; layout of the
whole control goes in `className`.

### Verify behavior, not just rendering

A DOM snapshot proves a control *exists*. It does not prove it *works*. After
migrating a control, drive it and assert the effect:

| Control | Assert |
| --- | --- |
| search input | typing filters the list |
| icon button | the action fires (clear resets the query) |
| switch / checkbox | `aria-checked` flips **and** the gated button enables |
| password reveal | `input.type` flips `password`→`text`, value kept, **dialog still open** |
| theme buttons | `documentElement[data-theme]` actually changes |

The password-reveal case is the one that historically broke: a `<button>` with
no `type` inside a `<form>` defaults to `submit` and closes the dialog.

### Gotcha: exit animation keeps the dialog mounted

The vendored dialog stays in the DOM after closing (`data-state="closed"`,
`opacity: 0`, overlay `pointer-events: none`). That is correct — it enables the
exit animation. Verify closure by checking that clicks reach the page behind it
(`document.elementFromPoint()`), not by asserting `querySelector('[role="dialog"]')`
is null.

### Gotcha: a floating close button overlaps a caller-rendered title

uiarc's dialog always draws its own header — title, description and a close
button sitting *in* that header. Call sites here also render rich headers
themselves (`<Dialog.Title>` with an icon, a filename, a fingerprint). When
`title` is omitted the body renders with a *floating* close button in the
corner, which lands on top of whatever the caller put there.

Reserve the corner instead of moving the button:

```css
.bodyWithFloatingClose { padding-top: 56px; }  /* 24px pad + 32px button */
```

Measure it — a 24px vertical overlap is invisible in a snapshot:

```js
const close = dlg.querySelector('button[aria-label="Close dialog"]').getBoundingClientRect()
const title = dlg.querySelector('h2').getBoundingClientRect()
// overlapY must be <= 0
```

## Do not

- Do not `npm install` a component library to get these components.
- Do not edit `node_modules` or add a registry CLI dependency.
- Do not change `electron.vite.config.ts` for CSS Modules — Vite has them.
- Do not migrate a control whose registry equivalent cannot express the
  existing behavior (e.g. terminal tab chips carrying a status dot and a
  close affordance). Keep it, restyle it to match, and note why.
