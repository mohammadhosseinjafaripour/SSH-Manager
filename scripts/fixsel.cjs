const fs=require('fs')
const p='src/renderer/src/components/ui.tsx'
let s=fs.readFileSync(p,'utf8')
s=s.replace('<BeUISelect value={value} onValueChange={onValueChange}>', '<SelectRoot value={value} onValueChange={onValueChange}>')
s=s.replace('</BeUISelect>', '</SelectRoot>')
s=s.replace('<BeUISelectTrigger ariaLabel={ariaLabel}>', '<SelectTrigger ariaLabel={ariaLabel}>')
s=s.replace('<BeUISelectValue placeholder={options[0]?.label ?? \'Select\'} />', '<SelectValue placeholder={options[0]?.label ?? \'Select\'} />')
s=s.replace('<BeUISelectContent>', '<SelectContent>')
s=s.replace('<BeUISelectItem key={opt.value} value={opt.value}>', '<SelectItem key={opt.value} value={opt.value}>')
s=s.replace('</BeUISelectItem>', '</SelectItem>')
s=s.replace('</BeUISelectContent>', '</SelectContent>')
s=s.replace(
`  Select as BeUISelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue`,
`  Select as SelectRoot,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue`)
fs.writeFileSync(p,s)
console.log('select names aligned')
