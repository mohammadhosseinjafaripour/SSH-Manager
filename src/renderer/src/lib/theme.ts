import type { Theme } from '@shared/types'

function resolve(theme: Theme): 'dark' | 'light' {
  if (theme === 'system') {
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return theme
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = resolve(theme)
}

export function watchSystemTheme(onChange: () => void): () => void {
  const mq = matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}
