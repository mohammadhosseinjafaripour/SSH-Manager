import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** beUI-style class merge: conditional classes + Tailwind conflict resolution. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
