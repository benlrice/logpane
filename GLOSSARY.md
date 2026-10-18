# logpane

A mod that shows the files Claude's Bash calls write to, so you can watch long-running output while Claude works.

## Language

**Tracked file**:
A `.log` file that a Bash call redirects output to, and that logpane tails.
_Avoid_: log, watched file

**Live**:
A tracked file that a process is writing to, as best logpane can tell: a process has it open for writing, or a foreground Bash call is still running against it.
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

**Newest**:
The tracked file the most recent Bash call redirected to; with several targets, the last one.
_Avoid_: latest, top

**Shown file**:
The tracked file the pane displays: the picked file, or else the newest.

**Pick**:
The person's choice of shown file, which overrides the newest.
_Avoid_: pin

**Dismiss**:
Hiding the band until a tracked file goes live again or a Bash call redirects to one.
_Avoid_: hide, close
