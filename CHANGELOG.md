# Changelog

## 0.3.1

Fixes from a hands-on review of 0.3.0, driving the installed app the
way a user would:

- The phone workflow list stacks properly now: the name gets its own
  full line instead of being cut off, the details sit under it, and the
  buttons get their own row. The top menu no longer stacks or pushes
  the page sideways at phone widths.
- Dragging nodes no longer throws errors in the console, and a drag's
  final position is saved correctly.
- "Run just this node" now says, in the run panel, that the node ran
  on its own with one empty item, so its result is not mistaken for a
  full run.
- New nodes land further left, so the third node in a row no longer
  hides under the settings sidebar.
- The Set node stores a typed value like 42 as the number 42, not the
  text "42". Values that come from expressions are left as they are.
- HTTP connection failures are in plain words ("nothing answered at
  this address") instead of raw system codes, and error and help text
  was cleaned up in a few places, including the private-address refusal
  and the IF conditions help.
- The Workflow settings toggle in the editor looks like a toggle, with
  a chevron, instead of reading as the heading of everything below it.

## 0.3.0

- In-app updates: Soldar checks its GitHub Releases on launch, asks
  before downloading, verifies the release's checksum before installing,
  and asks whether to restart now or later.
- The full review task list: the HTTP node's redirect and size guards,
  the IF condition builder (no more raw JSON), required-field and
  duplicate-name checks before saving, a Stop button for runs, per-node
  runs, duplicate/export/import, per-run delete, run totals, collapsible
  panels, node icons, and a mobile tab bar.
- The installer now installs into `~/.local/soldar/app` (a stable home
  instead of wherever the ZIP was extracted), verifies the Node
  download's signature, refuses a second installer at the same time,
  and removes the build-only parts after building.
- New `stop-soldar.sh` and `uninstall.sh`.
- CI runs the suite, the typecheck, the build, and the browser tests on
  every push.

## 0.2.1

- Workflows and runs moved out of the app folder into
  `~/.config/soldar`, so reinstalling from a new ZIP no longer wipes
  them (with a migration for older installs).
- Leaving the editor with unsaved changes asks first.

## 0.2.0

- The web app: a canvas editor, run history, and a Help page, served by
  a Fastify server with live run progress over WebSocket.
- The installer: double-click to install, with a desktop icon, Node and
  pnpm fetched automatically when missing.

## 0.1.0

- The engine and the terminal runner: five node types (Manual Trigger,
  Set, IF, Code, HTTP Request), a real `{{ }}` expression parser, a
  sandboxed Code node, and SQLite storage.
