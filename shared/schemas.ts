import { z } from 'zod'

export const ELEVATE_PRESETS = ['sudo -s', 'sudo -i', 'sudo su -', 'custom'] as const

const elevateSchema = z
  .object({
    enabled: z.boolean(),
    preset: z.enum(ELEVATE_PRESETS),
    customCommand: z.string().max(200).default(''),
    passwordMode: z.enum(['same', 'custom']),
    customPassword: z.string().max(128).default('')
  })
  .superRefine((cfg, ctx) => {
    if (!cfg.enabled) return
    if (cfg.preset === 'custom') {
      const cmd = cfg.customCommand.trim()
      if (!/^sudo(\s|$)/.test(cmd) || cmd.trim() === 'sudo') {
        ctx.addIssue({
          code: 'custom',
          path: ['customCommand'],
          message: 'Custom command must start with "sudo" (e.g. sudo -u admin -s)'
        })
      }
      if (cmd.includes(';')) {
        ctx.addIssue({
          code: 'custom',
          path: ['customCommand'],
          message: 'Custom command must not contain ";"'
        })
      }
    }
    if (cfg.passwordMode === 'custom' && !cfg.customPassword) {
      ctx.addIssue({
        code: 'custom',
        path: ['customPassword'],
        message: 'A separate sudo password is required'
      })
    }
  })

/**
 * Form-level schema. In edit mode `password`/`customPassword` may be empty,
 * which means "keep the stored value"; the main process enforces that
 * a secret actually exists before saving.
 */
export const serverFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(64, 'Max 64 characters'),
  host: z.string().trim().min(1, 'Host is required').max(255),
  port: z.coerce.number().int().min(1, 'Invalid port').max(65535, 'Invalid port'),
  username: z.string().trim().min(1, 'Username is required').max(32),
  password: z.string().max(128).default(''),
  tags: z.array(z.string().max(24)).max(12).default([]),
  notes: z.string().max(2000).default(''),
  elevate: elevateSchema
})

export type ServerFormValues = z.infer<typeof serverFormSchema>

const HOSTNAME_OR_IP =
  /^(?=.{1,255}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$|^\[[0-9a-fA-F:]+\]$|^[0-9a-fA-F:]{2,45}$/

export function isValidHost(host: string): boolean {
  return HOSTNAME_OR_IP.test(host.trim())
}

/** Normalize a tag list: trim, drop empties, dedupe (case-insensitive), cap. */
export function normalizeTags(raw: ReadonlyArray<string>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of raw) {
    const v = t.trim()
    if (!v) continue
    const key = v.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
    if (out.length >= 12) break
  }
  return out
}

export const MASTER_PASSWORD_MIN = 10

export function masterPasswordIssues(pw: string): string[] {
  const issues: string[] = []
  if (pw.length < MASTER_PASSWORD_MIN) issues.push(`At least ${MASTER_PASSWORD_MIN} characters`)
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw)) issues.push('Mix upper and lower case')
  if (!/[0-9]/.test(pw)) issues.push('Include a digit')
  return issues
}

/**
 * PTY-safe password generator: printable, unambiguous characters, no leading
 * or trailing whitespace, no control characters, no quotes that fight shells.
 */
const GENERATOR_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#%*+=?-_'

export function generatePassword(length = 20): string {
  const chars: string[] = []
  while (chars.length < length) {
    const n = Math.floor(Math.random() * GENERATOR_ALPHABET.length)
    const c = GENERATOR_ALPHABET[n]
    if (chars.length === 0 && /[^a-zA-Z0-9]/.test(c)) continue
    if (chars.length === length - 1 && /[^a-zA-Z0-9]/.test(c)) continue
    chars.push(c)
  }
  return chars.join('')
}
