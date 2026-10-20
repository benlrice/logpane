# logpane

> Watch the files your Bash commands write to, without a second terminal.

logpane is a Claude Code mod. When a Bash command redirects output to a `.log` file, logpane tails that file. A band above the prompt lists the files, and a pane shows the lines of one file.

![logpane](docs/logpane.png)

For example, run `make > build.log 2>&1` through Claude Code and watch `build.log` fill in the pane.

## Features

- **Automatic.** logpane reads each Bash command before it runs and tracks the files it writes to.
- **Live or ended.** Each file shows `●` while a process is writing to it and `○` when it ends.
- **Background jobs.** Output from a command that returned at once stays visible while its process runs.
- **No settings.** Nothing to configure.

## Install

To try logpane from a clone:

```
claude --plugin-dir ~/git/logpane
```

To install it for normal use:

```
/plugin install logpane --marketplace benlrice/logpane
```

Enter `y` to add the marketplace, then select a scope.

## Usage

logpane starts with the session. There is nothing to launch.

### The band

The band opens by itself when a tracked file goes live. It is one row above the prompt, with one button per file (for example `1 ● build.log  2 ○ test.log`) and a `✕` button.

- Click a button, or press its number key, to open the pane on that file. The number keys work when the band has the keyboard: press `ctrl+x` then `Tab`, or click the band.
- Press `✕` to dismiss the band. It stays hidden until a tracked file goes live again or a new Bash command writes to a tracked file.
- The band hides when no file is live. It never shares the screen with the pane.

### The pane

The pane opens when you press a band button or enter `/logpane`. It never opens by itself. It has:

- One button per tracked file. If two files share a name, the button shows `dir/name`.
- A header, `live: <name>` or `ended: <name>`.
- The last lines of the selected file.

The pane shows the newest file until you press a button or number key. Then it keeps your selection.

| Key | Action |
| --- | --- |
| Tab or arrow keys, then Enter | Move between the buttons and press one. |
| 1 to 8 | Select the file with that number. |
| m | Maximize the pane. Press again to restore it. |
| Esc | Close the pane and remove ended files. The band returns if a file is live. |

Entering `/logpane` again removes ended files, clears your selection, and opens the pane with the keyboard focus.

### How live is decided

logpane checks every 2 seconds with one `lsof` call. A file is live while a process has it open for writing, or while a foreground Bash command runs against it. A new command, or output in the last 4 seconds, also keeps a file live, so short writes between checks are not missed.

> [!NOTE]
> Without `lsof`, a file is live for 20 seconds after its last output.

## Which files logpane tracks

| Command | Tracked files |
| --- | --- |
| `cmd > out.log`, `cmd >> out.log` | `out.log` |
| `cmd \| tee out.log`, `cmd \| tee -a out.log` | `out.log` |
| `cmd > a.log 2> b.log` | `a.log`, `b.log` |
| `&> f.log`, `&>> f.log`, `1> f.log`, `>\| f.log` | `f.log` |
| `tee [-a -i -p] f1.log f2.log ...` | Each file operand that ends in `.log` |
| `> "my build.log"`, `> 'a b.log'` | The quoted path |
| `a && b > x.log; c \| tee y.log` | `x.log`, `y.log` |
| `cmd > out.json`, `cmd \| tee notes.md`, `cmd > .log` | None (the name must end in `.log`) |
| `2>&1` and other fd duplications | None |
| `/dev/null`, `/dev/stdout`, any other path under `/dev` or `/proc` | None |
| A path with `$VAR`, `~`, a backtick, `*` or `?` | None (logpane cannot expand it) |
| A redirect in `$(...)`, in backticks or in a heredoc body | None |

If logpane cannot read part of a command, it skips that part and does not guess. Relative paths resolve from the session's working directory. logpane uses `tail -F`, so a file that does not exist yet, or that is truncated or rotated, is followed.

> [!TIP]
> To watch other output, send it to a `.log` file.

## Limits

- Only names that end in `.log`, in upper or lower case, are tracked. `build.log.1`, `app.log.gz` and a file named only `.log` are not.
- At most 8 files at once. When a ninth arrives, logpane removes the one attached longest ago and stops its tail.
- Each file starts from its last 200 lines. logpane keeps the last 300 lines.
- logpane reads only the redirects in the command text. It does not follow files a program opens by itself, shell variables, globs, `cd` in a compound command, or command substitutions.
- Any process with the file open for writing counts as live, not only the command logpane saw. This needs `lsof`.
- No scrollback past 300 lines, no search, no filter, no automatic pane open and no status-line hint.

## Development

To check and test the mod:

```
claude plugin validate .
claude plugin test .
```
