---
name: system-architect
description: Understand and modify the architecture of the Only War AI module.
---

# System Architect (Only War AI)

You understand and help evolve the architecture of the `only-war-ai`
Foundry VTT module — an opt-in AI layer on top of the `only-war-local` system
(epic #363).

## Project structure

- `scripts/` — ES modules: bootstrap, resolver, settings, API, UI hooks.
- `templates/` — Handlebars template for the settings menu.
- `styles/` — CSS for injected sheet sections.
- `languages/` — `en.json` and `ru.json` localization files.
- `tests/unit/` — node:test suites with Foundry mocks (`setup.mjs`,
  `fixtures.mjs` actor/token/combatant + square/hex scene stubs).
- `tests/foundry-e2e/` — Playwright end-to-end tests against a live world.
- `module.json` — module manifest, system relationship and compatibility.

## Key entry points

- `scripts/module.js` — `init` (settings, menu, API publication, UI hooks) and
  `ready` (system compatibility check, single GM notification on mismatch).
- `scripts/compatibility.js` — pure check for `only-war-local` and the major
  version of `game.darkHeresy.api` (issue #398 contract).
- `scripts/config-resolver.js` — pure `resolveEffectiveConfig`, precedence
  Combatant → Token → Actor → disabled.
- `scripts/api.js` — `createModuleApi`: version/capabilities/config/services.
- `scripts/services.js` — service registry for future planner/executor.
- `scripts/settings.js` — world settings `executionMode`/`diagnosticsEnabled`.
- `scripts/ui/npc-sheet.js` — `renderActorSheet`/`renderTokenConfig` injection.
- `scripts/ui/combat-tracker.js` — combatant context menu override.
- `scripts/ui/config-menu.js` — GM settings menu (FormApplication).

## Conventions

- Follow the existing JSDoc/ES module style.
- Keep localization in sync: if you add or change a string key, add it to
  `languages/en.json` and `languages/ru.json` (parity is unit-tested).
- All module data lives in `flags["only-war-ai"]` — never write into
  `actor.system` or other system-owned schema.
- The resolver stays pure: no `game`, no DOM, no mutation. Foundry-facing
  logic belongs in `module.js` / `scripts/ui/*`.
- Interact with the host system only through `game.darkHeresy.api`
  (issue #398); do not import `script/common/*` of the system repo.
