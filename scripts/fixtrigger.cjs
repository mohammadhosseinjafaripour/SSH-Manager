const fs = require('fs')
const p = 'src/renderer/src/components/beui/select.tsx'
let s = fs.readFileSync(p, 'utf8')
s = s.replace(
`export interface SelectTriggerProps {
  className?: string;
  children: ReactNode;
}`,
`export interface SelectTriggerProps {
  className?: string;
  children: ReactNode;
  ariaLabel?: string;
}`
)
fs.writeFileSync(p, s)
console.log('ariaLabel added to interface')
