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

const files = atom({ plugin: 'logpane', key: 'files' } as const, [])
const picked = atom({ plugin: 'logpane', key: 'picked' } as const, null)
const newest = atom({ plugin: 'logpane', key: 'newest' } as const, null)
const tick = atom({ plugin: 'logpane', key: 'tick' } as const, 0)
const size = atom({ plugin: 'logpane', key: 'size' } as const, 'normal')

// Pane sizes: inline body rows and docked body columns. Normal leaves both
// to the engine's default.
const SIZES = {
  min: { rows: 6, columns: 50 },
  normal: {},
  max: { rows: 40, columns: 120 },
} as const
type Size = keyof typeof SIZES

const isLive = (file: Tracked, now: number) =>
  file.foreground > 0 || now - file.lastWriteAt < LIVE_MS

type Env = Engine

let isTicking = false
const tails = new Map<string, { return: (value: never) => unknown }>()
const partial = new Map<string, string>()

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
        await update($, files, list =>
          list.map(file =>
            file.path === path
              ? { ...file, lines: [...file.lines, ...lines].slice(-KEEP_LINES), lastWriteAt: now }
              : file,
          ),
        )
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
        : [...next, { path, lines: [], foreground: isForeground ? 1 : 0, lastWriteAt: 0, attachedAt: now }]
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
  for (const path of paths) if (!evicted.includes(path)) startTail($, path)
}

function detach($: Env, paths: string[]) {
  return update($, files, list =>
    list.map(file =>
      paths.includes(file.path) ? { ...file, foreground: Math.max(0, file.foreground - 1) } : file,
    ),
  )
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
      $.clock.every(TICK_MS, () => void update($, tick, n => n + 1))
    }

    return next(e)
  })

  on('command.run', { command: 'logpane' }, async $ => {
    await dropEnded($)
    await update($, picked, () => null)
    await update($, size, () => 'normal')
    const opened = await $.ui.open({ id: PANE, title: 'logpane', focus: true, closeOnEscape: true })

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
    if (e.id === PANE) await dropEnded($)

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
    const shown = list.find(file => file.path === (pin ?? top)) ?? list[list.length - 1]
    const shownLabel = labels[list.indexOf(shown)]
    const resize = async (target: Size) => {
      const next: Size = level === target ? 'normal' : target
      await update($, size, () => next)
      await $.ui.open({ id: PANE, title: 'logpane', focus: true, closeOnEscape: true, ...SIZES[next] })
    }
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 4)

    return (
      <Box flexDirection="column">
        <Box justifyContent="flex-end" columnGap={1}>
          <Button hotkey="n" label={level === 'min' ? '❐' : '–'} onPress={() => resize('min')} />
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
}
