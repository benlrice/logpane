# logpane

A Claude Code mod: a pane that tails the files your Bash calls write to.

Run a long build through Claude Code with `make > build.log 2>&1` and you can watch `build.log` fill without opening a second terminal.

## Install

Try it from a clone:

```
claude --plugin-dir ~/git/logpane
```

Or install it for everyday use:

```
/plugin install logpane --marketplace benlrice/logpane
```

Answer `y` to add the marketplace, then choose a scope.

## Use

Tracking starts with the session: every Bash call is read before it runs, and the files it redirects output to are tailed. Type `/logpane` to open the pane. It never opens by itself.

The pane has one button per tracked file, labelled with the file name (`dir/name` when two files share a name), then a header, `live: <name>` or `ended: <name>`, and the selected file's latest lines.

- `●` live: a foreground Bash call is routed to the file, or it was written to in the last 20 seconds.
- `○` ended.

A background command returns at once, so its file counts as live only while output keeps arriving.

### Keys

| Key | Action |
| --- | --- |
| Tab / arrows, Enter | move between buttons and press one |
| 1 to 8 | select the Nth file |
| Esc | return to the prompt and drop ended files |

The pane follows the newest file until you press a button or a number key, which pins your choice. Running `/logpane` again drops ended files, unpins, and opens focused. Closing the pane drops ended files too; live files survive.

## What counts as a target

| Command | Tracks |
| --- | --- |
| `cmd > out.log`, `cmd >> out.log` | `out.log` |
| `cmd \| tee out.log`, `cmd \| tee -a out.log` | `out.log` |
| `cmd > a.log 2> b.log` | `a.log`, `b.log` |
| `&> f`, `&>> f`, `1> f`, `>\| f` | `f` |
| `tee [-a -i -p] f1 f2 ...` | every file operand |
| `> "my build.log"`, `> 'a b.log'` | the quoted path |
| `a && b > x.log; c \| tee y.log` | `x.log`, `y.log` |
| `2>&1` and other fd duplications | nothing |
| `/dev/null`, `/dev/stdout`, `/dev/stderr`, `/dev/tty`, `/proc/*` | nothing |
| a path with `$VAR`, `~`, a backtick, `*` or `?` | nothing: it can't be expanded safely |
| a redirect inside `$(...)`, backticks or a heredoc body | nothing |

Anything the parser can't interpret is skipped, not guessed. Relative paths resolve against the session's working directory. Files that don't exist yet, are truncated or rotated are followed with `tail -F`.

## Limits

- 8 files at once; the oldest is dropped, and its tail stopped, when a ninth arrives.
- Each file starts from its last 200 lines; the last 300 lines are kept.
- Only redirects in the command text count. Programs that open their own log files, shell variables, globs, `cd` inside a compound command and command substitutions are not followed.
- Liveness is activity-based; the mod doesn't check that a process is running.
- No scrollback past 300 lines, search or filtering. No auto-open, status-line hint or settings.

## Development

```
claude plugin validate .
claude plugin test .
```

MIT licensed.
