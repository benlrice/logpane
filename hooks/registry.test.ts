import { expect, test } from 'claude-code/testing'

import {
  attach,
  detach,
  dismiss,
  dropEnded,
  empty,
  isBandWanted,
  isLive,
  output,
  pick,
  probed,
  type Registry,
  shownIndex,
} from './registry'

// Plain data and a fake `now`: no processes, no clock, no engine.

const T0 = 1_000_000
const GRACE = 4_000
const WINDOW = 20_000

const paths = (r: Registry) => r.files.map(file => file.path)
const file = (r: Registry, path: string) => r.files.find(f => f.path === path)!

/** Attach one file per step, 10ms apart, in order. */
function attachAll(names: string[], start = T0): Registry {
  let state = empty
  names.forEach((name, i) => {
    state = attach(state, start + i * 10, [name], false).state
  })

  return state
}

const eight = Array.from({ length: 8 }, (_, i) => `/f${i + 1}.log`)

test('attach adds the files and asks to start their tails', () => {
  const { state, effects } = attach(empty, T0, ['/a.log', '/b.log'], false)
  expect(paths(state)).toEqual(['/a.log', '/b.log'])
  expect(effects).toEqual({ start: ['/a.log', '/b.log'], stop: [] })
})

test('the ninth attach evicts the file attached longest ago and stops only its tail', () => {
  const { state, effects } = attach(attachAll(eight), T0 + 1_000, ['/f9.log'], false)
  expect(paths(state)).toEqual(eight.slice(1).concat('/f9.log'))
  expect(effects).toEqual({ start: ['/f9.log'], stop: ['/f1.log'] })
})

test('re-attaching a file refreshes its age, so another file is evicted first', () => {
  const refreshed = attach(attachAll(eight), T0 + 500, ['/f1.log'], false).state
  const { state, effects } = attach(refreshed, T0 + 1_000, ['/f9.log'], false)
  expect(paths(state)).not.toContain('/f2.log')
  expect(paths(state)).toContain('/f1.log')
  expect(effects.stop).toEqual(['/f2.log'])
})

test('one attach of several new files evicts as many as needed, oldest first', () => {
  const { state, effects } = attach(attachAll(eight), T0 + 1_000, ['/n1.log', '/n2.log'], false)
  expect(effects.stop).toEqual(['/f1.log', '/f2.log'])
  expect(effects.start).toEqual(['/n1.log', '/n2.log'])
  expect(state.files).toHaveLength(8)
})

test('a file evicted by its own attach is stopped, not started', () => {
  const many = Array.from({ length: 9 }, (_, i) => `/n${i + 1}.log`)
  const { effects } = attach(attachAll(eight), T0 + 1_000, many, false)
  expect(effects.start).not.toContain('/n1.log')
  expect(effects.stop).toContain('/n1.log')
})

test('Pick is cleared only when the picked file is evicted', () => {
  const full = attachAll(eight)
  expect(attach(pick(full, '/f5.log'), T0 + 1_000, ['/f9.log'], false).state.picked).toBe('/f5.log')
  expect(attach(pick(full, '/f1.log'), T0 + 1_000, ['/f9.log'], false).state.picked).toBeNull()
})

test('Newest is the last target of the latest attach', () => {
  let state = attach(empty, T0, ['/a.log', '/b.log'], false).state
  expect(state.newest).toBe('/b.log')
  state = attach(state, T0 + 10, ['/c.log', '/a.log'], false).state
  expect(state.newest).toBe('/a.log')
})

test('a foreground call keeps a file Live until it detaches', () => {
  const { state } = attach(empty, T0, ['/a.log'], true)
  const late = T0 + 10 * WINDOW
  expect(file(state, '/a.log').foreground).toBe(1)
  expect(isLive(file(state, '/a.log'), late)).toBe(true)
  const after = detach(state, late, ['/a.log']).state
  expect(file(after, '/a.log').foreground).toBe(0)
  expect(isLive(file(after, '/a.log'), late)).toBe(false)
})

test('foreground counts stack across overlapping calls and never go negative', () => {
  let state = attach(empty, T0, ['/a.log'], true).state
  state = attach(state, T0 + 1, ['/a.log'], true).state
  expect(file(state, '/a.log').foreground).toBe(2)
  state = detach(state, T0 + 2, ['/a.log']).state
  expect(file(state, '/a.log').foreground).toBe(1)
  state = detach(detach(state, T0 + 3, ['/a.log']).state, T0 + 4, ['/a.log']).state
  expect(file(state, '/a.log').foreground).toBe(0)
})

test('a background attach is Live for the grace and no longer', () => {
  const { state } = attach(empty, T0, ['/a.log'], false)
  const a = file(state, '/a.log')
  expect(isLive(a, T0 + GRACE - 1)).toBe(true)
  expect(isLive(a, T0 + GRACE)).toBe(false)
})

test('output stands in for a writer for 20s without lsof, and for the grace once lsof has answered', () => {
  const attached = attach(empty, T0, ['/a.log'], false).state
  const t = T0 + 100_000
  const written = output(attached, t, '/a.log', ['x']).state
  expect(isLive(file(written, '/a.log'), t + WINDOW - 1)).toBe(true)
  expect(isLive(file(written, '/a.log'), t + WINDOW)).toBe(false)

  const answered = probed(written, t, new Set()).state
  expect(isLive(file(answered, '/a.log'), t + GRACE - 1)).toBe(true)
  expect(isLive(file(answered, '/a.log'), t + GRACE)).toBe(false)
})

test('a writer found by lsof makes a file Live; unknown clears the verdict', () => {
  const attached = attach(empty, T0, ['/a.log'], false).state
  const t = T0 + 100_000
  const withWriter = probed(attached, t, new Set(['/a.log'])).state
  expect(isLive(file(withWriter, '/a.log'), t + 1_000_000)).toBe(true)
  expect(file(probed(withWriter, t, null).state, '/a.log').isWritten).toBeNull()
})

test('output appends lines, keeps the latest 300 and ignores unknown paths', () => {
  let state = attach(empty, T0, ['/a.log'], false).state
  state = output(state, T0 + 1, '/a.log', Array.from({ length: 250 }, (_, i) => `a${i}`)).state
  state = output(state, T0 + 2, '/a.log', Array.from({ length: 100 }, (_, i) => `b${i}`)).state
  const lines = file(state, '/a.log').lines
  expect(lines).toHaveLength(300)
  expect(lines[0]).toBe('a50')
  expect(lines[299]).toBe('b99')
  expect(output(state, T0 + 3, '/zzz.log', ['x']).state).toEqual(state)
})

test('attach clears Dismiss, even for a file that is already Live', () => {
  const dismissed = dismiss(attach(empty, T0, ['/a.log'], true).state)
  expect(dismissed.dismissed).toBe(true)
  expect(attach(dismissed, T0 + 10, ['/a.log'], true).state.dismissed).toBe(false)
})

test('Dismiss holds while nothing goes Live, and ends when an Ended file goes Live', () => {
  const t = T0 + 100_000
  const ended = dismiss(attach(empty, T0, ['/a.log'], false).state)
  expect(probed(ended, t, new Set()).state.dismissed).toBe(true)
  expect(probed(ended, t, null).state.dismissed).toBe(true)
  expect(probed(ended, t, new Set(['/a.log'])).state.dismissed).toBe(false)
  expect(output(ended, t, '/a.log', ['x']).state.dismissed).toBe(false)
})

test('output to a file that is already Live does not end Dismiss', () => {
  const live = dismiss(attach(empty, T0, ['/a.log'], true).state)
  expect(output(live, T0 + 10, '/a.log', ['x']).state.dismissed).toBe(true)
})

test('detach and dropEnded never end Dismiss', () => {
  const live = dismiss(attach(empty, T0, ['/a.log'], true).state)
  expect(detach(live, T0 + 10, ['/a.log']).state.dismissed).toBe(true)
  expect(dropEnded(live, T0 + 10).state.dismissed).toBe(true)
})

test('dropEnded removes Ended files, stops their tails and clears Pick only for a dropped file', () => {
  let state = attach(empty, T0, ['/live.log'], true).state
  state = attach(state, T0 + 1, ['/old.log'], false).state
  const t = T0 + 100_000
  const dropped = dropEnded(pick(state, '/old.log'), t)
  expect(paths(dropped.state)).toEqual(['/live.log'])
  expect(dropped.effects).toEqual({ start: [], stop: ['/old.log'] })
  expect(dropped.state.picked).toBeNull()
  expect(dropEnded(pick(state, '/live.log'), t).state.picked).toBe('/live.log')
})

test('dropEnded keeps Newest as it was', () => {
  const state = attach(empty, T0, ['/old.log'], false).state
  expect(dropEnded(state, T0 + 100_000).state.newest).toBe('/old.log')
})

test('the Band is wanted only with a Live file and no Dismiss', () => {
  const state = attach(empty, T0, ['/a.log'], false).state
  expect(isBandWanted(state, T0)).toBe(true)
  expect(isBandWanted(state, T0 + GRACE)).toBe(false)
  expect(isBandWanted(dismiss(state), T0)).toBe(false)
  expect(isBandWanted(empty, T0)).toBe(false)
})

test('operations leave their input untouched, so a retried updater gives the same answer', () => {
  const before = attach(empty, T0, ['/a.log'], false).state
  const snapshot = structuredClone(before)
  const first = attach(before, T0 + 10, ['/b.log'], true)
  const second = attach(before, T0 + 10, ['/b.log'], true)
  expect(before).toEqual(snapshot)
  expect(second).toEqual(first)
})

test('Pick overrides Newest, and null returns to following Newest', () => {
  const state = attachAll(['/a.log', '/b.log', '/c.log'])
  expect(shownIndex(state)).toBe(2)
  const picked = pick(state, '/a.log')
  expect(picked.picked).toBe('/a.log')
  expect(shownIndex(picked)).toBe(0)
  expect(shownIndex(pick(picked, null))).toBe(2)
})

test('the Shown file is Newest, which need not be the last file attached', () => {
  const state = attach(attachAll(['/a.log', '/b.log']), T0 + 100, ['/a.log'], false).state
  expect(shownIndex(state)).toBe(0)
})

test('the Shown file falls back to the last file when the Pick is not tracked', () => {
  const state = pick(attachAll(['/a.log', '/b.log', '/c.log']), '/gone.log')
  expect(shownIndex(state)).toBe(2)
})

test('Pick and Dismiss change only their own field', () => {
  const state = attachAll(['/a.log', '/b.log'])
  expect(pick(state, '/a.log')).toEqual({ ...state, picked: '/a.log' })
  expect(dismiss(state)).toEqual({ ...state, dismissed: true })
  expect(state.picked).toBeNull()
  expect(state.dismissed).toBe(false)
})
