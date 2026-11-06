"use client";
// Vendored from beUI (https://beui.dev) — MIT license — components/motion/checkbox
// Adapted: cn/ease imports point at our libs; checked-color uses the app accent.
// Added `size="compact"` for dense grids (file permissions, column pickers),
// where beUI's 20px box is too large for the row height.

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId } from "react";
import { EASE_OUT, SPRING_PRESS } from "./lib/ease";
import { cn } from "../../lib/cn";

const CHECK_PATH = "M5 13l4 4L19 7";
const INDETERMINATE_PATH = "M6 12h12";

export interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  indeterminate?: boolean;
  label?: string;
  /** Supporting text under the label, announced as the description rather than the name. */
  description?: string;
  /** "compact" shrinks the box and mark for dense grids. Defaults to "default". */
  size?: "default" | "compact";
  /** Wrap the label in the given classes (call sites restyle the whole row). */
  labelClassName?: string;
  className?: string;
  id?: string;
  "aria-label"?: string;
  /** Associates an external message (e.g. a form error) with the control. */
  "aria-describedby"?: string;
}

export function Checkbox({
  checked,
  onCheckedChange,
  disabled,
  indeterminate,
  size = "default",
  labelClassName,
  className,
  label,
  description,
  id: idProp,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
}: CheckboxProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const reduce = useReducedMotion();
  const showMark = checked || indeterminate;
  const path = indeterminate ? INDETERMINATE_PATH : CHECK_PATH;
  const descriptionId = description ? `${id}-description` : undefined;
  // The wrapping <label> would fold the description into the name, so name from the label text alone.
  const labelId = description && label && !ariaLabel ? `${id}-label` : undefined;
  const describedBy =
    [ariaDescribedBy, descriptionId].filter(Boolean).join(" ") || undefined;

  return (
    <label
      htmlFor={id}
      className={cn(
        "inline-flex gap-3",
        description ? "items-start" : "items-center",
        disabled ? "cursor-not-allowed" : "cursor-pointer",
        labelClassName,
        className,
      )}
    >
      <motion.button
        id={id}
        type="button"
        role="checkbox"
        aria-checked={indeterminate ? "mixed" : checked}
        aria-label={ariaLabel}
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={() => !disabled && onCheckedChange(!checked)}
        whileTap={reduce || disabled ? undefined : { scale: 0.92 }}
        transition={SPRING_PRESS}
        data-state={
          checked ? "checked" : indeterminate ? "indeterminate" : "unchecked"
        }
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-md border-2 outline-none transition-colors duration-200",
          size === "compact" ? "h-3.5 w-3.5 rounded" : "h-5 w-5",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:cursor-not-allowed disabled:opacity-60",
          showMark
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/50 bg-background hover:border-muted-foreground",
        )}
      >
        <AnimatePresence initial={false}>
          {showMark ? (
            <motion.svg
              key={indeterminate ? "indeterminate" : "checked"}
              width={size === "compact" ? 9 : 12}
              height={size === "compact" ? 9 : 12}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.5 }}
              animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1 }}
              exit={
                reduce
                  ? { opacity: 0 }
                  : { opacity: 0, scale: 0.5, filter: "blur(4px)" }
              }
              transition={
                reduce ? { duration: 0 } : { duration: 0.16, ease: EASE_OUT }
              }
              aria-hidden
            >
              <title>{indeterminate ? "Partially selected" : "Selected"}</title>
              <motion.path
                d={path}
                initial={reduce ? { pathLength: 1 } : { pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={
                  reduce
                    ? { duration: 0 }
                    : {
                        duration: indeterminate ? 0.2 : 0.3,
                        ease: EASE_OUT,
                        delay: 0.04,
                      }
                }
              />
            </motion.svg>
          ) : null}
        </AnimatePresence>
      </motion.button>
      {label || description ? (
        <span className={cn("flex min-w-0 flex-col gap-0.5 select-none", disabled && "opacity-60")}>
          {label ? (
            <span
              id={labelId}
              // Geist sits low in a 20px line; a 16px line lifts the text onto the control.
              className={cn("text-sm text-foreground", description && "leading-4")}
            >
              {label}
            </span>
          ) : null}
          {description ? (
            <span id={descriptionId} className="text-xs text-muted-foreground">
              {description}
            </span>
          ) : null}
        </span>
      ) : null}
    </label>
  );
}
