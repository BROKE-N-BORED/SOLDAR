# Changelog

## 0.4.0

The automation update: workflows now run on their own.

- New Schedule Trigger node. Give it a schedule pattern (like every
  day at 9 AM) and the workflow runs at those times, as long as the
  workflow is Active. The node's settings explain the pattern with
  examples. A pattern that does not parse is refused when you save,
  with the reason in plain words.
- New Webhook Trigger node. A workflow gets its own web address
  (Soldar's address plus /webhook/ and an ending). A request to that
  address starts a run with the request data, and the caller gets the
  run's result back. Leave the ending empty and Soldar makes up a
  random one when you save, so addresses cannot be guessed.
- The Active switch works now, in the editor and in the workflow
  list. Active workflows run their schedules and answer their
  webhooks; inactive ones only run when you press Run. Schedules pick
  back up on their own after a restart. Run history says what started
  each run: manual, schedule, or webhook.
- Nodes that are not wired to a trigger no longer run. Before, a
  loose node sitting on the canvas ran anyway, and if it failed it
  failed the whole run. Now it is skipped, and its step in the run
  panel says why: "Not wired to the trigger, so this node did not
  run." A node on a branch that carried nothing says the same kind of
  thing. A workflow with no trigger node at all cannot run, and
  pressing Run says so in plain words instead of failing strangely.

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
