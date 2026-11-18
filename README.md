# Only War AI

Opt-in AI-модуль для Foundry VTT **v13–v14** для системы *Only War* (`only-war-local`). Репозиторий создан в рамках эпика [#363](https://github.com/DonRumata/Only-War-Foundry-VTT-System/issues/363) системного репозитория.

> Модуль находится в разработке. Текущий каркас (issue #399) содержит manifest, namespace флагов `flags["only-war-ai"]`, pure-resolver эффективной конфигурации, world settings, module API и минимальный UI. Планировщик, перцепция и выполнение хода будут добавлены следующими задачами — модуль **не управляет NPC сам по себе**.

## Возможности каркаса

* **Установка поверх `only-war-local`** — на `ready` модуль проверяет `game.system.id` и major-версию публичного API `game.darkHeresy.api` (issue #398). При несовместимости показывает одно GM-уведомление и остаётся выключенным (`api.enabled === false`).
* **Конфигурация AI на трёх уровнях** — см. ниже.
* **World settings** (только GM): `executionMode = "automatic"|"preview"` (по умолчанию `preview`) и `diagnosticsEnabled`.
* **Pure resolver** — детерминированный приоритет Combatant → Token → Actor → disabled.
* **Module API** — version/capabilities, config resolver и реестр сервисов для будущих planner/executor.
* **UI**: секция «Only War AI» на листе NPC (чекбокс «AI enabled» + пресет), секция режима в Token Config и пункты контекстного меню Combatant в трекере боя.

## Конфигурация флагов

Все данные живут в `flags["only-war-ai"]`; модуль не изменяет `actor.system`.

| Документ | Флаг | Схема |
|---|---|---|
| Actor | `config` | `{ enabled: boolean, preset: string \| null }` |
| Token | `override` | `{ mode: "inherit" \| "enabled" \| "disabled", preset?: string \| null }` |
| Combatant | `override` | `{ mode: "inherit" \| "enabled" \| "disabled", preset?: string \| null }` |

Фиксированные пресеты: `assault`, `rangedCover`, `hold`, `specOps`.

`resolveEffectiveConfig(document)` возвращает `{ enabled, preset, source }`, где `source` — `"combatant" | "token" | "actor" | "none"`:

1. Combatant `override` (временный, наивысший приоритет);
2. Token `override`;
3. Actor `config`;
4. иначе `enabled: false`.

Повреждённые флаги нормализуются к `inherit`/disabled; удалённые документы → disabled; неизвестный preset → preset актёра → `hold` (если AI включён явно) → disabled.

```js
const api = game.modules.get("only-war-ai").api;
const npc = game.actors.getName("Гвардеец");
await npc.setFlag("only-war-ai", "config", { enabled: true, preset: "assault" });
api.config.resolveEffectiveConfig(npc); // {enabled: true, preset: "assault", source: "actor"}
```

## Module API

```js
const api = game.modules.get("only-war-ai").api;

api.version;                    // "1.0" — версия контракта модуля
api.capabilities;               // карта возможностей
api.presets;                    // ["assault","rangedCover","hold","specOps"]
api.config.resolveEffectiveConfig(doc);
api.services.register("planner", impl);  // реестр для следующих подзадач
api.services.get("planner");
api.enabled;                    // false, если проверка совместимости не пройдена
api.incompatibleReason;         // "wrong-system" | "api-missing" | "version-mismatch" | null
```

## Установка

1. Установите и включите систему *Only War* (`only-war-local`).
2. Добавьте этот модуль через URL манифеста или скопируйте папку в `Data/modules/only-war-ai`.
3. Включите **Only War AI** в *Управлении модулями*.
4. AI по умолчанию выключен для всех NPC — включайте его явно на листе NPC, в настройках токена или через контекстное меню бойца в трекере боя.

## Разработка

```text
npm run check         # node --check всех JS
npm run lint          # eslint
npm run test:unit     # node:test юнит-тесты (без Foundry)
```

E2E-тесты в `tests/foundry-e2e/` требуют запущенный Foundry и браузер с CDP — см. `tests/foundry-e2e/README.md`.

## Создание релиза

`.github/workflows/release.yml` собирает ZIP и `module.json` при push тега `v*.*.*` либо при ручном запуске с `version` и `source_ref` — по образцу vehicle-модуля.

## Лицензия

См. [LICENSE](LICENSE).
