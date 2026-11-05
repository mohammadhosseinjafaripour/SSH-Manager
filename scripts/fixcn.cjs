const fs = require('fs')
for (const f of ['button.tsx', 'input.tsx', 'select.tsx']) {
  const p = 'src/renderer/src/components/beui/' + f
  let s = fs.readFileSync(p, 'utf8')
  s = s.replace('from "./lib/cn"', 'from "../../lib/cn"')
  fs.writeFileSync(p, s)
}
console.log('cn paths corrected to ../../lib/cn')
