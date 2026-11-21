# Handoff — состояние AI-эпика (2026-11-21)

Быстрая точка входа для новой сессии. Долговечная логика — `AGENTS.md` +
`docs/capabilities.md`; тут — оперативное состояние.

## Ветка и коммиты

Ветка `feature/integration-ai` (PR #13 — интеграционный/QA PR эпика #363).
Последние коммиты по порядку:

- `32b6d11` — надёжность боя: waypoint-маршруты + сериализованное
  продвижение хода.
- `06884f6` — smoke-сетап: sight у ботов + fireteam на token-документах.
- `e0e9cd9` — диагностика: понятные причины отказа в GM-шёпоте.
- `dd82d3a` — `includeNeutral` (атаки нейтралов) + `turnPacingMs` (темп).
- `8066030` — smoke-лазганы S/2/- (очереди стали доступны).
- `a46485d` — blast-awareness: aim-точки, вето своих, memory-strike.
- `0711716` — `docs/capabilities.md`.
- `0aa7662` — #14 (ветка `feature/templates-14`): step-контракт
  `targetPoint`/`template`/`suppressionFire`, spray и suppressing_fire с
  конусным прицеливанием, заявочный overwatch + GM-only конус.
- `feature/action-economy-15` — #15: бюджет 2×half и вето move+full,
  aim-attack/aim-standalone с переносом `aimedUntil` (флаг `aim` на
  combatant), `reload` через `api.actions.reload`, overwatch-кандидат,
  веса `aim`/`aimAlone`/`reload`/`overwatch` в пресетах.

## Открытые issues (эпик #363)

- ~~**#14**~~ — реализовано на `feature/templates-14` (`0aa7662`).
- ~~**#15**~~ — реализовано на `feature/action-economy-15` (поверх
  `feature/templates-14`).
- Системная сторона: `rolls.executeDamage`/`applyDamage`/`evasionTest` —
  обсуждалось, issue ещё НЕ заведено (модуль кидает только тест
  попадания — урон/уворот ручные). Авто-реакция бота (триггер
  overwatch) — следующая точка расширения.

## Не проверено вживую (риски перед main)

Последний полный live-smoke был на `32b6d11`. С тех пор добавлены:
причины в диагностике, `includeNeutral`, `turnPacingMs`, blast-awareness,
RoF очередей. Надо:

1. Smoke-сетап: Frag Grenade штурмовикам + нейтральный «заложник»
   (проверить и `includeNeutral`, и вето нейтрала без флага).
2. Полный прогон: GM + 3 игрока + 10 ботов — очереди, blast-карточки с
   шаблоном, понятная диагностика, pacing, ноль утечек игрокам.
3. Точка внимания: `perception.hasLineOfSight(tokenDoc, {x,y})` на
   голой точке — если live `testVisibility` упадёт, бласты уйдут в
   `blast-no-safe-aim` — см. `_bestBlastAim` в `scripts/planner.js`.
4. Мержить: #440 (system API) → стек AI PR по порядку.

## Среда

- Модуль: `OnlyWarAIModule`, ветка `feature/integration-ai`.
- Deploy: копирование `scripts/`+`languages/` в
  `%LOCALAPPDATA%\FoundryVTT\Data\modules\only-war-ai`.
- Юниты: `npm run test:unit` (322/322), `npm run check` (46 файлов),
  `npx eslint scripts/`.
- Live: Playwright CDP (`tests/foundry-e2e/smoke/`): `setup-smoke.mjs`
  строит мир (Smoke Arena, 4000×3000, grid 100px=1м, стены/двери/укрытия),
  `run-smoke.mjs` прогоняет. Скилл `launch-foundry-e2e` поднимает стек.
- Smoke-состав: Alpha Trooper 1–4 (assault, hybrid), Beta Rifleman 1–3
  (rangedCover), Spec Operative 1–2 (specOps), Hold Gunner (hold, solo);
  3 аколита игроков.

## PowerShell-грабли

- `git commit -m` с многострочным текстом — работает; heredoc/bash — нет.
- `git push` иногда красится `NativeCommandError` (прогресс в stderr) —
  если строка `old..new branch -> branch` есть, push прошёл.
