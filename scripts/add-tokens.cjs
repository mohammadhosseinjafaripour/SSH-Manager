const fs=require('fs')
const p='src/renderer/src/styles.css'
let s=fs.readFileSync(p,'utf8')
if (!s.includes('--color-muted-foreground')) {
  s=s.replace(
`@theme inline {
  --color-bg: var(--bg);`,
`@theme inline {
  --color-bg: var(--bg);
  /* shadcn-style aliases: vendored beUI components use these token names. */
  --color-background: var(--bg);
  --color-foreground: var(--fg);
  --color-muted-foreground: var(--muted);
  --color-ring: var(--accent);`)
  fs.writeFileSync(p,s)
  console.log('shadcn token aliases added')
} else console.log('already present')
