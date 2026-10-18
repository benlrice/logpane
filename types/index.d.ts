import type { Registry } from '../hooks/registry'

export type Tracked = {
  /** Absolute path, as the Bash command routed output to it. */
  path: string
  /** The last lines read from `tail -F`, oldest first. */
  lines: string[]
  /** Foreground Bash calls currently routed to the file. */
  foreground: number
  /** When stdout of the tail last produced lines, in ms; 0 for never. */
  lastWriteAt: number
  /** When a command last routed output to the file, in ms. */
  attachedAt: number
  /** Whether a process has the file open for writing; null when that cannot be checked. */
  isWritten: boolean | null
}

declare module 'claude-code' {
  interface PluginState {
    logpane: {
      /** The Tracked files, Pick, Newest and the Dismiss flag, written together. */
      registry: Registry
      /** Bumped on a timer so the Live and Ended markers redraw. */
      tick: number
      /** The Pane's size: the default, or maximized. */
      size: 'normal' | 'max'
      /** True while the Pane is open; the Band hides then. */
      paneOpen: boolean
    }
  }
}
