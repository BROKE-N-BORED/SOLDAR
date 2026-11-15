# Soldar

A workflow automation app for Linux, in the shape of n8n: a visual canvas of
nodes, an execution engine, schedules, and webhooks. Built from scratch in
TypeScript. Runs on one PC.

## Status

Phase 1 — engine + CLI. The engine runs workflows from the terminal and
stores each run in SQLite. No web UI or server yet (Phase 2).

Nodes: Manual Trigger, Set, IF, Code, HTTP Request.

## Run a workflow

```
pnpm install
pnpm run flow run examples/hello-workflow.json
```

The run is stored in `./soldar.db` (created on first run). Use `--db <path>`
to store it somewhere else, `--json` to print the full run result, and
`--trigger-data '<json>'` to hand items to the trigger nodes.

## Run the tests

```
pnpm install
pnpm test
```

## License

MIT
