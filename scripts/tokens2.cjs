const fs=require('fs')
const p='src/renderer/src/styles.css'
let s=fs.readFileSync(p,'utf8')
if (!s.includes('--color-primary')) {
  s=s.replace(
`  --color-ring: var(--accent);`,
`  --color-ring: var(--accent);
  /* beUI component tokens */
  --color-primary: var(--accent);
  --color-primary-foreground: var(--accent-fg);
  --color-border: var(--line);
  --color-border-strong: var(--muted);
  --color-card: var(--panel);
  --color-destructive: var(--danger);
  --color-success: var(--ok);`)
  fs.writeFileSync(p,s)
  console.log('tokens added')
} else console.log('already present')
