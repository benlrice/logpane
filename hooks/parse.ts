// Finds the files a shell command line routes output to. No shell runs here:
// anything that needs expansion is skipped rather than guessed.

const IGNORED =
  /^\/(dev\/(null|zero|full|stdin|stdout|stderr|tty\d*|fd\/.*|pts\/.*)|proc\/.*)$/
const LOG_NAME = /[^/]\.log$/i
const UNSAFE = /[$`*?\\{]/
const KEYWORDS = new Set(['{', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

type Mode = 'none' | 'target' | 'skip'

export function extractTargets(command: string): string[] {
  const found: string[] = []
  const heredocs: { delimiter: string; isTabbed: boolean }[] = []
  let word = ''
  let hasWord = false
  let mode: Mode = 'none'
  let isCommand = true
  let isTee = false
  let isFlagsDone = false

  const add = (text: string) => {
    const isUnsafe = text === '' || UNSAFE.test(text) || text.startsWith('~')
    const isTracked = LOG_NAME.test(text.split('/').pop()!)
    if (!isUnsafe && isTracked && !IGNORED.test(text) && !found.includes(text)) found.push(text)
  }

  const endWord = () => {
    if (!hasWord) return
    const text = word
    word = ''
    hasWord = false

    if (mode === 'target') {
      mode = 'none'
      add(text)
    } else if (mode === 'skip') {
      mode = 'none'
    } else if (isCommand) {
      if (KEYWORDS.has(text) || ASSIGNMENT.test(text)) return
      isCommand = false
      isTee = text.split('/').pop() === 'tee'
    } else if (isTee) {
      if (!isFlagsDone && text.startsWith('-') && text !== '-') {
        if (text === '--') isFlagsDone = true
      } else if (text !== '-') {
        add(text)
      }
    }
  }

  const separate = () => {
    endWord()
    mode = 'none'
    isCommand = true
    isTee = false
    isFlagsDone = false
  }

  const skipBalanced = (from: number, open: string, close: string): number => {
    let depth = 0
    let i = from
    for (; i < command.length; i++) {
      const c = command[i]
      if (c === "'" || c === '"') {
        const end = command.indexOf(c, i + 1)
        if (end === -1) return command.length
        i = end
      } else if (c === open) depth++
      else if (c === close && --depth === 0) return i + 1
    }
    return command.length
  }

  const skipHeredocBodies = (from: number): number => {
    let i = from
    for (const { delimiter, isTabbed } of heredocs) {
      while (i < command.length) {
        let end = command.indexOf('\n', i)
        if (end === -1) end = command.length
        const line = command.slice(i, end)
        i = Math.min(end + 1, command.length)
        if ((isTabbed ? line.replace(/^\t+/, '') : line) === delimiter) break
      }
    }
    heredocs.length = 0
    return i
  }

  const readDelimiter = (from: number): number => {
    let i = from
    let isTabbed = false
    if (command[i] === '-') {
      isTabbed = true
      i++
    }
    while (command[i] === ' ' || command[i] === '\t') i++
    let delimiter = ''
    while (i < command.length && !/[\s;&|<>()]/.test(command[i])) {
      if (command[i] !== "'" && command[i] !== '"' && command[i] !== '\\') delimiter += command[i]
      i++
    }
    heredocs.push({ delimiter, isTabbed })
    return i
  }

  for (let i = 0; i < command.length; ) {
    const c = command[i]

    if (c === ' ' || c === '\t') {
      endWord()
      i++
    } else if (c === '\n') {
      separate()
      i = heredocs.length > 0 ? skipHeredocBodies(i + 1) : i + 1
    } else if (c === '#' && !hasWord) {
      const end = command.indexOf('\n', i)
      i = end === -1 ? command.length : end
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1)
      word += command.slice(i + 1, end === -1 ? command.length : end)
      hasWord = true
      i = end === -1 ? command.length : end + 1
    } else if (c === '"') {
      let j = i + 1
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\') word += '\\'
        word += command[j === command.length ? j : command[j] === '\\' ? ++j : j]
        j++
      }
      hasWord = true
      i = j + 1
    } else if (c === '\\') {
      word += command.slice(i, i + 2)
      hasWord = true
      i += 2
    } else if (c === '`') {
      const end = command.indexOf('`', i + 1)
      word += '`'
      hasWord = true
      i = end === -1 ? command.length : end + 1
    } else if (c === '$' && (command[i + 1] === '(' || command[i + 1] === '{')) {
      word += '$'
      hasWord = true
      i = command[i + 1] === '(' ? skipBalanced(i + 1, '(', ')') : skipBalanced(i + 1, '{', '}')
    } else if (c === '(' || c === ')') {
      separate()
      i++
    } else if (c === ';') {
      separate()
      i++
    } else if (c === '|') {
      separate()
      i += command[i + 1] === '|' || command[i + 1] === '&' ? 2 : 1
    } else if (c === '&' && command[i + 1] === '&') {
      separate()
      i += 2
    } else if (c === '&' && command[i + 1] !== '>') {
      separate()
      i++
    } else if (c === '>' || c === '&' || c === '<') {
      // A bare number glued to the operator is a file descriptor (2>), not an argument.
      if (hasWord && /^\d+$/.test(word) && (c === '>' || c === '<')) {
        word = ''
        hasWord = false
      } else {
        endWord()
      }
      let op = c
      i++
      if (c === '&') {
        op = '&>'
        i++
      }
      if (op === '<') {
        if (command[i] === '<' && command[i + 1] === '<') {
          mode = 'skip'
          i += 2
        } else if (command[i] === '<') {
          i = readDelimiter(i + 1)
        } else if (command[i] === '(') {
          i = skipBalanced(i, '(', ')')
        } else {
          mode = 'skip'
        }
      } else if (command[i] === '(') {
        i = skipBalanced(i, '(', ')')
      } else {
        if (command[i] === '>' && (op === '>' || op === '&>')) i++
        else if (command[i] === '|' && op === '>') i++
        if (op === '>' && command[i] === '&') {
          i++
          mode = /[0-9-]/.test(command[i] ?? '') ? 'skip' : 'target'
        } else {
          mode = 'target'
        }
      }
    } else {
      word += c
      hasWord = true
      i++
    }
  }
  endWord()

  return found
}

export function resolvePath(cwd: string, path: string): string {
  const parts: string[] = []
  const joined = path.startsWith('/') ? path : `${cwd}/${path}`

  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }

  return `/${parts.join('/')}`
}

// Drops terminal escapes and keeps only what a carriage-return rewrite left visible.
export function cleanLine(line: string): string {
  return line
    .replace(/\r$/, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .split('\r')
    .pop()!
}

// Button text for each path: the file name, with its folder only where names collide.
export function labelsFor(paths: readonly string[]): string[] {
  const names = paths.map(path => path.split('/').pop() ?? path)

  return paths.map((path, i) => {
    if (names.filter(name => name === names[i]).length < 2) return names[i]
    const parent = path.split('/').slice(-2, -1)[0]

    return parent ? `${parent}/${names[i]}` : names[i]
  })
}
