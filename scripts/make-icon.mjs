/**
 * Generates the SSH Vault application icon from a hand-built SVG:
 *   - dark rounded-square tile (the app's terminal background)
 *   - inset terminal panel with a teal frame
 *   - a bold ">_" prompt (vector paths — no fonts) in the brand teal
 * Rasterized per-size from the SVG (crisper than downscaling). The Windows
 * .ico for the exe/installer is derived by electron-builder from
 * build/icon.png — do not hand-pack one: NSIS rejects all-PNG .ico files.
 *
 *   node scripts/make-icon.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'

const TILE = '#0c111a'
const PANEL = '#101826'
const PANEL_EDGE = '#1f2835'
const ACCENT = '#2dd4bf'

// 1024×1024 canvas; everything scales from here.
// `simple` drops the window dots and panel border and enlarges the prompt —
// the variant used for 16–32px renders where those details turn to noise.
function iconSvg(simple) {
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#131b27"/>
      <stop offset="1" stop-color="${TILE}"/>
    </linearGradient>
    <linearGradient id="panel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#15202f"/>
      <stop offset="1" stop-color="${PANEL}"/>
    </linearGradient>
  </defs>

  <!-- rounded tile -->
  <rect x="8" y="8" width="1008" height="1008" rx="224" fill="url(#tile)"/>
  <rect x="8" y="8" width="1008" height="1008" rx="224" fill="none" stroke="#26313f" stroke-width="8"/>

  <!-- terminal panel -->
  <rect x="152" y="232" width="720" height="560" rx="72" fill="url(#panel)"/>
  ${simple ? '' : `<rect x="152" y="232" width="720" height="560" rx="72" fill="none" stroke="${PANEL_EDGE}" stroke-width="10"/>`}

  ${simple ? '' : `
  <!-- window dots -->
  <circle cx="236" cy="316" r="20" fill="rgb(248 113 113 / 0.55)"/>
  <circle cx="310" cy="316" r="20" fill="rgb(251 191 36 / 0.55)"/>
  <circle cx="384" cy="316" r="20" fill="rgb(52 211 153 / 0.55)"/>
  `}

  <!-- prompt: ">" chevron (nudged up for optical balance) -->
  <path d="M ${simple ? 286 : 300} ${simple ? 412 : 420} L ${simple ? 456 : 470} ${simple ? 548 : 552} L ${simple ? 286 : 300} ${simple ? 684 : 684}"
        fill="none" stroke="${ACCENT}" stroke-width="${simple ? 104 : 84}"
        stroke-linecap="round" stroke-linejoin="round"/>

  <!-- prompt: "_" cursor, flat ends -->
  <rect x="${simple ? 544 : 548}" y="${simple ? 608 : 612}" width="${simple ? 212 : 200}" height="${simple ? 84 : 76}" rx="10" fill="${ACCENT}"/>
</svg>
`
}

const svg = iconSvg(false)

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

mkdirSync('build', { recursive: true })
writeFileSync('build/icon.svg', svg)

const pngPaths = []
for (const size of SIZES) {
  const out = `build/icon-${size}.png`
  await sharp(Buffer.from(iconSvg(size <= 32)))
    .resize(size, size, { kernel: 'lanczos3' })
    .png()
    .toFile(out)
  pngPaths.push(out)
}

// electron-builder picks this up and derives the Windows .ico from it.
await sharp(Buffer.from(iconSvg(false))).resize(512, 512).png().toFile('build/icon.png')

// README logo
await sharp(Buffer.from(iconSvg(false))).resize(128, 128).png().toFile('docs/screenshots/icon.png')

console.log('icons written: build/icon.png (+', SIZES.length, 'size variants )')
