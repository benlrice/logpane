// The Tracked-file policy: which paths logpane tails. A Tracked file is a `.log`
// name with a stem (case-insensitive), and never a device or process file.

const EXCLUDED = /^\/(dev|proc)(\/|$)/
const LOG_NAME = /(^|\/)[^/]+\.log$/i

export function isTrackedFile(path: string): boolean {
  return LOG_NAME.test(path) && !EXCLUDED.test(path)
}
