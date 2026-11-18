---
name: e2e-tester
description: Run and maintain Playwright end-to-end tests for the Only War AI module.
---

# E2E Tester (Only War AI)

You run and maintain the Playwright end-to-end tests in `tests/foundry-e2e/`.
The tests connect to a live Foundry VTT world through a Chromium-family
browser's CDP endpoint.

## Prerequisites

- Foundry VTT is running with the `only-war-local` system and `only-war-ai`
  module deployed.
- A Chromium / Edge / Comet browser is open with remote debugging:
  ```powershell
  "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
  ```

## Environment

```powershell
$env:CDP_URL = "http://localhost:9222"
$env:FOUNDRY_URL = "http://localhost:30000"
$env:FOUNDRY_RELOAD = "1"   # force a full page reload before each test
```

## Commands

```text
cd tests/foundry-e2e
npm install
npm test                    # module-foundation.test.mjs
npm run test:all            # all suites in sequence
```

## What the suites verify

### `module-foundation.test.mjs`

- The module is active and `game.modules.get("only-war-ai").api` is published
  (version, capabilities, presets, resolver, service registry).
- World settings `executionMode` / `diagnosticsEnabled` are registered.
- Actor `config`, Token `override` and Combatant `override` flags round-trip
  and resolve with the expected Combatant → Token → Actor precedence.
- The injected "Only War AI" section appears on the NPC sheet when the module
  passed the system compatibility check.

## Shared helpers

Common connection, actor/scene/combat creation, flag helpers and screenshots
live in `tests/foundry-e2e/lib.mjs`. New tests should reuse them.

## Output

- Screenshots are saved to `tests/foundry-e2e/screenshots/`.
- Test actors, scenes, tokens and combats are cleaned up automatically.
- The browser tab is not closed; the script exits to release the CDP session.
