# Foundry E2E tests (Only War AI)

Playwright end-to-end тесты, требующие запущенный Foundry VTT с установленной
системой `only-war-local` и модулем `only-war-ai`, а также браузер с открытым
CDP-портом.

## Prerequsites

```powershell
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

Foundry должен быть доступен по `FOUNDRY_URL` (по умолчанию
`http://localhost:30000`) и в нём должна быть активная GM-сессия —
тесты подключаются к уже открытой странице, новую сессию Foundry не
запускают.

## Запуск

```text
cd tests/foundry-e2e
npm install
npm test              # базовый набор: foundation + authority + perception
npm run test:all      # все тесты последовательно
```

Отдельные сценарии запускаются через `npm run test:<имя>` либо напрямую
(`node <file>.test.mjs`). Имена см. в `package.json` → `scripts`.

## Переменные окружения

- `CDP_URL` — endpoint Chrome DevTools Protocol (по умолчанию `http://localhost:9222`).
- `FOUNDRY_URL` — адрес Foundry (по умолчанию `http://localhost:30000`).
- `SCREENSHOT_DIR` — папка для скриншотов (по умолчанию `./screenshots`).
- `FOUNDRY_RELOAD` — `1` для полной перезагрузки страницы перед тестом.
- `OWAI_CYCLE_TIMEOUT` — таймаут боевого цикла `performance.test.mjs` в мс
  (по умолчанию `240000`).

## Тесты

| Тест | Что проверяет |
|---|---|
| `module-foundation.test.mjs` | Модуль активен, `api` опубликован (version/capabilities/services/resolver), world settings зарегистрированы, флаги `flags["only-war-ai"]` пишутся и читаются на Actor/Token/Combatant, resolver даёт ожидаемый приоритет, секция на листе NPC (при включённом модуле). |
| `authority.test.mjs` | Issue #400: детерминированный выбор controller, `waiting-for-gm` без активного GM, авто-claim хода AI-комбатанта, lifecycle операции (claim → executing → completed), markTurnStale/abortIfControllerChanged, `no-executor`. |
| `perception.test.mjs` | Issue #401: сервис `perception` — `hasLineOfSight`/`visibleTargets` на реальных токенах со стеной, hidden-цель не утекает в цели, память last-known: запись → потеря LOS → истечение через 3 полных раунда, `scoreTarget` детерминирован, `canAttack:false` у last-known. |
| `planner.test.mjs` | Планирование на квадратной сетке: планы `attack`/`approach`/`hold`/`no-route`/`no-target`, immutable snapshot + сериализуемые шаги, diagnostics. |
| `preset-assault.test.mjs` | Golden path пресета `assault`: план move→attack→end-turn и полное исполнение. |
| `preset-ranged-cover.test.mjs` | Golden path `rangedCover`: выбор позиции с укрытием и стрельба на дистанции. |
| `preset-hold.test.mjs` | Golden path `hold`: hold-position план без движения/атаки. |
| `preset-spec-ops.test.mjs` | Golden path `specOps`: планирование с тестовым шагом/атакой. |
| `navigation.test.mjs` | Живая навигация: `findMoves`/`planRoute` на квадратной и гекс-сетке, bounds сцены, стоимость пути, непроходимые клетки. |
| `executor.test.mjs` | `runPlan`/`executePlan`: move/attack шаги, идемпотентность по operationId, `token-moved`, `not-controller`, автоматический и preview режимы, resourceDelta/chat cards. |
| `fireteam.test.mjs` | `fireteam.buildTeamPlan`: TeamPlan по членам отряда, тактика/assignment, diagnostics без записи в документы. |
| `fireteam-tactics.test.mjs` | Issue #410: flank-and-fix на квадратной и гекс-сетке, барьер coordinated-assault, covering advance/regroup без конфликтов резерваций, soft cohesion (в пределах/за пределами/detached), очистка временных assignment после терминального TeamPlan, отсутствие перманентных ролей. |
| `team-turn.test.mjs` | Ходы участников до и после барьера, прерывание без отката, путь воссоединения и секция отряда в Handlebars-превью. Движение и инициатива штатные, броски подменены для воспроизводимости. |
| `preview.test.mjs` | GM preview (#409): tracker запускает операцию AI; confirm исполняет ход, cancel и timeout оставляют токен и инициативу без изменений. |
| `grid-types.test.mjs` | Issue #410: golden path всех пресетов на гекс-сетке (gridType=2), гекс-fireteam сценарий, gridless-сцена (gridType=0) → управляемый `unsupported`/`gridless-unsupported` без падения. |
| `multi-gm.test.mjs` | Issue #410: две GM-сессии — детерминированная элекция одного controller, исполнение только контроллером, дубли — no-op, передача контроллера отменяет чужие операции, без активного GM — `waiting-for-gm`/`not-controller`. |
| `stale-replan.test.mjs` | Issue #410: stale-план при изменённом мире → ровно один replan → `replan-limit-exceeded` → hold-and-report без исполнения. |
| `performance.test.mjs` | Issue #410: 10 AI NPC в двух fireteam за полный боевой цикл, machine-readable счётчики (planning/execution ms, candidates, path nodes, doc updates, replans, cycle time) в `reports/performance-*.json`, человекочитаемый отчёт при падении. |
| `master-switch.test.mjs` | `masterEnabled=false`: автоматизация не стартует, executor отвечает `module-disabled`, UI-секции скрыты. |
| `player-view.test.mjs` | Не-контроллер/player клиент: нет записей документов и автоматизации со стороны обычного игрока. |
| `tactical.test.mjs` | Issues #16/#19: сервис `threatMap` (`refresh`/`dangerAt`/`map`), world setting `aiDifficulty`, `api.personalities`/`api.fireteamCharacters`, `plan.difficulty`/`plan.personality`/`diagnostics.threatMap`/`weights.danger`, lookahead-диагностика, easy-гейт карты + `easyPick`, flag-override личности, `team.character` на плане, детерминизм plan.id. |

## Замечания

- Тесты создают временных акторов/сцены/бои и удаляют их по завершении;
  при принудительном прерывании остатки можно удалить вручную.
- `performance.test.mjs` пишет отчёты в `reports/` (каталог в `.gitignore`);
  при падении дополнительно создаётся `reports/performance-failure-*.md`
  с operation/plan id, seed, reason и таймингами.
- Живой GM-таб может быть троттлирован Chrome в фоне — тесты, зависящие от
  дебаунса authority, вызывают `authority.flush()` напрямую.
