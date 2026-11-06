import {
  forwardRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode
} from 'react'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Switch as BeUISwitch } from './beui/Switch'
import { Checkbox as BeUICheckbox } from './beui/checkbox'
import { BeUIButton } from './beui/button'
import { BeUIInput, type BeUIInputProps } from './beui/input'
import {
  Dialog as BeUIDialog,
  DialogContent as BeUIDialogContent
} from './beui/dialog'
import {
  Select as SelectRoot,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from './beui/select'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger'
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
 * nothing shifts layout inside the pill. beUI's own extras (leftIcon,
 * rightIcon, success) are passed through.
 */
export const Input = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'value' | 'defaultValue'> &
    Pick<BeUIInputProps, 'leftIcon' | 'rightIcon' | 'success' | 'classNames'> & {
      invalid?: boolean
      /** beUI inputs are string-controlled; number fields pass a number here. */
      value?: string | number
      defaultValue?: string | number
    }
>(function Input({ className = '', invalid, value, defaultValue, ...rest }, ref) {
  return (
    <BeUIInput
      ref={ref}
      error={invalid || undefined}
      className={className}
      // beUI types these as string; native inputs allow numbers (e.g. the
      // idle-lock minutes field), so coerce at the boundary.
      value={value === undefined ? undefined : String(value)}
      defaultValue={defaultValue === undefined ? undefined : String(defaultValue)}
      {...rest}
    />
  )
})

export function PasswordInput({
  value,
  onChange,
  placeholder,
  invalid,
  autoComplete = 'new-password'
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  invalid?: boolean
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
        // Padding must land on the inner <input>, not the wrapper: beUI's
        // `className` styles the field container, so `pr-10` there narrows the
        // whole field instead of reserving room for the reveal button.
        classNames={{ input: 'pr-10' }}
      />
      <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
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

/**
 * Vendored uiarc dialog (see components/beui/dialog.tsx).
 *
 * Call sites keep the app's original props: `open`/`onOpenChange`, an optional
 * `title`/`description` pair, and a Tailwind `width` class. Width is translated
 * into the CSS-module's `--dialog-width` custom property.
 *
 * With `title` omitted, dialogs render their own <Dialog.Title> markup; those
 * get the floating close button instead of the built-in header.
 */
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
    <BeUIDialog open={open} onOpenChange={onOpenChange}>
      <BeUIDialogContent
        title={title}
        description={description}
        style={{ '--dialog-width': `${WIDTH_PX[width] ?? 440}px` } as CSSProperties}
      >
        {children}
      </BeUIDialogContent>
    </BeUIDialog>
  )
}

/** Call sites pass a Tailwind max-width class; the module needs real pixels. */
const WIDTH_PX: Record<string, number> = {
  'max-w-sm': 384,
  'max-w-md': 448,
  'max-w-lg': 512,
  'max-w-xl': 576
}

/** Compound parts for dialogs that render their own rich headers. */
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

/**
 * Vendored beUI checkbox (see components/beui/checkbox.tsx). The label and
 * description are rendered by beUI, so call sites that need a custom row
 * layout pass neither and place the control themselves.
 */
export function Checkbox({
  checked,
  onCheckedChange,
  disabled,
  label,
  description,
  size,
  labelClassName,
  className,
  'aria-label': ariaLabel
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  label?: string
  description?: string
  size?: 'default' | 'compact'
  labelClassName?: string
  className?: string
  'aria-label'?: string
}) {
  return (
    <BeUICheckbox
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      label={label}
      description={description}
      size={size}
      labelClassName={labelClassName}
      className={className}
      aria-label={ariaLabel}
    />
  )
}

/** Vendored beUI radio group (see components/beui/radio.tsx). */
export { RadioGroup, RadioGroupItem } from './beui/radio'
