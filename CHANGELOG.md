# [1.2.0](https://github.com/sinedied/cockpit-js/compare/v1.1.0...v1.2.0) (2026-07-02)


### Bug Fixes

* **deps:** don't escalate stuck vulns to Copilot after a clean audit fix ([5b32fb5](https://github.com/sinedied/cockpit-js/commit/5b32fb51205ab67590cab9c2391b0cc589b6ac6b))
* **e2e:** import AppSchema in functions-app auth services ([2505d69](https://github.com/sinedied/cockpit-js/commit/2505d69bf853887e70f1a72720f2b40b6886498c))
* **rayfin:** build the data model from per-entity files ([70790fd](https://github.com/sinedied/cockpit-js/commit/70790fd85c5bc0e2127ec32cf94353d91716ea03))
* **rayfin:** record fixContext so Console "Fix with Copilot" works for Rayfin lanes ([58f41c5](https://github.com/sinedied/cockpit-js/commit/58f41c5d8bc88f3a20eb21014216ea766b00989f))
* **rayfin:** remove the unwired local-dev buttons ([762055a](https://github.com/sinedied/cockpit-js/commit/762055afce67a3cbb0b0631375cfe164224f38fd))
* **rayfin:** rename "Start local" to "Start env" ([82bf4e9](https://github.com/sinedied/cockpit-js/commit/82bf4e97d1ca533e9a0ed2b5f09a608ae4ea923d))


### Features

* **rayfin:** add real deployable e2e fixture and align mock to real schema ([bc880e6](https://github.com/sinedied/cockpit-js/commit/bc880e6861a185df56aa8ab4ff4764b958c4a592))
* **rayfin:** add real functions fixture + FunctionsSchema parser ([b1d5c69](https://github.com/sinedied/cockpit-js/commit/b1d5c6912360d83d16cfd24d290df70c3eec127c))
* **rayfin:** expand the dashboard deploy links, version + update, agent files, workspaces ([0befd03](https://github.com/sinedied/cockpit-js/commit/0befd0388149a19b217be720e789d0117fb9fddb))
* **rayfin:** rework Functions into a master-detail invoke workbench ([35be568](https://github.com/sinedied/cockpit-js/commit/35be568c738617646a9b4bf50dae5331d363b576))
* **rayfin:** rework header/Configuration layout and gate functions section ([6062722](https://github.com/sinedied/cockpit-js/commit/60627223d36bcbb2e45c5fa8364d594dac6e7bae))
* **rayfin:** rework sign-in header, 2-column config, header dev-server button ([3f89b8c](https://github.com/sinedied/cockpit-js/commit/3f89b8c48be678f435819e65f8ae6a098c5f2207)), closes [#rf-auth-btn](https://github.com/sinedied/cockpit-js/issues/rf-auth-btn) [#rf-start-env](https://github.com/sinedied/cockpit-js/issues/rf-start-env)
* **update:** apply self-updates in place with a discovery popup ([63445cb](https://github.com/sinedied/cockpit-js/commit/63445cbb9b2ff732a0743c4caf109d28aec3c441))


### Performance Improvements

* **rayfin:** make the sign-in probe non-blocking ([178a3f2](https://github.com/sinedied/cockpit-js/commit/178a3f2818ce8fea6f5420955e3b4e8b0e3682e3))
* **tasks:** run on-load auto-tasks concurrently ([007f5fa](https://github.com/sinedied/cockpit-js/commit/007f5fad7e5cca6cffaa8c650b2dd3c83a966219))

# [1.1.0](https://github.com/sinedied/cockpit-js/compare/v1.0.0...v1.1.0) (2026-06-29)


### Bug Fixes

* **rayfin:** resolve sign-in via the CLI instead of a local file check ([bcb39fa](https://github.com/sinedied/cockpit-js/commit/bcb39fac6e2006ad0ecc30516669b001ed9eee15))


### Features

* detect XO, Rush, Turbo/Nx and add Playwright e2e lane ([53d2cd7](https://github.com/sinedied/cockpit-js/commit/53d2cd74a36ac02e1c2784281dcefb4c0ebd94a6))

# 1.0.0 (2026-06-29)


### Bug Fixes

* kill dev server process group on stop to prevent CI hang ([e178397](https://github.com/sinedied/cockpit-js/commit/e1783971c78724c2ff0219d5dcb95d91f7f30786))


### Features

* add Node Pilot canvas extension ([0c4fde6](https://github.com/sinedied/cockpit-js/commit/0c4fde6302b60de36c0246ddc953cc300dcbb87b))
* GitHub-native UI pass (Primer theme, Octicons, pinnable scripts) ([72a6329](https://github.com/sinedied/cockpit-js/commit/72a632912579fdbec77c189f5cd45a246415aa61))
* **rayfin:** add custom Rayfin tab icon ([1b9b111](https://github.com/sinedied/cockpit-js/commit/1b9b111714110c5afd3168db050515f785735895))
