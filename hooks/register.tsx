import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import { cleanLine, extractTargets, resolvePath } from './parse'
import {
  attach,
  detach,
  dismiss,
  dropEnded,
  empty,
  isBandWanted,
  output,
  pick,
  probed,
  type Effects,
  type Registry,
  type Result,
} from './registry'
import { isTrackedFile } from './tracked'
import { viewFiles } from './view'

const PANE = 'logpane'
const INITIAL_LINES = 200
// The Registry's GRACE_MS is two ticks; change them together.
const TICK_MS = 2_000

const registry = atom({ plugin: 'logpane', key: 'registry' } as const, empty)
const tick = atom({ plugin: 'logpane', key: 'tick' } as const, 0)
const size = atom({ plugin: 'logpane', key: 'size' } as const, 'normal')
const paneOpen = atom({ plugin: 'logpane', key: 'paneOpen' } as const, false)

// Pane sizes: inline body rows and docked body columns. Normal leaves both
// to the engine's default.
const SIZES = {
  normal: {},
  max: { rows: 52, columns: 156 },
} as const
type Size = keyof typeof SIZES

type Env = Engine

let isTicking = false
const tails = new Map<string, { return: (value: never) => unknown }>()
const partial = new Map<string, string>()

// Paths from `paths` (Tracked files) that a process has open for writing, or null when lsof
// cannot run. lsof exits 1 with no output when nothing has the paths open.
async function probeWriters($: Env, paths: string[]): Promise<Set<string> | null> {
  const writers = new Set<string>()
  let out = ''
  const run = $.process.spawn({ argv: ['lsof', '-Fan', '--', ...paths] })
  try {
    for await (const { stream, text } of run) if (stream === 'stdout') out += text
  } catch {
    return null
  }
  // Exit 0 lists writers; exit 1 is lsof's answer for no open files. Anything else is a failure.
  const exit = await run.result.catch(() => null)
  if (exit?.code !== 0 && exit?.code !== 1) return null

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
    const before = await read($, registry)
    if (before.files.length === 0) return
    const writers = await probeWriters($, before.files.map(file => file.path))
    const now = await $.clock.now()
    await commit($, state => probed(state, now, writers))
  } finally {
    isRefreshing = false
  }
}

// One `update` per operation. The registry is pure, so the updater is safe to
// re-run; the effects of the final run are the ones applied.
async function commit($: Env, operation: (state: Registry) => Result) {
  let effects: Effects = { start: [], stop: [] }
  await update($, registry, state => {
    const result = operation(state)
    effects = result.effects

    return result.state
  })
  for (const path of effects.stop) stopTail(path)
  for (const path of effects.start) startTail($, path)
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
        await commit($, state => output(state, now, path, lines))
      }
    } catch {
      // tail could not start or was killed with the Tracked file; nothing to show
    } finally {
      if (tails.get(path) === run) tails.delete(path)
    }
  })()
}

async function dropEndedFiles($: Env) {
  const now = await $.clock.now()
  await commit($, state => dropEnded(state, now))
}

async function openPane($: Env, extra: { rows?: number; columns?: number } = {}) {
  const opened = await $.ui.open({ id: PANE, title: 'logpane', focus: true, closeOnEscape: true, ...extra })
  if (opened.isPlaced) await update($, paneOpen, () => true)

  return opened
}

// Opens the Pane at normal size on a Pick (null follows Newest). If the Pane
// cannot be placed, the earlier Pick comes back.
async function showPane($: Env, path: string | null) {
  const previous = (await read($, registry)).picked
  await update($, registry, state => pick(state, path))
  await update($, size, () => 'normal')
  const opened = await openPane($)
  if (!opened.isPlaced) await update($, registry, state => pick(state, previous))

  return opened
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
    await dropEndedFiles($)
    const opened = await showPane($, null)

    return opened.isPlaced ? {} : { text: `logpane: the pane could not be placed. ${opened.reason}` }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const targets = typeof e.command === 'string' ? extractTargets(e.command) : []
    if (targets.length === 0) return next(e)

    const cwd = await $.session.cwd()
    const paths = [...new Set(targets.map(target => resolvePath(cwd, target)).filter(isTrackedFile))]
    if (paths.length === 0) return next(e)
    const isForeground = e.run_in_background !== true
    const attachedAt = await $.clock.now()
    await commit($, state => attach(state, attachedAt, paths, isForeground))

    try {
      return await next(e)
    } finally {
      if (isForeground) {
        const detachedAt = await $.clock.now()
        await commit($, state => detach(state, detachedAt, paths))
      }
    }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      await update($, paneOpen, () => false)
      await dropEndedFiles($)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    await read($, tick)
    const state = await read($, registry)
    const level = await read($, size)
    const now = await $.clock.now()

    if (state.files.length === 0) {
      return <Text dimColor>No files tracked yet. Run a Bash command that redirects to a file, such as `make > build.log`.</Text>
    }

    const views = viewFiles(state, now)
    const shownView = views.find(view => view.isShown)!
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
          {views.map((view, i) => (
            <Button
              key={view.path}
              hotkey={String(i + 1)}
              variant={view.isShown ? 'primary' : undefined}
              label={`${view.marker} ${view.label}`}
              onPress={() => update($, registry, current => pick(current, view.path))}
            />
          ))}
        </Box>
        <Text dimColor>
          {shownView.isLive ? 'live' : 'ended'}: {shownView.label}
        </Text>
        {state.files.find(file => file.path === shownView.path)!.lines.slice(-room).map((line, i) => (
          <Text key={i} wrap="truncate-end">{line}</Text>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, registry)
    const isOpen = await read($, paneOpen)
    await read($, tick)
    const now = await $.clock.now()

    if (e.props.hasSurvey || isOpen || e.props.maxRows < 1 || !isBandWanted(state, now)) return next(e)

    const { Box, Button } = $.ui.resolve(e)
    const views = viewFiles(state, now)
    return (
      <Box justifyContent="space-between">
        <Box flexWrap="wrap" columnGap={1}>
          {views.map((view, i) => (
            <Button
              key={view.path}
              hotkey={String(i + 1)}
              label={`${i + 1} ${view.marker} ${view.label}`}
              onPress={() => showPane($, view.path)}
            />
          ))}
        </Box>
        <Button key="dismiss" label="✕" onPress={() => update($, registry, dismiss)} />
      </Box>
    )
  })
}
