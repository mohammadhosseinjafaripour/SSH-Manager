const fs=require('fs')
const p='src/renderer/src/components/beui/input.tsx'
let s=fs.readFileSync(p,'utf8')
// keep the prop in the public API (call sites may pass it) but drop it from
// the destructure; the unused-var rule then passes.
s=s.replace(`    error,
    reserveErrorLine = false,
    success,`, `    error,
    success,`)
fs.writeFileSync(p,s)
console.log('ok')
