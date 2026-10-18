// The view: what the Pane and the Band both show about each Tracked file, as pure
// data. Each handler builds its own JSX from it, so a label or marker changes in one place.

import { isLive, type Registry, shownIndex } from './registry'

export type FileView = { path: string; label: string; isLive: boolean; marker: '●' | '○'; isShown: boolean }

// Button text for each path: the file name, with its folder only where names collide.
export function labelsFor(paths: readonly string[]): string[] {
  const names = paths.map(path => path.split('/').pop() ?? path)

  return paths.map((path, i) => {
    if (names.filter(name => name === names[i]).length < 2) return names[i]
    const parent = path.split('/').slice(-2, -1)[0]

    return parent ? `${parent}/${names[i]}` : names[i]
  })
}

export function viewFiles(state: Registry, now: number): FileView[] {
  const labels = labelsFor(state.files.map(file => file.path))
  const shownAt = shownIndex(state)

  return state.files.map((file, i) => {
    const live = isLive(file, now)

    return { path: file.path, label: labels[i], isLive: live, marker: live ? '●' : '○', isShown: i === shownAt }
  })
}
