const fs = require('fs')

// Select body: beUI's compound select with imports re-pointed at our vendored
// lib files. The trigger also gains an aria-label passthrough.
let body = fs.readFileSync('.beui-src/select.tsx', 'utf8')

// strip original imports
const firstImport = body.indexOf('import ')
const lastImportEnd = body.indexOf('from "@/lib/utils";')
body = body.slice(0, firstImport) + body.slice(lastImportEnd + 'from "@/lib/utils";'.length)

const header = [
'"use client";',
'// Vendored from beUI (https://beui.dev) — MIT license — components/motion/select',
'// Imports re-pointed at our vendored lib files; trigger gains an aria-label',
'// passthrough used by the app wrapper.',
'',
'import { Check, ChevronDown } from "lucide-react";',
'import {',
'  animate,',
'  type MotionValue,',
'  motion,',
'  useMotionValue,',
'  useMotionValueEvent,',
'  useReducedMotion,',
'  useTransform,',
'  type Variants,',
'} from "motion/react";',
'import {',
'  createContext,',
'  type ReactNode,',
'  useCallback,',
'  useContext,',
'  useEffect,',
'  useId,',
'  useLayoutEffect,',
'  useMemo,',
'  useRef,',
'  useState,',
'} from "react";',
'import { EASE_OUT } from "./lib/ease";',
'import { type ListboxRow, useListbox } from "./lib/use-listbox";',
'import { cn } from "../lib/cn";',
''
].join('\n')

// aria-label on trigger
body = body.replace(
`export interface SelectTriggerProps {
  className: string;
  children: ReactNode;
}`,
`export interface SelectTriggerProps {
  className: string;
  children: ReactNode;
  ariaLabel?: string;
}`
)
body = body.replace(
`export function SelectTrigger({ className, children }: SelectTriggerProps) {`,
`export function SelectTrigger({ className, children, ariaLabel }: SelectTriggerProps) {`
)
body = body.replace(
`    <motion.button
      type="button"
      id={ctx.triggerId}
      disabled={ctx.disabled}
      aria-haspopup="listbox"`,
`    <motion.button
      type="button"
      id={ctx.triggerId}
      disabled={ctx.disabled}
      aria-label={ariaLabel}
      aria-haspopup="listbox"`
)

fs.writeFileSync('src/renderer/src/components/beui/select.tsx', header + body)
fs.writeFileSync('src/renderer/src/components/beui/lib/use-listbox.ts', fs.readFileSync('.beui-src/use-listbox.ts', 'utf8'))
fs.writeFileSync('src/renderer/src/components/beui/lib/use-on-open.ts', fs.readFileSync('.beui-src/use-on-open.ts', 'utf8'))
fs.writeFileSync('src/renderer/src/components/beui/lib/use-row-cursor.ts', fs.readFileSync('.beui-src/use-row-cursor.ts', 'utf8'))
console.log('select vendored')
