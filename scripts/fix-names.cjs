const fs=require('fs')

// ui.tsx: use beUI's actual export names + drop unused icons
let p='src/renderer/src/components/ui.tsx'
let s=fs.readFileSync(p,'utf8')
s=s.replace(
`import { Check, ChevronDown, Eye, EyeOff, Loader2, X } from 'lucide-react'`,
`import { Eye, EyeOff, Loader2, X } from 'lucide-react'`)
s=s.replace(
`import {
  BeUISelect,
  BeUISelectContent,
  BeUISelectItem,
  BeUISelectTrigger,
  BeUISelectValue
} from './beui/select'`,
`import {
  Select as BeUISelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from './beui/select'`)
fs.writeFileSync(p,s)

// ToggleRow passes className to Switch wrapper — expose it
p='src/renderer/src/components/ui.tsx'
s=fs.readFileSync(p,'utf8')
s=s.replace(
`export function Switch(props: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label?: string
  disabled?: boolean
}) {`,
`export function Switch(props: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label?: string
  disabled?: boolean
  className?: string
}) {`)
fs.writeFileSync(p,s)

// select.tsx trigger interface: match exact text in vendored file
p='src/renderer/src/components/beui/select.tsx'
s=fs.readFileSync(p,'utf8')
s=s.replace(
`export interface SelectTriggerProps {
  className?: string;
  children: ReactNode;
}`,
`export interface SelectTriggerProps {
  className?: string;
  children: ReactNode;
  ariaLabel?: string;
}`)
s=s.replace(
`export function SelectTrigger({ className, children }: SelectTriggerProps) {`,
`export function SelectTrigger({ className, children, ariaLabel }: SelectTriggerProps) {`)
fs.writeFileSync(p,s)
console.log('names fixed')
