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
      files: Tracked[]
      /** The path the person pinned, or null to follow the newest. */
      picked: string | null
      /** The path of the most recent command's target. */
      newest: string | null
      /** Bumped on a timer so the live and ended markers redraw. */
      tick: number
      /** The pane's size: the default, or maximized. */
      size: 'normal' | 'max'
      /** True after the person hides the band, until a file goes live again. */
      dismissed: boolean
      /** True while the pane is open; the band hides then. */
      paneOpen: boolean
    }
  }
}
