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
  `diagnosticsEnabled` (default `false`).

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
