const fs=require('fs')
const p='src/renderer/src/components/ui.tsx'
let s=fs.readFileSync(p,'utf8')
s=s.replace('      </BeUISelectTrigger>', '      </SelectTrigger>')
fs.writeFileSync(p,s)
console.log('closing tag fixed')
