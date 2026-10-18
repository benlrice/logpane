// The registry: every rule about the Tracked files, as pure functions over one
// value. Operations take `now` and return the new state plus the tails to start
// or stop; they never spawn, never read a clock, and never mutate their input,
// so an updater that wraps one is safe to re-run when `update` retries.

import type { Tracked } from '../types'

export const MAX_FILES = 8
export const KEEP_LINES = 300
const LIVE_MS = 20_000
const GRACE_MS = 4_000

export type Registry = {
  files: Tracked[]
  /** The path the person Picked, or null to follow Newest. */
  picked: string | null
  /** The last target of the most recent Bash call that redirected to a Tracked file. */
  newest: string | null
  /** True after the person Dismisses the Band, until a file goes Live again or a Bash call attaches. */
  dismissed: boolean
}

/** Paths whose tails the adapter must start or stop. */
export type Effects = { start: string[]; stop: string[] }

export type Result = { state: Registry; effects: Effects }

export const empty: Registry = { files: [], picked: null, newest: null, dismissed: false }

const none: Effects = { start: [], stop: [] }

// A file is Live while a process has it open for writing. Without lsof the
// process is unknown, so recent output stands in for it. Output and a fresh
// attach count for a short grace, so a writer that reopens the file per line,
// or one that has not opened it yet, is not missed between probes.
export const isLive = (file: Tracked, now: number) =>
  file.foreground > 0 ||
  file.isWritten === true ||
  now - file.lastWriteAt < (file.isWritten === null ? LIVE_MS : GRACE_MS) ||
  now - file.attachedAt < GRACE_MS

/** Whether the Band should show, before the adapter adds its screen conditions. */
export const isBandWanted = (state: Registry, now: number) =>
  !state.dismissed && state.files.some(file => isLive(file, now))

/** The index of the Shown file (Pick, else Newest), or the last file when neither is tracked. */
export const shownIndex = (state: Registry) => {
  const found = state.files.findIndex(file => file.path === (state.picked ?? state.newest))

  return found === -1 ? state.files.length - 1 : found
}

// The one un-dismiss rule: Dismiss ends when an Ended file goes Live, or on attach.
function settle(before: Registry, after: Registry, now: number, isAttach: boolean): Registry {
  const wentLive = before.files.some(
    old => !isLive(old, now) && after.files.some(file => file.path === old.path && isLive(file, now)),
  )

  return isAttach || wentLive ? { ...after, dismissed: false } : after
}

export function attach(state: Registry, now: number, paths: string[], isForeground: boolean): Result {
  let files = state.files
  for (const path of paths) {
    files = files.some(file => file.path === path)
      ? files.map(file =>
          file.path === path
            ? { ...file, attachedAt: now, foreground: file.foreground + (isForeground ? 1 : 0) }
            : file,
        )
      : [...files, { path, lines: [], foreground: isForeground ? 1 : 0, lastWriteAt: 0, attachedAt: now, isWritten: null }]
  }
  const evicted: string[] = []
  while (files.length > MAX_FILES) {
    const oldest = files.reduce((a, b) => (b.attachedAt < a.attachedAt ? b : a))
    evicted.push(oldest.path)
    files = files.filter(file => file !== oldest)
  }
  const picked = state.picked && evicted.includes(state.picked) ? null : state.picked
  const next = settle(state, { files, picked, newest: paths[paths.length - 1] ?? null, dismissed: state.dismissed }, now, true)

  return { state: next, effects: { start: paths.filter(path => !evicted.includes(path)), stop: evicted } }
}

export function detach(state: Registry, now: number, paths: string[]): Result {
  const files = state.files.map(file =>
    paths.includes(file.path) ? { ...file, foreground: Math.max(0, file.foreground - 1) } : file,
  )

  return { state: settle(state, { ...state, files }, now, false), effects: none }
}

export function output(state: Registry, now: number, path: string, lines: string[]): Result {
  const files = state.files.map(file =>
    file.path === path ? { ...file, lines: [...file.lines, ...lines].slice(-KEEP_LINES), lastWriteAt: now } : file,
  )

  return { state: settle(state, { ...state, files }, now, false), effects: none }
}

/** The paths with a writer open, or null when lsof could not say. */
export function probed(state: Registry, now: number, writers: Set<string> | null): Result {
  const files = state.files.map(file => ({ ...file, isWritten: writers ? writers.has(file.path) : null }))

  return { state: settle(state, { ...state, files }, now, false), effects: none }
}

export function dropEnded(state: Registry, now: number): Result {
  const kept = state.files.filter(file => isLive(file, now))
  const dropped = state.files.filter(file => !kept.includes(file)).map(file => file.path)
  const picked = state.picked && dropped.includes(state.picked) ? null : state.picked

  return { state: { ...state, files: kept, picked }, effects: { start: [], stop: dropped } }
}

/** Pick a file, or pass null to follow Newest again. */
export const pick = (state: Registry, path: string | null): Registry => ({ ...state, picked: path })

export const dismiss = (state: Registry): Registry => ({ ...state, dismissed: true })
