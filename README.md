# Soldar

A workflow automation app for Linux, in the shape of n8n: a visual canvas of
nodes, an execution engine, schedules, and webhooks. Built from scratch in
TypeScript. Runs on one PC.

## Status

Phase 2 — web UI + server. Workflows are built on a canvas in the browser,
run from the editor, and every run is stored in SQLite with per-node data.
No scheduler or webhooks yet (Phase 3).

Nodes: Manual Trigger, Set, IF, Code, HTTP Request.

## Install (no terminal)

1. Download the repo as a ZIP from https://github.com/BROKE-N-BORED/SOLDAR
   (Code -> Download ZIP) and extract it.
2. Double-click **Install Soldar** in the extracted folder.
3. When it finishes, double-click the **Soldar** icon on your desktop.

The installer gets everything Soldar needs (Node 24 and pnpm if they are
not already there), builds the app, and puts the Soldar icon on the
desktop and in the applications menu. It starts Soldar once at the end to
check the install works.

If double-clicking an icon opens a text editor instead of starting
anything, right-click the icon, choose Allow Launching, and double-click
it again.

## Run a workflow from the terminal

```
pnpm install
pnpm run flow run examples/hello-workflow.json
```

The run is stored in `./soldar.db` (created on first run). Use `--db <path>`
to store it somewhere else, `--json` to print the full run result, and
`--trigger-data '<json>'` to hand items to the trigger nodes.

## Develop

```
pnpm install
pnpm dev
```

That starts the server (http://localhost:5678) and the web app with live
reload (http://localhost:5173). `pnpm build` builds both for production;
`pnpm start` runs the built app on port 5678.

## Run the tests

```
pnpm install
pnpm test
```

The browser tests need a build first: `pnpm build`, then `pnpm test:e2e`.
The installer test runs the whole install in a scratch copy with a fake
home directory: `scripts/test-installer.sh`.

## License

MIT
