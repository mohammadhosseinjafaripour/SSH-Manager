const fs = require('fs')
const p = 'src/renderer/src/components/beui/select.tsx'
let s = fs.readFileSync(p, 'utf8')
// remove the leftover original header (comment block) that followed our imports
s = s.replace(
'import { cn } from "../lib/cn";\n"use client";\n// beui.dev/components/motion/select\n',
'import { cn } from "../lib/cn";\n'
)
fs.writeFileSync(p, s)
console.log('header cleaned')
