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

export type Registry = {
  files: Tracked[]
  /** The path the person Picked, or null to follow Newest. */
  picked: string | null
  /** The last target of the most recent Bash call that redirected to a Tracked file. */
  newest: string | null
  /** True after the person Dismisses the Band, until a Tracked file goes Live again or a Bash call attaches. */
  dismissed: boolean
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
