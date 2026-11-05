const fs = require('fs')
const base = 'src/renderer/src/components/beui'

// correct cn path: components/beui/* -> ./lib/cn
for (const f of ['button.tsx', 'input.tsx', 'select.tsx']) {
  const p = base + '/' + f
  let s = fs.readFileSync(p, 'utf8')
  s = s.replace('from "../lib/cn"', 'from "./lib/cn"')
  fs.writeFileSync(p, s)
}

// button: add pointer props
let p = base + '/button.tsx'
let s = fs.readFileSync(p, 'utf8')
s = s.replace(
`  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;`,
`  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onPointerDown?: (event: React.PointerEvent<HTMLButtonElement>) => void;`
)
fs.writeFileSync(p, s)

// select: ensure SelectTriggerProps carries ariaLabel
p = base + '/select.tsx'
s = fs.readFileSync(p, 'utf8')
if (!s.includes('ariaLabel?: string')) {
  s = s.replace(
`export interface SelectTriggerProps {
  className: string;`,
`export interface SelectTriggerProps {
  className: string;
  ariaLabel?: string;`
  )
}
if (!s.includes('ariaLabel }: SelectTriggerProps') && !s.includes(', ariaLabel }:')) {
  s = s.replace(
`export function SelectTrigger({ className, children }: SelectTriggerProps) {`,
`export function SelectTrigger({ className, children, ariaLabel }: SelectTriggerProps) {`
  )
}
fs.writeFileSync(p, s)
console.log('paths + props fixed')
