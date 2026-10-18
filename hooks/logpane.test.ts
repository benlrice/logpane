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
  opens: { rows?: number; columns?: number }[]
  /** Paths a fake process has open for writing, as lsof reports them. */
  writers: Set<string>
  /** Paths a fake process has open for reading and writing. */
  updaters: Set<string>
  /** The paths of each lsof call. */
  probes: string[][]
  /** Make lsof fail to start, as when it is not installed. */
  noLsof: () => void
  /** A process starts writing to the file; the next probe sees it. */
  live: (path: string) => Promise<void>
  /** The process writing to the file exits. */
  end: (path: string) => Promise<void>
}

function rig($: Engine, on: On): Rig {
  const clock = mock.clock(on, { now: 1_000_000 })
  const spawned: string[] = []
  const seen = { argv: [] as readonly string[] }
  const queues = new Map<string, { push: (text: string) => void }>()
  const gates: Promise<void>[] = []
  let isPlaced = true
  const opens: { rows?: number; columns?: number }[] = []
  let holdNext: Promise<void> | null = null
  const writers = new Set<string>()
  const updaters = new Set<string>()
  const probes: string[][] = []
  let hasLsof = true

  on('session.cwd', () => ({ value: CWD }))
  on('command.register', () => ({ value: { command: 'logpane' } }))
  on('session.start', () => ({ cwd: CWD }))
  on('ui.open', (_$, e) => {
    opens.push(e as never)

    return { value: isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'too narrow' } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('tool.call', { tool: 'Bash' }, async () => {
    const gate = holdNext
    holdNext = null
    if (gate) await gate

    return { result: { stdout: '', stderr: '', interrupted: false }, text: 'ok', isReadOnly: false } as never
  })
  on('process.spawn', async function* (_$, e) {
    if (e.argv[0] === 'lsof') {
      if (!hasLsof) throw new Error('spawn lsof ENOENT')
      const targets = e.argv.slice(e.argv.indexOf('--') + 1)
      probes.push(targets)
      yield {
        stream: 'stdout' as const,
        text: targets.map(t => `p1\nf1\na${updaters.has(t) ? 'u' : writers.has(t) ? 'w' : 'r'}\nn${t}\n`).join(''),
      }

      return { value: { code: 0 } } as never
    }
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
    opens,
    writers,
    updaters,
    probes,
    live: async path => {
      writers.add(path)
      await clock.advance(2_000)
    },
    end: async path => {
      writers.delete(path)
      await clock.advance(2_000)
    },
    noLsof: () => (hasLsof = false),
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
      return all.filter(b => !['m'].includes(String(b.props.hotkey))).map(b => String(b.props.label))
    },
    header: async () => {
      const ui = await mountPane($)
      const text = (await ui.findAll({ type: 'Text' })).map(t => t.text).find(t => /^(live|ended):/.test(t)) ?? ''
      await ui.unmount()
      return text
    },
    lines: async () => {
      const ui = await mountPane($, 1000)
      const all = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => !/^(live|ended):/.test(t))
      await ui.unmount()
      return all
    },
  }
}

const mountPane = ($: Engine, rows = 40) =>
  $.ui.mount({
    plugin: 'logpane',
    surface: 'terminal',
    component: 'Pane',
    props: {} as never,
    requestId: 'logpane',
    viewport: { columns: 120, rows },
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
  ['cat > src/app.ts <<EOF\nx\nEOF', []],
  ['jq . data.json > out.json', []],
  ['echo dist >> .gitignore', []],
  ['git diff > change.patch', []],
  ['make | tee notes.md', []],
  ['nohup make > nohup.out', []],
  ['make > a.log 2> errors.txt', ['/work/a.log']],
  ['make | tee notes.md test.log', ['/work/test.log']],
  ['make > BUILD.LOG', ['/work/BUILD.LOG']],
  ['make > logs/run.log', ['/work/logs/run.log']],
  ['make > build.log.1', []],
  ['make > app.log.gz', []],
  ['make > .log', []],
  ['make > logs/.log', []],
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
  await r.live('/work/build.log')
  const result = await open(r)
  expect(result.text).toBeUndefined()
  expect(await r.buttons()).toEqual(['● build.log'])
})

test('keeps the last 300 lines and shows the live header', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('make > build.log', true)
  await r.emit('/work/build.log', Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n') + '\n')
  await r.live('/work/build.log')
  expect(await r.buttons()).toEqual(['● build.log'])
  expect(await r.header()).toBe('live: build.log')
  const shown = await r.lines()
  expect(shown).toHaveLength(300)
  expect(shown[0]).toBe('line 100')
  expect(shown.at(-1)).toBe('line 399')
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

test('a background call is live only while a process writes to the file', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('make > build.log', true)
  expect(await r.buttons()).toEqual(['● build.log'])
  await r.clock.advance(5_000)
  expect(await r.buttons()).toEqual(['○ build.log'])
  await r.live('/work/build.log')
  expect(await r.buttons()).toEqual(['● build.log'])
  await r.clock.advance(60_000)
  expect(await r.buttons()).toEqual(['● build.log'])
  await r.end('/work/build.log')
  expect(await r.buttons()).toEqual(['○ build.log'])
})

test('output without a writer keeps a file live only for a short grace', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('make > build.log', true)
  await r.clock.advance(5_000)
  await r.emit('/work/build.log', 'hi\n')
  expect(await r.buttons()).toEqual(['● build.log'])
  await r.clock.advance(5_000)
  expect(await r.buttons()).toEqual(['○ build.log'])
})

test('lsof is called once for all tracked files, and not when none are tracked', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.clock.advance(4_000)
  expect(r.probes).toEqual([])
  await r.call('a > one.log', true)
  await r.call('a > two.log', true)
  r.probes.length = 0
  await r.clock.advance(2_000)
  expect(r.probes).toEqual([['/work/one.log', '/work/two.log']])
})

test('without lsof, recent output stands in for the process', async ($, on) => {
  const r = rig($, on)
  r.noLsof()
  await start(r)
  await r.call('make > build.log', true)
  await r.clock.advance(5_000)
  expect(await r.buttons()).toEqual(['○ build.log'])
  await r.emit('/work/build.log', 'hi\n')
  expect(await r.buttons()).toEqual(['● build.log'])
  await r.clock.advance(15_000)
  expect(await r.buttons()).toEqual(['● build.log'])
  await r.clock.advance(6_000)
  expect(await r.buttons()).toEqual(['○ build.log'])
})

test('follows the newest file until a button pins one', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('a > one.log', true)
  await r.call('a > two.log', true)
  expect(await r.header()).toMatch(/two\.log$/)
  const ui = await mountPane($)
  await ui.press({ key: (await ui.findAll({ type: 'Button' })).find(b => b.props.hotkey === '1')!.key! } as never)
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
  const hotkeys = (await ui.findAll({ type: 'Button' })).map(b => b.props.hotkey).filter(k => k !== 'm')
  await ui.unmount()
  expect(hotkeys).toEqual(['1', '2'])
})

test('Esc and ui.close drop ended files and keep live ones', { plugins: [closer] }, async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('a > old.log', true)
  await r.emit('/work/old.log', 'x\n')
  await r.live('/work/old.log')
  await r.end('/work/old.log')
  await r.call('a > fresh.log', true)
  await r.emit('/work/fresh.log', 'y\n')
  await r.live('/work/fresh.log')
  await esc(r)
  expect(await r.buttons()).toEqual(['● fresh.log'])
})

test('/logpane again clears stale files and resets the pin', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('a > old.log', true)
  await r.emit('/work/old.log', 'x\n')
  await r.live('/work/old.log')
  await r.end('/work/old.log')
  await r.call('a > live.log', true)
  await r.emit('/work/live.log', 'y\n')
  await r.live('/work/live.log')
  await r.call('a > newest.log', true)
  await r.emit('/work/newest.log', 'z\n')
  await r.live('/work/newest.log')
  const ui = await mountPane($)
  await ui.press({ key: (await ui.findAll({ type: 'Button' })).find(b => b.props.hotkey === '2')!.key! } as never)
  await ui.unmount()
  expect(await r.header()).toBe('live: live.log')
  await open(r)
  expect(await r.buttons()).toEqual(['● live.log', '● newest.log'])
  expect(await r.header()).toBe('live: newest.log')
})

test('a second foreground call to a known file keeps it live too', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('make > build.log')
  const held = r.hold('make > build.log')
  await r.clock.advance(60_000)
  expect(await r.buttons()).toEqual(['● build.log'])
  held.release()
  await held.done
  await r.clock.advance(21_000)
  expect(await r.buttons()).toEqual(['○ build.log'])
})

test('a command that writes no file does not change which file is followed', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('a > one.log', true)
  await r.call('a > two.log', true)
  await r.call('a > one.log', true)
  expect(await r.header()).toMatch(/one\.log$/)
  await r.call('ls')
  expect(await r.header()).toMatch(/one\.log$/)
})

test('a command that writes only non-.log files does not change which file is followed', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('a > one.log', true)
  expect(await r.header()).toMatch(/one\.log$/)
  await r.call('cat > src/app.ts <<EOF\nx\nEOF')
  await r.call('echo dist >> .gitignore', true)
  expect(await r.header()).toMatch(/one\.log$/)
  expect(await r.buttons()).toEqual(['● one.log'])
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
  await r.clock.advance(5_000)
  expect(await r.buttons()).toEqual(['○ x/build.log', '○ y/build.log', '○ other.log'])
})

test('maximize reopens the pane at max size and toggles back; no minimize button remains', async ($, on) => {
  const r = rig($, on)
  const { opens } = r
  await start(r)
  await r.call('a > one.log', true)
  const find = async (hotkey: string, act?: boolean) => {
    const ui = await mountPane($)
    const b = (await ui.findAll({ type: 'Button' })).find(x => x.props.hotkey === hotkey)!
    if (act) await ui.press({ key: b.key! } as never)
    await ui.unmount()
    return String(b.props.label)
  }
  expect(await find('m')).toBe('□')
  await find('m', true)
  expect(opens.at(-1)).toMatchObject({ rows: 52, columns: 156 })
  expect(await find('m')).toBe('❐')
  await find('m', true)
  expect(opens.at(-1)?.rows).toBeUndefined()
  const ui = await mountPane($)
  expect((await ui.findAll({ type: 'Button' })).some(b => b.props.hotkey === 'n')).toBe(false)
  await ui.unmount()
  expect(await find('m')).toBe('□')
})

const mountBand = ($: Engine, props: { hasSurvey?: boolean; maxRows?: number } = {}) =>
  $.ui.mount({
    plugin: 'logpane',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, ...props } as never,
    viewport: { columns: 120, rows: 40 },
  })

// A hidden band yields with next(e); with nothing beneath, the test engine refuses the mount.
const band = async ($: Engine, props?: { hasSurvey?: boolean; maxRows?: number }) => {
  const ui = await mountBand($, props).catch(error => {
    if (String(error).includes('no implementation for ui.render')) return null
    throw error
  })
  if (!ui) return { buttons: [], texts: [] }
  const buttons = (await ui.findAll({ type: 'Button' })).map(b => String(b.props.label))
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()
  return { buttons, texts }
}

const pressBand = async ($: Engine, match: (b: { props: Record<string, unknown> }) => boolean) => {
  const ui = await mountBand($)
  const b = (await ui.findAll({ type: 'Button' })).find(match as never)!
  await ui.press({ key: b.key! } as never)
  await ui.unmount()
}
const byLabel = (label: string) => (b: { props: Record<string, unknown> }) => b.props.label === label

test('the band appears on the first line and shows only file buttons', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('make > build.log', true)
  await r.clock.advance(5_000)
  expect(await band($)).toEqual({ buttons: [], texts: [] })
  await r.emit('/work/build.log', 'a\nb\nc\n')
  await r.live('/work/build.log')
  await r.live('/work/build.log')
  expect(await band($)).toEqual({ buttons: ['1 ● build.log', '✕'], texts: [] })
})

test('the band shows for a foreground call and stays while it runs', async ($, on) => {
  const r = rig($, on)
  await start(r)
  const held = r.hold('make > build.log')
  await r.clock.advance(60_000)
  expect((await band($)).buttons).toEqual(['1 ● build.log', '✕'])
  held.release()
  await held.done
  await r.clock.advance(21_000)
  expect(await band($)).toEqual({ buttons: [], texts: [] })
})

test('the band hides when the process exits and files stay tracked', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('make > build.log', true)
  await r.emit('/work/build.log', 'a\n')
  await r.live('/work/build.log')
  await r.end('/work/build.log')
  expect(await band($)).toEqual({ buttons: [], texts: [] })
  expect(await r.buttons()).toEqual(['○ build.log'])
})

test('the band yields to a survey and to a zero-row allowance', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('make > build.log', true)
  await r.emit('/work/build.log', 'a\n')
  await r.live('/work/build.log')
  expect(await band($, { hasSurvey: true })).toEqual({ buttons: [], texts: [] })
  expect(await band($, { maxRows: 0 })).toEqual({ buttons: [], texts: [] })
  expect((await band($, { maxRows: 1 })).buttons).toEqual(['1 ● build.log', '✕'])
})

test('band buttons mark live and ended and carry the 1 to 8 hotkeys', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('a > one.log', true)
  await r.emit('/work/one.log', 'first\n')
  await r.live('/work/one.log')
  await r.end('/work/one.log')
  await r.call('a > two.log', true)
  await r.emit('/work/two.log', 'second\n')
  await r.live('/work/two.log')
  expect((await band($)).buttons).toEqual(['1 ○ one.log', '2 ● two.log', '✕'])
  const ui = await mountBand($)
  const hotkeys = (await ui.findAll({ type: 'Button' })).map(b => b.props.hotkey).filter(Boolean)
  await ui.unmount()
  expect(hotkeys).toEqual(['1', '2'])
})

test('band shows dir/basename when names collide', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('a > x/build.log', true)
  await r.call('a > y/build.log', true)
  const held = r.hold('a > other.log')
  await r.clock.advance(5_000)
  expect((await band($)).buttons).toEqual(['1 ○ x/build.log', '2 ○ y/build.log', '3 ● other.log', '✕'])
  held.release()
  await held.done
})

test('pressing a band file opens the pane at normal size on that file and hides the band', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('a > one.log', true)
  await r.emit('/work/one.log', 'first\n')
  await r.live('/work/one.log')
  await r.call('a > two.log', true)
  await r.emit('/work/two.log', 'second\n')
  await r.live('/work/two.log')
  await pressBand($, byLabel('1 ● one.log'))
  expect(r.opens.at(-1)).toMatchObject({ id: 'logpane', focus: true, closeOnEscape: true })
  expect(r.opens.at(-1)?.rows).toBeUndefined()
  expect(await r.header()).toBe('live: one.log')
  expect(await band($)).toEqual({ buttons: [], texts: [] })
})

test('/logpane hides the band', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('make > build.log', true)
  await r.emit('/work/build.log', 'a\n')
  await r.live('/work/build.log')
  await open(r)
  expect(await band($)).toEqual({ buttons: [], texts: [] })
})

test('closing the pane returns to the band when a file is live', { plugins: [closer] }, async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('make > build.log', true)
  await r.emit('/work/build.log', 'a\n')
  await r.live('/work/build.log')
  await open(r)
  await esc(r)
  expect((await band($)).buttons).toEqual(['1 ● build.log', '✕'])
})

test('closing the pane with no live file shows no band', { plugins: [closer] }, async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('make > build.log', true)
  await r.emit('/work/build.log', 'a\n')
  await r.live('/work/build.log')
  await open(r)
  await r.end('/work/build.log')
  await esc(r)
  expect(await band($)).toEqual({ buttons: [], texts: [] })
})

test('pressing a band file keeps the band when the pane cannot be placed', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('make > build.log', true)
  await r.emit('/work/build.log', 'a\n')
  await r.live('/work/build.log')
  r.setPlaced(false)
  await pressBand($, byLabel('1 ● build.log'))
  expect((await band($)).buttons).toEqual(['1 ● build.log', '✕'])
})

test('dismiss hides the band until a file goes from ended to live', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('a > one.log', true)
  await r.emit('/work/one.log', 'x\n')
  await r.live('/work/one.log')
  await pressBand($, byLabel('✕'))
  expect(await band($)).toEqual({ buttons: [], texts: [] })
  await r.emit('/work/one.log', 'y\n')
  await r.live('/work/one.log')
  expect(await band($)).toEqual({ buttons: [], texts: [] })
  expect(await r.buttons()).toEqual(['● one.log'])
  await r.end('/work/one.log')
  await r.emit('/work/one.log', 'z\n')
  await r.live('/work/one.log')
  expect((await band($)).buttons).toEqual(['1 ● one.log', '✕'])
})

test('dismiss: a new Bash call that attaches a file brings the band back', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('a > one.log', true)
  await r.emit('/work/one.log', 'x\n')
  await r.live('/work/one.log')
  await pressBand($, byLabel('✕'))
  await r.call('a > two.log', true)
  await r.emit('/work/two.log', 'w\n')
  await r.live('/work/two.log')
  expect((await band($)).buttons).toEqual(['1 ● one.log', '2 ● two.log', '✕'])
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

test('a process with the file open for reading and writing keeps it live', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('make > build.log', true)
  r.updaters.add('/work/build.log')
  await r.clock.advance(60_000)
  expect(await r.buttons()).toEqual(['● build.log'])
})

test('a process that only reads the file does not keep it live', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('make > build.log', true)
  await r.clock.advance(60_000)
  expect(await r.buttons()).toEqual(['○ build.log'])
})

test('a dismissed band returns when lsof shows a writer on an ended file', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('a > one.log', true)
  await r.live('/work/one.log')
  await pressBand($, byLabel('✕'))
  expect(await band($)).toEqual({ buttons: [], texts: [] })
  await r.end('/work/one.log')
  await r.clock.advance(10_000)
  expect(await r.buttons()).toEqual(['○ one.log'])
  await r.live('/work/one.log')
  expect((await band($)).buttons).toEqual(['1 ● one.log', '✕'])
})

test('a band file press resets a maximized pane to normal size', { plugins: [closer] }, async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('a > one.log', true)
  await r.live('/work/one.log')
  await open(r)
  const ui = await mountPane($)
  await ui.press({ key: (await ui.findAll({ type: 'Button' })).find(b => b.props.hotkey === 'm')!.key! } as never)
  await ui.unmount()
  expect(r.opens.at(-1)?.rows).toBe(52)
  await esc(r)
  await pressBand($, byLabel('1 ● one.log'))
  const pane = await mountPane($)
  const label = String((await pane.findAll({ type: 'Button' })).find(b => b.props.hotkey === 'm')!.props.label)
  await pane.unmount()
  expect(label).toBe('□')
})

test('a band file press that cannot place the pane keeps the earlier selection', async ($, on) => {
  const r = rig($, on)
  await start(r)
  await r.call('a > one.log', true)
  await r.call('a > two.log', true)
  await r.live('/work/one.log')
  await r.live('/work/two.log')
  expect(await r.header()).toBe('live: two.log')
  r.setPlaced(false)
  await pressBand($, byLabel('1 ● one.log'))
  expect(await r.header()).toBe('live: two.log')
})

test('one of two foreground calls to a file ending leaves the other live', async ($, on) => {
  const r = rig($, on)
  await start(r)
  const first = r.hold('make > build.log')
  await r.clock.advance(0)
  const second = r.hold('make > build.log')
  await r.clock.advance(60_000)
  first.release()
  await first.done
  await r.clock.advance(60_000)
  expect(await r.buttons()).toEqual(['● build.log'])
  second.release()
  await second.done
})

test('a retried attach stops the tail only of files evicted by the final run', async ($, on) => {
  // Another write lands between the attach's read and its write, so the
  // updater runs twice: f1 is the oldest the first time, f2 the second.
  let raced = false
  let armed = false
  on('state.set', { plugin: 'logpane', key: 'files' } as never, async (_$, e, next) => {
    if (!armed || raced) return next(e)
    raced = true
    // Land the other write in place of this one and report this one as beaten.
    const list = (e as never as { previous: { path: string; attachedAt: number }[] }).previous
    const landed = await next({
      ...e,
      value: list.map(f => (f.path === '/work/f1.log' ? { ...f, attachedAt: f.attachedAt + 1_000_000 } : f)),
    } as never)

    return { value: { ...(landed as never as { value: object }).value, isSet: false } } as never
  })
  const r = rig($, on)
  await start(r)
  for (let i = 1; i <= 8; i++) {
    await r.call(`a > f${i}.log`, true)
    await r.clock.advance(10)
  }
  armed = true
  await r.call('a > f9.log', true)
  expect(raced).toBe(true)
  const ui = await mountPane($)
  const f1 = (await ui.findAll({ type: 'Button' })).find(b => String(b.props.label).includes('f1.log'))
  expect(f1).toBeDefined()
  await ui.press({ key: f1!.key! } as never)
  await ui.unmount()
  await r.emit('/work/f1.log', 'still tailed\n')
  expect(await r.lines()).toContain('still tailed')
})
