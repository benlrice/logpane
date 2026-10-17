# logpane

A mod that shows the files Claude's Bash calls write to, so you can watch long-running output while Claude works.

## Language

**Tracked file**:
A file that a Bash call redirects output to, and that logpane tails.
_Avoid_: log, watched file

**Live**:
A tracked file that a process has open for writing, or that a foreground Bash call is still running against.
_Avoid_: active, running

**Ended**:
A tracked file that is not live.
_Avoid_: stale, finished

**Pane**:
The large view of one tracked file's lines, opened with `/logpane` or from the band, in the normal or maximized size.
_Avoid_: window, panel

**Band**:
One row of file buttons, drawn directly above the prompt. It appears when a tracked file goes live. A file button opens the pane on that file.
_Avoid_: strip, mini pane, minimized pane
