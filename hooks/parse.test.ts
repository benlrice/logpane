import { expect, test } from 'claude-code/testing'

import { cleanLine, extractTargets, labelsFor, resolvePath } from './parse'

test('tracks the redirects and tee forms from the table', () => {
  expect(extractTargets('cmd > out.log')).toEqual(['out.log'])
  expect(extractTargets('cmd >> out.log')).toEqual(['out.log'])
  expect(extractTargets('cmd | tee out.log')).toEqual(['out.log'])
  expect(extractTargets('cmd | tee -a out.log')).toEqual(['out.log'])
  expect(extractTargets('cmd > a.log 2> b.log')).toEqual(['a.log', 'b.log'])
  expect(extractTargets('cmd > /dev/null 2>&1')).toEqual([])
})

test('handles the other redirect spellings and quoted paths', () => {
  expect(extractTargets('cmd &> a.log')).toEqual(['a.log'])
  expect(extractTargets('cmd &>> a.log')).toEqual(['a.log'])
  expect(extractTargets('cmd 1> a.log')).toEqual(['a.log'])
  expect(extractTargets('cmd >| a.log')).toEqual(['a.log'])
  expect(extractTargets('cmd >"my build.log"')).toEqual(['my build.log'])
  expect(extractTargets("cmd | tee -a 'a b.log' c.log")).toEqual(['a b.log', 'c.log'])
  expect(extractTargets('cmd > a.log 2>&1')).toEqual(['a.log'])
})

test('tracks only names that end in .log with a stem', () => {
  expect(extractTargets('cmd > out.json')).toEqual([])
  expect(extractTargets('cmd >> .gitignore')).toEqual([])
  expect(extractTargets('cmd | tee notes.md')).toEqual([])
  expect(extractTargets('cmd > a.log 2> errors.txt')).toEqual(['a.log'])
  expect(extractTargets('cmd > BUILD.LOG')).toEqual(['BUILD.LOG'])
  expect(extractTargets('cmd > logs/run.log')).toEqual(['logs/run.log'])
  expect(extractTargets('cmd > build.log.1 2> app.log.gz')).toEqual([])
  expect(extractTargets('cmd > .log 2> logs/.log')).toEqual([])
})

test('skips what a shell would have to expand', () => {
  expect(extractTargets('cmd > $LOG')).toEqual([])
  expect(extractTargets('cmd > ~/x.log')).toEqual([])
  expect(extractTargets('cmd > logs/*.log')).toEqual([])
  expect(extractTargets('cmd > `name`.log')).toEqual([])
  expect(extractTargets('cmd > "$(date).log"')).toEqual([])
  expect(extractTargets('cmd > /dev/stderr > /proc/self/fd/1')).toEqual([])
})

test('reads compound commands without guessing', () => {
  expect(extractTargets('a && b > x.log; c | tee y.log')).toEqual(['x.log', 'y.log'])
  expect(extractTargets('echo tee not.log')).toEqual([])
  expect(extractTargets('echo $(cat > hidden.log) > shown.log')).toEqual(['shown.log'])
  expect(extractTargets('cat <<EOF > a.log\nbody > nope.log\nEOF\nmake > b.log')).toEqual(['a.log', 'b.log'])
  expect(extractTargets('FOO=1 make | tee -- -odd.log')).toEqual(['-odd.log'])
  expect(extractTargets('make # > comment.log')).toEqual([])
})

test('resolves paths against the working directory', () => {
  expect(resolvePath('/home/a', 'out.log')).toBe('/home/a/out.log')
  expect(resolvePath('/home/a', '../b/./out.log')).toBe('/home/b/out.log')
  expect(resolvePath('/home/a', '/tmp/out.log')).toBe('/tmp/out.log')
})

test('cleans terminal output and labels collisions', () => {
  expect(cleanLine('\x1b[32mok\x1b[0m')).toBe('ok')
  expect(cleanLine('ok\r')).toBe('ok')
  expect(cleanLine('10%\r50%\r100%')).toBe('100%')
  expect(labelsFor(['/a/x/build.log', '/a/y/build.log', '/a/tests.log'])).toEqual([
    'x/build.log',
    'y/build.log',
    'tests.log',
  ])
})
