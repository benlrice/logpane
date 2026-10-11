import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// Everything here goes through the module's event interface: a fake tail
// (`process.spawn`), a fake clock, a fake working directory and a fake pane.

const CWD = '/work'

type Rig = {
  $: Engine
  spawned: string[]
  argv: readonly string[]
  emit: (path: string, text: string) => Promise<void>
  call: (command: string, background?: boolean) => Promise<void>
  hold: (command: string) => { release: () => void; done: Promise<void> }
  clock: ReturnType<typeof mock.clock>
  buttons: () => Promise<string[]>
  header: () => Promise<string>
  lines: () => Promise<string[]>
  setPlaced: (isPlaced: boolean) => void
}

function rig($: Engine, on: On): Rig {
  const clock = mock.clock(on, { now: 1_000_000 })
  const spawned: string[] = []
  const seen = { argv: [] as readonly string[] }
  const queues = new Map<string, { push: (text: string) => void }>()
  const gates: Promise<void>[] = []
  let isPlaced = true
  let holdNext: Promise<void> | null = null

  on('session.cwd', () => ({ value: CWD }))
  on('command.register', () => ({ value: { command: 'logpane' } }))
  on('session.start', () => ({ cwd: CWD }))
  on('ui.open', () => ({ value: isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'too narrow' } }))
  on('ui.close', () => ({ value: undefined }))
  on('tool.call', { tool: 'Bash' }, async () => {
    const gate = holdNext
    holdNext = null
    if (gate) await gate

    return { result: { stdout: '', stderr: '', interrupted: false }, text: 'ok', isReadOnly: false } as never
  })
  on('process.spawn', async function* (_$, e) {
    const path = e.argv[e.argv.length - 1]
    spawned.push(path)
    seen.argv = e.argv
    const pending: string[] = []
    let wake: (() => void) | null = null
    queues.set(path, {
      push: text => {
        pending.push(text)
        wake?.()
      },
    })
    for (;;) {
      while (pending.length > 0) yield { stream: 'stdout' as const, text: pending.shift()! }
      await new Promise<void>(resolve => (wake = resolve))
    }
  })

  const toolCall = (command: string, background = false) =>
    $.tool.call({ tool: 'Bash', tool_use_id: 'tu', command, run_in_background: background } as never)

  return {
    $,
    spawned,
    get argv() {
      return seen.argv
    },
    clock,
    setPlaced: value => (isPlaced = value),
    emit: async (path, text) => {
      queues.get(path)!.push(text)
      await clock.advance(0)
    },
    call: async (command, background) => void (await toolCall(command, background)),
    hold: command => {
      let release!: () => void
      holdNext = new Promise<void>(resolve => (release = resolve))
      gates.push(holdNext)
      return { release, done: toolCall(command).then(() => undefined) }
    },
    buttons: async () => {
      const ui = await mountPane($)
      const all = await ui.findAll({ type: 'Button' })
      await ui.unmount()
      return all.map(b => String(b.props.label))
    },
    header: async () => {
      const ui = await mountPane($)
      const text = (await ui.findAll({ type: 'Text' })).map(t => t.text).find(t => /^(live|ended):/.test(t)) ?? ''
      await ui.unmount()
      return text
    },
    lines: async () => {
      const ui = await mountPane($)
      const all = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => !/^(live|ended):/.test(t))
      await ui.unmount()
      return all
    },
  }
}

const mountPane = ($: Engine) =>
  $.ui.mount({
    plugin: 'logpane',
    surface: 'terminal',
    component: 'Pane',
    props: {} as never,
    requestId: 'logpane',
    viewport: { columns: 120, rows: 40 },
  })

const start = async (r: Rig) => {
  await r.$.session.start({ source: 'startup', cwd: CWD } as never)
}
const open = (r: Rig) => r.$.command.run({ command: 'logpane', args: '', origin: { kind: 'composer' }, presentation: {} } as never)
// The test engine cannot raise ui.close itself; a plugin closing the pane does.
const closer = {
  name: 'closer',
  register: ((on: On) => {
    on('command.run', { command: 'closepane' }, async $ => {
      await $.ui.close({ id: 'logpane' })

      return {}
    })
  }) as never,
}
const esc = (r: Rig) =>
  r.$.command.run({ command: 'closepane', args: '', origin: { kind: 'composer' }, presentation: {} } as never)

const table: [string, string[]][] = [
  ['make > build.log', ['/work/build.log']],
  ['make >> build.log', ['/work/build.log']],
  ['make | tee out.log', ['/work/out.log']],
  ['make | tee -a out.log', ['/work/out.log']],
  ['make > a.log 2> b.log', ['/work/a.log', '/work/b.log']],
  ['make &> f.log', ['/work/f.log']],
  ['make &>> f.log', ['/work/f.log']],
  ['make 1> f.log', ['/work/f.log']],
  ['make >| f.log', ['/work/f.log']],
  ['make | tee -a -i -p x.log y.log', ['/work/x.log', '/work/y.log']],
  ['make > "my build.log"', ['/work/my build.log']],
  ["make > 'a b.log'", ['/work/a b.log']],
  ['make > ../up.log', ['/up.log']],
  ['a && b > one.log; c | tee two.log', ['/work/one.log', '/work/two.log']],
  ['make > /dev/null 2>&1', []],
  ['make > /dev/stdout 2> /dev/stderr', []],
  ['make > /dev/tty', []],
  ['make 2>&1', []],
  ['make > $LOG', []],
  ['make > ~/x.log', []],
  ['make > logs/*.log', []],
  ['make > a?.log', []],
  ['make > `name`.log', []],
  ['echo $(cat > hidden.log)', []],
  ['echo `cat > hidden.log`', []],
  ['cat <<EOF\nx > nope.log\nEOF', []],
  ['ls -la', []],
]

for (const [command, expected] of table) {
  test(`tails ${JSON.stringify(command)} -> ${expected.join(', ') || 'nothing'}`, async ($, on) => {
    const r = rig($, on)
    await start(r)
    await r.call(command)
    expect(r.spawned).toEqual(expected)
  })
}

test('tails the last 200 lines with -F', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('make > a.log')
  expect(r.argv.slice(0, 4)).toEqual(['tail', '-n', '200', '-F'])
})

test('/logpane opens a focused pane listing live files', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('make > build.log', true)
  await r.emit('/work/build.log', 'hi\n')
  const result = await open(r)
  expect(result.text).toBeUndefined()
  expect(await r.buttons()).toEqual(['● build.log'])
})

test('keeps the last 300 lines and shows the live header', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('make > build.log', true)
  await r.emit('/work/build.log', Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n') + '\n')
  expect(await r.buttons()).toEqual(['● build.log'])
  expect(await r.header()).toBe('live: build.log')
  const shown = await r.lines()
  expect(shown.at(-1)).toBe('line 399')
  expect(shown.includes('line 99')).toBe(false)
})

test('a foreground call keeps the file live until it resolves', async ($, on) => {
  const r = rig($, on)
  await start(r)
  const held = r.hold('make > build.log')
  await r.clock.advance(60_000)
  expect(await r.buttons()).toEqual(['● build.log'])
  held.release()
  await held.done
  await r.clock.advance(21_000)
  expect(await r.buttons()).toEqual(['○ build.log'])
  expect(await r.header()).toBe('ended: build.log')
})

test('a background call is live only while output arrives', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('make > build.log', true)
  expect(await r.buttons()).toEqual(['○ build.log'])
  await r.emit('/work/build.log', 'hi\n')
  expect(await r.buttons()).toEqual(['● build.log'])
  await r.clock.advance(19_000)
  expect(await r.buttons()).toEqual(['● build.log'])
  await r.clock.advance(2_000)
  expect(await r.buttons()).toEqual(['○ build.log'])
})

test('follows the newest file until a button pins one', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('a > one.log', true)
  await r.call('a > two.log', true)
  expect(await r.header()).toMatch(/two\.log$/)
  const ui = await mountPane($)
  await ui.press({ key: (await ui.findAll({ type: 'Button' }))[0].key! } as never)
  await ui.unmount()
  expect(await r.header()).toMatch(/one\.log$/)
  await r.call('a > three.log', true)
  expect(await r.header()).toMatch(/one\.log$/)
})

test('buttons carry the 1 to 8 hotkeys', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('a > one.log', true)
  await r.call('a > two.log', true)
  const ui = await mountPane($)
  const hotkeys = (await ui.findAll({ type: 'Button' })).map(b => b.props.hotkey)
  await ui.unmount()
  expect(hotkeys).toEqual(['1', '2'])
})

test('Esc and ui.close drop ended files and keep live ones', { plugins: [closer] }, async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('a > old.log', true)
  await r.emit('/work/old.log', 'x\n')
  await r.clock.advance(30_000)
  await r.call('a > fresh.log', true)
  await r.emit('/work/fresh.log', 'y\n')
  await esc(r)
  expect(await r.buttons()).toEqual(['● fresh.log'])
})

test('/logpane again clears stale files and resets the pin', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('a > old.log', true)
  await r.emit('/work/old.log', 'x\n')
  await r.clock.advance(30_000)
  await r.call('a > live.log', true)
  await r.emit('/work/live.log', 'y\n')
  await r.call('a > newest.log', true)
  await r.emit('/work/newest.log', 'z\n')
  const ui = await mountPane($)
  await ui.press({ key: (await ui.findAll({ type: 'Button' }))[1].key! } as never)
  await ui.unmount()
  await open(r)
  expect(await r.buttons()).toEqual(['● live.log', '● newest.log'])
  expect(await r.header()).toBe('live: newest.log')
})

test('evicts the oldest file at the ninth', async ($, on) => {
  const r = rig($, on)
  await start(r)
  for (let i = 1; i <= 9; i++) {
    await r.call(`a > f${i}.log`, true)
    await r.clock.advance(10)
  }
  const labels = await r.buttons()
  expect(labels).toHaveLength(8)
  expect(labels.some(label => label.includes('f1.log'))).toBe(false)
  expect(labels.some(label => label.includes('f9.log'))).toBe(true)
})

test('shows dir/basename when names collide', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('a > x/build.log', true)
  await r.call('a > y/build.log', true)
  await r.call('a > other.log', true)
  expect(await r.buttons()).toEqual(['○ x/build.log', '○ y/build.log', '○ other.log'])
})

test('tells the person when the pane cannot be placed', async ($, on) => {
  const r = rig($, on)
  await start(r)
  r.setPlaced(false)
  const result = await open(r)
  expect(result.text).toContain('could not be placed')
  expect(result.text).toContain('too narrow')
})

test('the Bash result still reaches the transcript', async ($, on) => {
  const r = rig($, on)
  await start(r)
  const result = await $.tool.call({ tool: 'Bash', tool_use_id: 'tu', command: 'make > a.log' } as never)
  expect((result as { text?: string }).text).toBe('ok')
})

test('tracking runs without /logpane having been run', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('make > a.log')
  expect(r.spawned).toEqual(['/work/a.log'])
})
