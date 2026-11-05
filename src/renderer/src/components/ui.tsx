import { forwardRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Eye, EyeOff, Loader2, X } from 'lucide-react'
import { generatePassword } from '@shared/schemas'
import { Switch as BeUISwitch } from './beui/Switch'
import { BeUIButton } from './beui/button'
import { BeUIInput } from './beui/input'
import {
  Select as SelectRoot,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from './beui/select'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  loading?: boolean
}

/**
 * beUI button wrapper. Keeps the app's API (danger variant, sm/md sizing,
 * loading spinner) while the interaction physics — press scale, hover lift,
 * optional ripple — come from beUI.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading,
    className = '',
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref
) {
  return (
    <BeUIButton
      ref={ref}
      variant={variant}
      size={size}
      loading={loading}
      type={type}
      disabled={disabled}
      className={className}
      {...rest}
    >
      {children}
    </BeUIButton>
  )
})

/**
 * beUI icon button (size="icon"). Defaults to type="button": an icon button
 * inside a <form> would otherwise default to type="submit" and submit the
 * form (e.g. the password reveal toggle closing the dialog).
 */
export function IconButton({
  label,
  className = '',
  children,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <BeUIButton
      type={type}
      size="icon"
      variant="ghost"
      aria-label={label}
      title={label}
      className={`text-muted hover:bg-panel-2 hover:text-fg ${className}`}
      {...rest}
    >
      {children}
    </BeUIButton>
  )
}

/**
 * beUI input wrapper. `invalid` maps to beUI's error state (red border + shake
 * on appearance); messages stay at the call site via the Field component so
 * nothing shifts layout inside the pill.
 */
export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(function Input({ className = '', invalid, ...rest }, ref) {
  return (
    <BeUIInput
      ref={ref}
      error={invalid || undefined}
      className={className}
      {...(rest as Partial<import('./beui/input').BeUIInputProps>)}
    />
  )
})

export function PasswordInput({
  value,
  onChange,
  placeholder,
  invalid,
  withGenerator = false,
  autoComplete = 'new-password'
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  invalid?: boolean
  withGenerator?: boolean
  autoComplete?: string
}) {
  const [reveal, setReveal] = useState(false)
  return (
    <div className="relative">
      <Input
        type={reveal ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        invalid={invalid}
        autoComplete={autoComplete}
        className={withGenerator ? 'pr-24' : 'pr-10'}
      />
      <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
        {withGenerator && (
          <button
            type="button"
            onClick={() => onChange(generatePassword())}
            title="Generate a strong password"
            aria-label="Generate a strong password"
            className="flex h-7 items-center rounded-md px-2 text-[12px] font-medium text-muted transition-colors duration-150 hover:bg-panel-2 hover:text-accent"
          >
            Generate
          </button>
        )}
        <IconButton
          label={reveal ? 'Hide password' : 'Show password'}
          className="h-7 w-7"
          onClick={() => setReveal((r) => !r)}
        >
          {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
        </IconButton>
      </div>
    </div>
  )
}

export function Field({
  label,
  error,
  hint,
  children,
  htmlFor
}: {
  label: string
  error?: string
  hint?: ReactNode
  children: ReactNode
  htmlFor?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-fg">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-[12px] text-danger">{error}</p>
      ) : hint ? (
        <p className="text-[12px] text-faint">{hint}</p>
      ) : null}
    </div>
  )
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  width = 'max-w-md'
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Optional — when omitted the caller renders its own Title/Description. */
  title?: string
  description?: string
  children: ReactNode
  width?: string
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="overlay-in fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          className={`content-in fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] ${width} max-h-[85vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[28px] border border-line bg-panel p-6 shadow-2xl`}
        >
          {title ? (
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <DialogPrimitive.Title className="text-base font-semibold text-fg">{title}</DialogPrimitive.Title>
                {description && (
                  <DialogPrimitive.Description className="mt-1 text-[13px] leading-relaxed text-muted">
                    {description}
                  </DialogPrimitive.Description>
                )}
              </div>
              <DialogPrimitive.Close asChild>
                <IconButton label="Close dialog">
                  <X size={16} />
                </IconButton>
              </DialogPrimitive.Close>
            </div>
          ) : (
            <DialogPrimitive.Close asChild>
              <IconButton label="Close dialog" className="absolute right-4 top-4">
                <X size={16} />
              </IconButton>
            </DialogPrimitive.Close>
          )}
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

// Compound parts for dialogs that render their own rich headers.
Dialog.Title = DialogPrimitive.Title
Dialog.Description = DialogPrimitive.Description

/**
 * Re-export of the vendored beUI switch (see components/beui/Switch.tsx).
 *
 * Fully prop-driven: the visual state derives only from `checked`, so it can
 * never desync from the persisted setting the way the Radix internal state
 * did (the reported "toggle flips but never sticks" bug). API-compatible
 * with the previous component, so call sites are unchanged.
 */
export function Switch(props: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label?: string
  disabled?: boolean
  className?: string
}) {
  // `label` maps to aria-label only: call sites render their own visible row
  // text, and beUI would otherwise paint the label next to the toggle again.
  return <BeUISwitch {...props} label={undefined} ariaLabel={props.label} />
}

export interface SelectOption {
  value: string
  label: string
}

/**
 * beUI select wrapper. Maps the app's options API onto beUI's compound
 * select; the options panel renders inline and flips above/below the trigger
 * based on viewport room.
 */
export function Select({
  value,
  onValueChange,
  options,
  ariaLabel
}: {
  value: string
  onValueChange: (value: string) => void
  options: ReadonlyArray<SelectOption>
  ariaLabel: string
}) {
  return (
    <SelectRoot value={value} onValueChange={onValueChange}>
      <SelectTrigger ariaLabel={ariaLabel}>
        <SelectValue placeholder={options[0]?.label ?? 'Select'} />
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  )
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 size={size} className="animate-spin text-accent" />
}

export function StatusDot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span
      className="inline-block h-[7px] w-[7px] shrink-0 rounded-full"
      style={{ background: color, animation: pulse ? 'pulse-dot 1.6s ease-in-out infinite' : undefined }}
    />
  )
}

export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md border border-line-soft bg-panel-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">
      {children}
    </span>
  )
}
