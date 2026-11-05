const fs=require('fs')
const p='src/renderer/src/components/ui.tsx'
let s=fs.readFileSync(p,'utf8')
s=s.replace(
`    <BeUIInput
      ref={ref}
      error={invalid || undefined}
      className={className}
      {...rest}
    />`,
`    <BeUIInput
      ref={ref}
      error={invalid || undefined}
      className={className}
      {...(rest as Partial<import('./beui/input').BeUIInputProps>)}
    />`)
fs.writeFileSync(p,s)
console.log('input cast applied')
