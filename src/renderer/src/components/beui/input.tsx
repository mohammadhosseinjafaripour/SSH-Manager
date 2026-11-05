"use client";
// Vendored from beUI (https://beui.dev) — MIT license — components/motion/input
// Adapted: onChange keeps the standard React event signature (react-hook-form's
// register() relies on it) and onValueChange carries beUI's string callback.
// Error styling uses our danger tokens.

import { animate, motion, useReducedMotion } from "motion/react";
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEventHandler,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "../../lib/cn";

export type InputClassNames = {
  root?: string;
  label?: string;
  field?: string;
  input?: string;
  leftIcon?: string;
  rightIcon?: string;
  successIcon?: string;
  errorMessage?: string;
};

export interface BeUIInputProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "onChange" | "value" | "defaultValue" | "size"
  > {
  label?: string;
  value?: string;
  defaultValue?: string;
  /** Standard React onChange — receives the event (react-hook-form compatible). */
  onChange?: ChangeEventHandler<HTMLInputElement>;
  /** beUI-style string callback, fired alongside onChange. */
  onValueChange?: (value: string) => void;
  /** Truthy error triggers a shake, red border and (if a string) a message. */
  error?: string | boolean;
  /** Reserve one message line so validation does not shift nearby content. */
  reserveErrorLine?: boolean;
  success?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  className?: string;
  classNames?: InputClassNames;
}

export const BeUIInput = forwardRef<HTMLInputElement, BeUIInputProps>(function BeUIInput(
  {
    label,
    value: valueProp,
    defaultValue,
    onChange,
    onValueChange,
    onFocus,
    onBlur,
    error,
    success,
    leftIcon,
    rightIcon,
    className,
    classNames,
    disabled,
    id: idProp,
    type,
    ...rest
  },
  ref,
) {
  const reactId = useId();
  const id = idProp ?? reactId;
  const reduce = useReducedMotion();

  const controlled = valueProp !== undefined;
  const [internal, setInternal] = useState(defaultValue ?? "");
  const value = controlled ? (valueProp ?? "") : internal;

  const [focused, setFocused] = useState(false);

  const fieldRef = useRef<HTMLDivElement>(null);

  const hasError = Boolean(error);
  const errorMessage = typeof error === "string" ? error : null;

  const rightSlot = success ? null : rightIcon;

  // Shake the field when an error appears.
  useEffect(() => {
    if (!fieldRef.current || reduce || !hasError) return;
    animate(fieldRef.current, { x: [0, -6, 6, -4, 4, -2, 0] }, { duration: 0.45 });
  }, [hasError, reduce]);

  const handleNativeChange: ChangeEventHandler<HTMLInputElement> = (event) => {
    const next = event.target.value;
    if (!controlled) setInternal(next);
    onValueChange?.(next);
    onChange?.(event);
  };

  return (
    <div className={cn("flex flex-col gap-1.5", className, classNames?.root)}>
      {label ? (
        <label
          htmlFor={id}
          className={cn("px-1 text-sm font-medium text-foreground", classNames?.label)}
        >
          {label}
        </label>
      ) : null}

      <div
        ref={fieldRef}
        data-state={
          hasError ? "error" : success ? "success" : focused ? "focused" : "idle"
        }
        className={cn(
          "relative h-10 overflow-hidden rounded-full border transition-colors duration-200",
          "border-border",
          focused && !hasError && "border-foreground/40 ring-2 ring-ring/40",
          hasError && "border-danger ring-2 ring-danger/25",
          disabled && "opacity-60",
          classNames?.field
        )}
      >
        {leftIcon ? (
          <span className="pointer-events-none absolute left-3 top-1/2 flex -translate-y-1/2 items-center text-muted-foreground [&_svg]:h-4 [&_svg]:w-4">
            {leftIcon}
          </span>
        ) : null}

        <input
          ref={ref}
          id={id}
          type={type}
          value={value}
          disabled={disabled}
          aria-invalid={hasError || undefined}
          aria-describedby={errorMessage ? `${id}-error` : undefined}
          {...rest}
          onChange={handleNativeChange}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          className={cn(
            "peer h-full w-full bg-transparent text-sm leading-5 text-foreground caret-foreground outline-none",
            "placeholder:text-muted-foreground/60",
            leftIcon ? "pl-10" : "pl-3.5",
            rightSlot || success ? "pr-10" : "pr-3.5",
            disabled && "cursor-not-allowed",
            classNames?.input
          )}
        />

        {success ? (
          <motion.svg
            viewBox="0 0 24 24"
            fill="none"
            className="absolute right-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-ok"
          >
            <motion.path
              d="M5 12.5l4.5 4.5L19 7.5"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={reduce ? { pathLength: 1 } : { pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.35, ease: "easeOut" }}
            />
          </motion.svg>
        ) : null}

        {rightSlot ? (
          <span className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center text-muted-foreground [&_svg]:h-4 [&_svg]:w-4">
            {rightSlot}
          </span>
        ) : null}
      </div>

      {errorMessage ? (
        <p
          id={`${id}-error`}
          className={cn("px-1 text-xs text-danger", classNames?.errorMessage)}
        >
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
});
