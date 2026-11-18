# Only War AI — правила для разработки

## Назначение

Модуль `only-war-ai` — opt-in AI для системы Foundry VTT `only-war-local`
(Warhammer 40,000: Only War). Каркас создан по issue #399 эпика #363; игровая
система предоставляет только стабильные правила и публичный API
`game.darkHeresy.api` (issue #398) — модуль не импортирует `script/common/*`
системы.

## Структура

- `scripts/` — ES-модули: bootstrap, resolver, settings, API, UI-хуки.
- `templates/` — Handlebars-шаблон меню настроек.
- `styles/` — CSS инжектированных секций и меню.
- `languages/` — обязательные English и Russian локализации.
- `tests/unit/` — node:test юнит-тесты с моками (`setup.mjs`, `fixtures.mjs`).
- `tests/foundry-e2e/` — Playwright end-to-end тесты, требуют запущенный Foundry.
- `module.json` — manifest и совместимость (Foundry 13–14).

## Архитектура

`scripts/module.js` на `init` регистрирует world settings, меню настроек,
публикует `game.modules.get("only-war-ai").api` и UI-хуки. На `ready`
`scripts/compatibility.js` проверяет `game.system.id === "only-war-local"` и
major-версию `game.darkHeresy.api` (требуется `"1.x"`); при несовместимости —
одно GM-уведомление, `api.enabled === false`, модуль не работает. AI никогда не
активирует NPC сам по себе.

## Namespace флагов

Все данные модуля — в `flags["only-war-ai"]`; `actor.system` не трогаем:

- Actor: `config = { enabled: boolean, preset: string|null }`.
- Token: `override = { mode: "inherit"|"enabled"|"disabled", preset: string|null }`.
- Combatant: `override = { mode: "inherit"|"enabled"|"disabled", preset: string|null }`
  — временный override с наивысшим приоритетом.
- World settings: `executionMode = "automatic"|"preview"` (default `"preview"`),
  `diagnosticsEnabled` (default `false`), `preferredCohesion` (default 5),
  `previewTimeoutSeconds` (default 60, `0` — без авто-отмены).
- Combat: `operation = { id, combatId, combatantId, round, turn, controllerId,
  phase, revision, startedAt, completedAt?, reason?, result? }` —
  авторитетная запись жизненного цикла AI-хода; пишет только
  выбранный controller (issue #400).

Фиксированные пресеты: `assault`, `rangedCover`, `hold`, `specOps`.

## Pure resolver

`scripts/config-resolver.js` → `resolveEffectiveConfig(actorOrTokenOrCombatant)`
возвращает `{enabled, preset, source}` (`source`: `"combatant" | "token" |
"actor" | "none"`). Приоритет Combatant → Token → Actor → disabled. Resolver
read-only, детерминирован, не читает `game` и работает одинаково на всех
клиентах; удалённые/повреждённые документы → disabled, неизвестный preset →
actor preset → `hold` (если enabled явно) → disabled.

## Module API

`api = game.modules.get("only-war-ai").api`:

- `version`, `capabilities`, `hasCapability(name)`;
- `presets`, `overrideModes`, `executionModes`;
- `config.resolveEffectiveConfig`;
- `services.register(name, impl)` / `get` / `has` / `list` / `unregister` —
  реестр для будущих planner/executor из следующих подзадач;
- `enabled`, `incompatibleReason` — состояние после `ready`-проверки.

## Authority и lifecycle AI-хода (issue #400)

`scripts/authority.js` — детерминированный выбор единственного controller:
`electController(users)` возвращает активного GM с наименьшим стабильным
user id; все клиенты вычисляют его одинаково без голосования. Нет активного
GM — статус `waiting-for-gm`, документы не меняются. Сервис подписан на
`userConnected`/`updateUser` (смена controller → незавершённые операции
помечаются `controller-changed`, локальный процесс останавливается, новый
controller перечитывает документы) и на `updateCombat`/`updateCombatant`/
`updateToken`/`updateActor`/delete-хуки с фильтром релевантных изменений и
debounce. Точка интеграции executor — `runAIPlan`/`api.services.get("executor")`
(#407); без него операция безопасно завершается (`no-executor`).

`scripts/operations.js` — state machine операции на флаге Combat:
`idle → planning → awaiting-preview → executing → completed/failed/cancelled`.
`claimTurn` (compare-before-update, повторный claim → `operation-exists`),
`transitionOperation` (ожидаемая phase ≠ текущей → `phase-mismatch`),
`completeTurn` (идемпотентен, повтор → `already-completed`; перевод хода —
интеграционная точка `only-war-ai.operationCompleted` для executor),
`abortIfControllerChanged`, `markTurnStale`, `computeRevision`
(стабильный FNV-1a fingerprint round/turn/позиции токена).

Socket-канал `module.only-war-ai`: `ai-request`/`ai-status`; запросы
игнорируются на не-controller клиентах, реальные изменения документов делает
только controller. Сервисы опубликованы как `api.services` → `authority`,
`operations`.

## Executor (issue #407)

`scripts/executor.js` — выполнение сериализуемого plan шаг за шагом:
`api.services.get("executor").runPlan({combat, operation, operations,
signal})` — точка интеграции authority (#400); `executePlan(plan, context)`
— прямой запуск готового плана. Только controller
(`api.services.get("authority")?.isController?.() ?? game.user.isGM`)
меняет документы; не controller — `not-controller` no-op. Перед каждым
state-changing шагом `planner.validateSnapshot(plan)`; позиция токена
сверяется с ожидаемой отдельно (ручное перемещение — `token-moved`).
`move` — `TokenDocument#move` (Foundry 13+) по сериализованным waypoints
из плана без пересчёта пути (fallback `update({x, y})`); `attack`/`test` —
`game.darkHeresy.api.rolls` (`prepare*` + `execute*(prepared,
{operationId})`, system PR #440), отсутствие API — `system-api-missing`.
Stale → один replan через `planner.shouldReplan`; повторный stale —
hold-and-report. operationId дедупликация: повторный вызов возвращает
прежний результат, roll-шаги проксируют step-scoped operationId, move к
уже достигнутой точке пропускается. Терминальные статусы
(`completed`/`partial`/`failed`) закрывают операцию через
`operations.completeTurn` и переводят ход ровно один раз — хуком
`only-war-ai.operationCompleted` (#400) либо прямым `combat.nextTurn()`
fallback; `cancelled` и `preview` документов не трогают. Результат:
`{status, stepsDone[], failedStep?, reason, operationId, planId,
replanCount, resourceDelta, chatMessageIds}`.

## GM preview (issue #409)

`scripts/ui/preview-dialog.js` — модальный предпросмотр плана у controller-GM
в режиме `executionMode === "preview"`. Executor (#407) в preview-режиме
возвращает `{status:"preview", plan}` и эмитит хук
`only-war-ai.previewRequested` ({combat, combatant, operation, operationId,
plan, planContext}); контроллер `api.services.get("preview")` открывает
диалог `templates/ai-preview.hbs` (NPC/пресет, цель, действие, маршрут,
шаги, projected resource cost, score breakdown, collapse-секция diagnostics
при `diagnosticsEnabled`). Единая точка решений —
`resolvePreview(operationId, decision)`: confirm ре-валидирует snapshot,
переводит операцию `awaiting-preview → executing` (при наличии
operations-сервиса) и запускает `executor.executePlan`; cancel/timeout
закрывают операцию `cancelled` без смены документов — ход остаётся под
ручным управлением GM (advanceTurn: false); replan запрашивает новый план в
пределах `planner.maxReplans`. Таймаут — world setting
`previewTimeoutSeconds` (default 60, `0` отключает). Документ-хуки
ре-валидируют открытый preview: `turn-stale`/`combat-ended` — авто-отмена,
остальные stale — баннер + disabled Confirm. Закрытие окна без решения =
cancel, не confirm. Сервис работает headless, если Application недоступен.

## Права

Actor/Token настройки меняют GM и владельцы с update permission; временный
override Combatant и world settings — только GM. Resolver — pure/read-only.

## Локализация и стиль

- Каждый новый пользовательский текст добавляйте в `languages/en.json` и
  `languages/ru.json` (ключи `OWAI.*`, parity проверяется тестом); в шаблонах
  `game.i18n`/`localize`, без захардкоженных надписей.
- Соблюдайте существующий JavaScript-стиль (`4` пробела, JSDoc, двойные
  кавычки) и минимальные изменения.
- Отдельного build шага нет: JS, HBS и CSS загружаются напрямую.
- Для изменённых JS запускайте `node --check <file>` или `npm run check`.
- **PR и сообщения коммитов — на русском языке.** Изменения оформляются
  feature-веткой и PR в `main`.

## Тестирование

Юнит-тесты не требуют Foundry:

```text
npm run test:unit     # node:test + tests/unit/setup.mjs моки
npm run lint          # eslint
npm run check         # node --check всех js/mjs в scripts/ и tests/unit/
```

E2E живут в `tests/foundry-e2e/` и требуют запущенный Foundry с системой
`only-war-local` и включённым модулем `only-war-ai` плюс браузер с CDP:

```text
cd tests/foundry-e2e
npm install
npm test              # module-foundation.test.mjs
```

Переменные окружения: `CDP_URL` (`http://localhost:9222`), `FOUNDRY_URL`
(`http://localhost:30000`), `SCREENSHOT_DIR`, `FOUNDRY_RELOAD=1`.

## Специализированные агенты

Конкретные роли вынесены в отдельные `AGENT.md` под `.devin/agents/`:

| Роль | Описание | Файл |
|---|---|---|
| **system-architect** | Структура, ключевые модули, соглашения | `.devin/agents/system-architect/AGENT.md` |
| **e2e-tester** | Playwright end-to-end тесты | `.devin/agents/e2e-tester/AGENT.md` |
| **release-manager** | Релизы, CI/CD, безопасность PR | `.devin/agents/release-manager/AGENT.md` |

Корневой `AGENTS.md` остаётся общим always-on описанием проекта.

## Релизы

`.github/workflows/release.yml` собирает ZIP и `module.json` при push тега
`v*.*.*` либо при ручном запуске с `version` и `source_ref`. PR создаются из
feature-веток после локальной проверки (`npm test`, `npm run lint`).
