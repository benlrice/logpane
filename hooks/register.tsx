import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import type { Tracked } from '../types'
import { cleanLine, extractTargets, labelsFor, resolvePath } from './parse'

const PANE = 'logpane'
const MAX_FILES = 8
const KEEP_LINES = 300
const INITIAL_LINES = 200
const LIVE_MS = 20_000
const TICK_MS = 2_000
const GRACE_MS = 2 * TICK_MS

const files = atom({ plugin: 'logpane', key: 'files' } as const, [])
const picked = atom({ plugin: 'logpane', key: 'picked' } as const, null)
const newest = atom({ plugin: 'logpane', key: 'newest' } as const, null)
const tick = atom({ plugin: 'logpane', key: 'tick' } as const, 0)
const size = atom({ plugin: 'logpane', key: 'size' } as const, 'normal')
const dismissed = atom({ plugin: 'logpane', key: 'dismissed' } as const, false)
const paneOpen = atom({ plugin: 'logpane', key: 'paneOpen' } as const, false)

// Pane sizes: inline body rows and docked body columns. Normal leaves both
// to the engine's default.
const SIZES = {
  normal: {},
  max: { rows: 52, columns: 156 },
} as const
type Size = keyof typeof SIZES

// A file is live while a process has it open for writing. Without lsof the
// process is unknown, so recent output stands in for it.
// Output and a fresh attach count for a short grace, so a writer that
// reopens the file per line, or one that has not opened it yet, is not missed
// between probes.
const isLive = (file: Tracked, now: number) =>
  file.foreground > 0 ||
  file.isWritten === true ||
  now - file.lastWriteAt < (file.isWritten === null ? LIVE_MS : GRACE_MS) ||
  now - file.attachedAt < GRACE_MS

type Env = Engine

const shownIndex = (list: Tracked[], pin: string | null, top: string | null) => {
  const found = list.findIndex(file => file.path === (pin ?? top))

  return found === -1 ? list.length - 1 : found
}

let isTicking = false
const tails = new Map<string, { return: (value: never) => unknown }>()
const partial = new Map<string, string>()

// Paths from `paths` that a process has open for writing, or null when lsof
// cannot run. lsof exits 1 with no output when nothing has the paths open.
async function probeWriters($: Env, paths: string[]): Promise<Set<string> | null> {
  const writers = new Set<string>()
  let out = ''
  try {
    for await (const { stream, text } of $.process.spawn({ argv: ['lsof', '-Fan', '--', ...paths] })) {
      if (stream === 'stdout') out += text
    }
  } catch (error) {
    if (/ENOENT|EACCES|not found/i.test(String(error))) return null
  }

  let access = ''
  for (const line of out.split('\n')) {
    if (line.startsWith('f')) access = ''
    else if (line.startsWith('a')) access = line.slice(1)
    else if (line.startsWith('n') && (access === 'w' || access === 'u')) writers.add(line.slice(1))
  }

  return writers
}

let isRefreshing = false

async function refresh($: Env) {
  if (isRefreshing) return
  isRefreshing = true
  try {
    const before = await read($, files)
    if (before.length === 0) return
    const writers = await probeWriters($, before.map(file => file.path))
    const now = await $.clock.now()
    const isWritten = (file: Tracked) => (writers ? writers.has(file.path) : null)
    const wentLive = before.some(file => !isLive(file, now) && isLive({ ...file, isWritten: isWritten(file) }, now))

    await update($, files, list => list.map(file => ({ ...file, isWritten: isWritten(file) })))
    if (wentLive) await update($, dismissed, () => false)
  } finally {
    isRefreshing = false
  }
}

function stopTail(path: string) {
  void tails.get(path)?.return(undefined as never)
  tails.delete(path)
  partial.delete(path)
}

function startTail($: Env, path: string) {
  if (tails.has(path)) return
  const run = $.process.spawn({
    argv: ['tail', '-n', String(INITIAL_LINES), '-F', '--', path],
  })
  tails.set(path, run)

  void (async () => {
    try {
      for await (const { stream, text } of run) {
        if (tails.get(path) !== run) break
        if (stream !== 'stdout') continue
        const parts = ((partial.get(path) ?? '') + text).split('\n')
        partial.set(path, parts.pop() ?? '')
        if (parts.length === 0) continue
        const now = await $.clock.now()
        const lines = parts.map(cleanLine)
        let wentLive = false
        await update($, files, list => {
          wentLive = list.some(file => file.path === path && !isLive(file, now))

          return list.map(file =>
            file.path === path
              ? { ...file, lines: [...file.lines, ...lines].slice(-KEEP_LINES), lastWriteAt: now }
              : file,
          )
        })
        if (wentLive) await update($, dismissed, () => false)
      }
    } catch {
      // tail could not start or was killed with the pane's file; nothing to show
    } finally {
      if (tails.get(path) === run) tails.delete(path)
    }
  })()
}

async function attach($: Env, paths: string[], isForeground: boolean) {
  const now = await $.clock.now()
  const evicted: string[] = []

  await update($, files, list => {
    let next = list
    for (const path of paths) {
      const known = next.find(file => file.path === path)
      next = known
        ? next.map(file =>
            file.path === path
              ? { ...file, attachedAt: now, foreground: file.foreground + (isForeground ? 1 : 0) }
              : file,
          )
        : [...next, { path, lines: [], foreground: isForeground ? 1 : 0, lastWriteAt: 0, attachedAt: now, isWritten: null }]
    }
    while (next.length > MAX_FILES) {
      const oldest = next.reduce((a, b) => (b.attachedAt < a.attachedAt ? b : a))
      evicted.push(oldest.path)
      next = next.filter(file => file !== oldest)
    }

    return next
  })

  for (const path of evicted) stopTail(path)
  if (evicted.length > 0) await update($, picked, current => (current && evicted.includes(current) ? null : current))
  await update($, newest, () => paths[paths.length - 1] ?? null)
  await update($, dismissed, () => false)
  for (const path of paths) if (!evicted.includes(path)) startTail($, path)
}

function detach($: Env, paths: string[]) {
  return update($, files, list =>
    list.map(file =>
      paths.includes(file.path) ? { ...file, foreground: Math.max(0, file.foreground - 1) } : file,
    ),
  )
}

async function openPane($: Env, extra: { rows?: number; columns?: number } = {}) {
  const opened = await $.ui.open({ id: PANE, title: 'logpane', focus: true, closeOnEscape: true, ...extra })
  if (opened.isPlaced) await update($, paneOpen, () => true)

  return opened
}

async function dropEnded($: Env) {
  const now = await $.clock.now()
  const dropped: string[] = []

  await update($, files, list => {
    dropped.length = 0
    for (const file of list) if (!isLive(file, now)) dropped.push(file.path)

    return list.filter(file => isLive(file, now))
  })

  for (const path of dropped) stopTail(path)
  await update($, picked, current => (current && dropped.includes(current) ? null : current))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'logpane',
      description: 'Open a pane tailing the files your Bash calls write to',
    })
    if (!isTicking) {
      isTicking = true
      $.clock.every(TICK_MS, () => {
        void update($, tick, n => n + 1)
        refresh($).catch(() => {})
      })
    }

    return next(e)
  })

  on('command.run', { command: 'logpane' }, async $ => {
    await dropEnded($)
    await update($, picked, () => null)
    await update($, size, () => 'normal')
    const opened = await openPane($)

    return opened.isPlaced ? {} : { text: `logpane: the pane could not be placed. ${opened.reason}` }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const targets = typeof e.command === 'string' ? extractTargets(e.command) : []
    if (targets.length === 0) return next(e)

    const cwd = await $.session.cwd()
    const paths = [...new Set(targets.map(target => resolvePath(cwd, target)))]
    const isForeground = e.run_in_background !== true
    await attach($, paths, isForeground)

    try {
      return await next(e)
    } finally {
      if (isForeground) await detach($, paths)
    }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      await update($, paneOpen, () => false)
      await dropEnded($)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    await read($, tick)
    const list = await read($, files)
    const pin = await read($, picked)
    const top = await read($, newest)
    const level = await read($, size)
    const now = await $.clock.now()

    if (list.length === 0) {
      return <Text dimColor>No files tracked yet. Run a Bash command that redirects to a file, such as `make > build.log`.</Text>
    }

    const labels = labelsFor(list.map(file => file.path))
    const shownAt = shownIndex(list, pin, top)
    const shown = list[shownAt]
    const shownLabel = labels[shownAt]
    const resize = async (target: Size) => {
      const next: Size = level === target ? 'normal' : target
      await update($, size, () => next)
      await openPane($, SIZES[next])
    }
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 4)

    return (
      <Box flexDirection="column">
        <Box justifyContent="flex-end" columnGap={1}>
          <Button hotkey="m" label={level === 'max' ? '❐' : '□'} onPress={() => resize('max')} />
        </Box>
        <Box flexWrap="wrap" columnGap={1}>
          {list.map((file, i) => (
            <Button
              key={file.path}
              hotkey={String(i + 1)}
              variant={file === shown ? 'primary' : undefined}
              label={`${isLive(file, now) ? '●' : '○'} ${labels[i]}`}
              onPress={() => update($, picked, () => file.path)}
            />
          ))}
        </Box>
        <Text dimColor>
          {isLive(shown, now) ? 'live' : 'ended'}: {shownLabel}
        </Text>
        {shown.lines.slice(-room).map((line, i) => (
          <Text key={i} wrap="truncate-end">{line}</Text>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, files)
    const isHidden = await read($, dismissed)
    const isOpen = await read($, paneOpen)
    await read($, tick)
    const now = await $.clock.now()

    if (e.props.hasSurvey || isHidden || isOpen || e.props.maxRows < 1 || !list.some(file => isLive(file, now))) return next(e)

    const { Box, Button } = $.ui.resolve(e)
    const labels = labelsFor(list.map(file => file.path))
    const show = async (path: string) => {
      const previous = await read($, picked)
      await update($, picked, () => path)
      await update($, size, () => 'normal')
      const opened = await openPane($)
      if (!opened.isPlaced) await update($, picked, () => previous)
    }

    return (
      <Box justifyContent="space-between">
        <Box flexWrap="wrap" columnGap={1}>
          {list.map((file, i) => (
            <Button
              key={file.path}
              hotkey={String(i + 1)}
              label={`${i + 1} ${isLive(file, now) ? '●' : '○'} ${labels[i]}`}
              onPress={() => show(file.path)}
            />
          ))}
        </Box>
        <Button key="dismiss" label="✕" onPress={() => update($, dismissed, () => true)} />
      </Box>
    )
  })
}
