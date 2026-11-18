# Only War AI

Opt-in AI-модуль для Foundry VTT **v13–v14** для системы *Only War* (`only-war-local`). Репозиторий создан в рамках эпика [#363](https://github.com/DonRumata/Only-War-Foundry-VTT-System/issues/363) системного репозитория.

> Модуль находится в разработке. Текущий каркас (issue #399) содержит manifest, namespace флагов `flags["only-war-ai"]`, pure-resolver эффективной конфигурации, world settings, module API и минимальный UI. Планировщик, перцепция и выполнение хода будут добавлены следующими задачами.

## Возможности каркаса

* **Установка поверх `only-war-local`** — модуль проверяет систему и major-версию публичного API `game.darkHeresy.api` (issue #398). При несовместимости показывает одно GM-уведомление и остаётся выключенным.
* **Конфигурация AI на трёх уровнях**:
  * Actor: `flags["only-war-ai"].config = { enabled, preset }` — настройка по умолчанию.
  * Token: `flags["only-war-ai"].override = { mode: "inherit"|"enabled"|"disabled", preset? }`.
  * Combatant: `flags["only-war-ai"].override = { mode: "inherit"|"enabled"|"disabled", preset? }` — временный override с наивысшим приоритетом.
* **World settings** (только GM): `executionMode = "automatic"|"preview"` и `diagnosticsEnabled`.
* **Pure resolver** `resolveEffectiveConfig(actorOrTokenOrCombatant)` — приоритет Combatant → Token → Actor → disabled; read-only и детерминирован, одинаково работает на всех клиентах.
* **Module API** `game.modules.get("only-war-ai").api` — version, capabilities, config resolver и реестр сервисов для будущих planner/executor.
* **UI**: секция «Only War AI» на листе NPC (чекбокс «AI enabled» + выбор пресета) и пункт контекстного меню Combatant в трекере боя для временного override.

## Установка

1. Установите и включите систему *Only War* (`only-war-local`).
2. Добавьте этот модуль через URL манифеста или скопируйте папку в `Data/modules/only-war-ai`.
3. Включите **Only War AI** в *Управлении модулями*.
4. AI по умолчанию выключен для всех NPC — включайте его явно на листе NPC или через контекстное меню Combatant.

## Лицензия

См. [LICENSE](LICENSE).
