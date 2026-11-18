# web

The Soldar web app: a Vue 3 + Vite + Pinia editor with a Vue Flow canvas.
The server (`apps/server`) serves the built app; there is no separate web
server in production.

## Run it

```sh
pnpm --filter @soldar/web dev    # development server (proxies /api to :5678)
pnpm --filter @soldar/web build  # production build into dist/
pnpm --filter @soldar/web test:e2e   # Playwright end-to-end suite (needs pnpm build first)
```

## Layout

- `src/views/` — the three pages: `WorkflowList.vue` (home: create,
  duplicate, export, import), `Editor.vue` (the canvas + settings + run
  panel), `Executions.vue` (run history with totals and per-run delete),
  `Help.vue` (the in-app guide).
- `src/components/` — `NodePalette.vue`, `SoldarNode.vue`,
  `NodeSettings.vue` (per-node settings + the IF condition builder),
  `ConditionBuilder.vue`, `ExecutionPanel.vue`, `UpdateDialog.vue`,
  `AppMenu.vue`, `ConfirmDialog.vue`.
- `src/stores/` — Pinia stores: `workflows.ts`, `executions.ts`,
  `updates.ts`.
- `src/api.ts` — the API client (30 s timeout, longer for downloads).
- `src/steps.ts` — defensive parsing of stored run steps.
- `src/useNow.ts` — a ticking clock for live run durations.
- `tests/` — Playwright specs, run against the production build.

## Notes

- The theme is the workbench: dark bench (`#17191d`), copper accents
  (`#c97e3f`). UI copy is plain words, no em-dashes.
- The editor never imports the engine package at runtime (it pulls in
  Node-only modules); it imports the `Workflow` type only, and the
  server does the real validation.
- `public/manifest.webmanifest` carries the PWA metadata;
  `index.html` sets the theme colour.
