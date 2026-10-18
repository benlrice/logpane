import { expect, test } from 'claude-code/testing'

import { attach, empty, output, pick, type Registry } from './registry'
import { labelsFor, viewFiles } from './view'

const T0 = 1_000_000

function attachAll(paths: string[]): Registry {
  let state = empty
  paths.forEach((path, i) => {
    state = attach(state, T0 + i, [path], false).state
  })

  return state
}

test('labels collisions with their folder', () => {
  expect(labelsFor(['/a/x/build.log', '/a/y/build.log', '/a/tests.log'])).toEqual([
    'x/build.log',
    'y/build.log',
    'tests.log',
  ])
})

test('views nothing when no file is tracked', () => {
  expect(viewFiles(empty, T0)).toEqual([])
})

test('views each file with its path, label, Live verdict and Shown flag', () => {
  const now = T0 + 60_000
  const state = output(attachAll(['/a/x/build.log', '/a/y/build.log']), now, '/a/y/build.log', ['hi']).state

  expect(viewFiles(state, now)).toEqual([
    { path: '/a/x/build.log', label: 'x/build.log', isLive: false, isShown: false },
    { path: '/a/y/build.log', label: 'y/build.log', isLive: true, isShown: true },
  ])
})

test('marks the Picked file as Shown', () => {
  const state = pick(attachAll(['/a/one.log', '/a/two.log']), '/a/one.log')

  expect(viewFiles(state, T0).map(f => f.isShown)).toEqual([true, false])
})
