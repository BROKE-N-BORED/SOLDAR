# Releasing Soldar

1. Bump the version to `X.Y.Z` in all five `package.json` files and in
   `ENGINE_VERSION` (`packages/engine/src/index.ts`, plus its test).
2. Add a `CHANGELOG.md` entry for the release.
3. Run the full checks: `pnpm test`, `pnpm run typecheck`, `pnpm build`,
   and the web end-to-end suite.
4. Push to `main` on GitHub.
5. Build the release ZIP from the pushed tree: a copy of the repo (source
   only, no `node_modules`, no `dist`) under a top-level `soldar-vX.Y.Z/`
   folder, with the executable bits set to 755 on `install.sh`,
   `soldar.sh`, `stop-soldar.sh`, `uninstall.sh`,
   `scripts/test-installer.sh`, `scripts/apply-update.sh`,
   `scripts/test-update.sh`, and `Install Soldar.desktop`. (The working
   tree keeps its own modes; set 755 in the zip staging copy.)
6. Create the Release on GitHub with tag `vX.Y.Z`, title
   `Soldar vX.Y.Z`, marked Latest, and attach TWO files:
   - `soldar-vX.Y.Z.zip`
   - `soldar-vX.Y.Z.zip.sha256` — the output of
     `sha256sum soldar-vX.Y.Z.zip`, in the usual `<hash>  <filename>`
     form.
7. Verify by downloading both assets back and comparing the hashes.

The `.sha256` sidecar is not optional: the in-app updater refuses to
install any release that does not publish one, and offers the release
page instead. A release without a sidecar still works for a manual
download-and-install, but the app will never pull it on its own.
