# Rayfin todo app (Cockpit.js dogfood fixture)

A minimal [Microsoft Rayfin](https://github.com/microsoft/rayfin) app used to
dogfood the Cockpit.js **Rayfin tab**.

Open a Cockpit.js session pointed at this folder. Cockpit.js detects Rayfin from
`rayfin/rayfin.yml` + the `@microsoft/rayfin*` dependencies and shows the Rayfin
tab. The dashboard renders **offline** from the committed mock files below — no
install, Docker, Fabric or login needed:

- `rayfin/rayfin.yml` — services config (auth, data dialect, static hosting).
- `rayfin/data/schema.ts`, `rayfin/data/Todo.ts` — the data model (decorators).
- `rayfin/.deployments.json` — **mock** deployments (two Fabric workspaces, one active).
- `rayfin/.env` — **mock** public `RAYFIN_PUBLIC_*` values (fabricated, no secrets).
- `rayfin/dab-config.json` — **mock** generated Data API Builder config (entity viewer source).
- `rayfin/functions/hello/` — a sample function.

> All values in the mock files are fabricated. The workspace/app URLs point at
> plausible-but-fake Microsoft Fabric resources and are safe to commit.
