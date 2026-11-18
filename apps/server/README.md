# server

The Soldar server: a Fastify API, a WebSocket run stream, the command-line
runner, and the static host for the built web app. One server, one user,
localhost only by default (port 5678).

## Run it

```sh
pnpm --filter @soldar/server dev     # development, with reload
pnpm --filter @soldar/server start   # the built server (needs pnpm build first)
pnpm flow run <workflow.json>        # run a workflow from the terminal (the CLI)
```

Environment:

| Variable | Meaning |
| --- | --- |
| `SOLDAR_DATA_DIR` | Where `soldar.db` and `soldar.log` live (default `~/.config/soldar`) |
| `SOLDAR_PORT` | Port to listen on (default `5678`) |
| `SOLDAR_HOST` | Interface to listen on (default `127.0.0.1`) |
| `SOLDAR_NO_UPDATE_CHECK=1` | Skip the silent startup update check (tests) |
| `SOLDAR_UPDATE_API_BASE` | Point the update check at another API root (verification only) |

## Layout

- `src/index.ts` — entry point: data dir, legacy-data migration, stale-run
  cleanup, 200-run retention, PID file, graceful shutdown.
- `src/app.ts` — builds the Fastify app and wires the routes.
- `src/routes/` — one file per route group: `workflows.ts` (CRUD, run,
  duplicate, run-node), `executions.ts` (list, cancel, delete),
  `nodes.ts` (the node catalogue, icons included), `debug.ts` (the log
  stream), `update.ts` (check / download / restart), `shutdown.ts`.
- `src/run-service.ts` — runs workflows, at most 2 at a time, with
  cancel and graceful shutdown.
- `src/update.ts` — the auto-updater: checks GitHub Releases, downloads
  the ZIP only with a matching `.sha256` sidecar, stages it, and hands
  the restart to `scripts/apply-update.sh`.
- `src/cli.ts` — `pnpm flow run`: the terminal runner (exit 0/1/2).
- `src/data-dir.ts`, `src/logger.ts`, `src/scrub.ts`, `src/trigger-data.ts`
  — data-dir rules, the log writer (secrets scrubbed), and trigger-data
  parsing.

## Tests

```sh
pnpm test                # the whole unit suite (vitest), from the repo root
```

`src/app.test.ts` covers the API end to end (in-process Fastify);
`src/update.test.ts` covers the updater against a stub API.
