const fs = require('fs')
const path = require('path')
const dir = 'src/renderer/src/components/beui'
const files = ['button.tsx', 'input.tsx', 'select.tsx', 'lib/use-listbox.ts']
for (const f of files) {
  const p = path.join(dir, f)
  let s = fs.readFileSync(p, 'utf8')
  // cn: from components/beui/*.tsx -> ../lib/cn ; from components/beui/lib/* -> ../../lib/cn
  s = s.replace(/from "@\/lib\/utils"/g, f.startsWith('lib/') ? 'from "../../lib/cn"' : 'from "../lib/cn"')
  s = s.replace(/from "@\/lib\/hooks\/use-on-open"/g, 'from "./use-on-open"')
  s = s.replace(/from "@\/lib\/hooks\/use-row-cursor"/g, 'from "./use-row-cursor"')
  fs.writeFileSync(p, s)
}
// add missing props to BeUIButtonProps
p = 'src/renderer/src/components/beui/button.tsx'
s = fs.readFileSync(p, 'utf8')
s = s.replace(
`  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  "aria-label"?: string;
  title?: string;`,
`  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onBlur?: (event: React.FocusEvent<HTMLButtonElement>) => void;
  "aria-label"?: string;
  "aria-expanded"?: boolean;
  "aria-haspopup"?: string;
  title?: string;`
)
// drop unused AnimatePresence import in input
p = 'src/renderer/src/components/beui/input.tsx'
s = fs.readFileSync(p, 'utf8')
s = s.replace('import { AnimatePresence, animate, motion, useReducedMotion } from "motion/react";', 'import { animate, motion, useReducedMotion } from "motion/react";')
fs.writeFileSync(p, s)
console.log('imports fixed')
