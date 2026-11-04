import { forwardRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown, Eye, EyeOff, Loader2, X } from 'lucide-react'
import { generatePassword } from '@shared/schemas'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md'

const buttonBase =
  'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors duration-150 disabled:opacity-50 disabled:pointer-events-none select-none'

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-strong',
  secondary: 'bg-panel-2 text-fg border border-line hover:border-accent/60 hover:text-accent',
  ghost: 'text-muted hover:text-fg hover:bg-panel-2',
  danger: 'bg-danger text-white hover:opacity-90'
}

const buttonSizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-10 px-4 text-sm'
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, className = '', children, disabled, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`${buttonBase} ${buttonVariants[variant]} ${buttonSizes[size]} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Loader2 size={15} className="animate-spin" />}
      {children}
    </button>
  )
})

/**
 * Defaults to type="button": an icon button inside a <form> would otherwise
 * default to type="submit" and submit the form (e.g. the password reveal
 * toggle closing the dialog).
 */
export function IconButton({
  label,
  className = '',
  children,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-panel-2 hover:text-fg ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ className = '', invalid, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={`h-10 w-full rounded-lg border bg-inset px-3 text-sm text-fg placeholder:text-faint transition-colors duration-150 ${
          invalid ? 'border-danger' : 'border-line focus:border-accent'
        } ${className}`}
        {...rest}
      />
    )
  }
)

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
          className={`content-in fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] ${width} max-h-[85vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-line bg-panel p-6 shadow-2xl`}
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

export function Switch({
  checked,
  onCheckedChange,
  label
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label: string
}) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={label}
      className="relative h-[22px] w-[38px] rounded-full border border-line bg-inset transition-colors duration-150 data-[state=checked]:border-accent data-[state=checked]:bg-accent"
    >
      <SwitchPrimitive.Thumb className="block h-[16px] w-[16px] translate-x-[3px] rounded-full bg-muted transition-transform duration-150 data-[state=checked]:translate-x-[19px] data-[state=checked]:bg-accent-fg" />
    </SwitchPrimitive.Root>
  )
}

export interface SelectOption {
  value: string
  label: string
}

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
    <SelectPrimitive.Root value={value} onValueChange={onValueChange}>
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        className="flex h-10 w-full items-center justify-between rounded-lg border border-line bg-inset px-3 text-sm text-fg transition-colors duration-150 hover:border-accent/60 data-[placeholder]:text-faint"
      >
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon>
          <ChevronDown size={15} className="text-muted" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          className="z-50 max-h-72 overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-xl"
        >
          <SelectPrimitive.Viewport>
            {options.map((opt) => (
              <SelectPrimitive.Item
                key={opt.value}
                value={opt.value}
                className="flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-sm text-fg outline-none data-[highlighted]:bg-panel-2 data-[highlighted]:text-accent"
              >
                <SelectPrimitive.ItemText>{opt.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator>
                  <Check size={14} className="text-accent" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
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
