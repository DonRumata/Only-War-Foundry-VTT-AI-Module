# Карта архитектуры Only War AI

Здесь — где искать код и с чего начинать отладку. Правила выбора плана
описаны в [спецификации поведения](behavior.md), границы модуля и системы —
в [контрактах API](capabilities.md), ручные проверки — в
[сценариях для GM](test-scenarios.md).

## Жизненный цикл хода

```text
Хуки Foundry → authority → operations.claimTurn → executor.runPlan
  → для отряда: создать или продолжить манёвр на Combat
  → planner.planTurn ← восприятие, навигация, угрозы, действия системы
  → preview: подтверждение GM / automatic: исполнение
  → executor.executePlan → проверка snapshot перед изменяющими шагами
  → движение по маршруту / броски и перезарядка через game.darkHeresy.api
  → завершение операции → ожидание урона при попадании → следующий ход
```

В `automatic` с `attackAdjudication: "gm-confirm"` GM подтверждает
необратимый бросок отдельно. При попадании операция может быть уже
`completed`, пока ход ещё ждёт применения урона.

Обычный хук хода исполняет только шаги текущего комбатанта. Для отряда
`fireteam.buildTeamPlan` даёт начальные назначения, а `executor/team-turn.js`
проверяет оставшуюся работу и строит свежий план для текущего хода.

## Сервисы и интерфейс

| Файл | Ответственность |
|---|---|
| [`module.js`](../scripts/module.js), [`compatibility.js`](../scripts/compatibility.js) | Регистрируют настройки, API и сервисы. `ready` проверяет `only-war-local` и major-версию API; несовместимый модуль не запускает AI. |
| [`api.js`](../scripts/api.js), [`services.js`](../scripts/services.js) | `game.modules.get("only-war-ai").api`: возможности, resolver и реестр сервисов. |
| [`settings.js`](../scripts/settings.js), [`constants.js`](../scripts/constants.js), [`config-resolver.js`](../scripts/config-resolver.js) | Настройки мира, ключи флагов и read-only `resolveEffectiveConfig`: Combatant → Token → Actor → disabled. |
| [`authority.js`](../scripts/authority.js), [`operations.js`](../scripts/operations.js) | `electController`, фильтрация хуков, захват и фазы операции на Combat. Нет активного GM → `waiting-for-gm`. |
| [`perception.js`](../scripts/perception.js) | `visibleTargets`, `buildPerceptionSnapshot`, память и общие контакты. LOS проверяет собственный vision source NPC без записи в коллекцию источников GM. |
| [`navigation.js`](../scripts/navigation.js), [`threat-map.js`](../scripts/threat-map.js) | Поиск обхода стен и рельефа, коллизии и проверка стоимости маршрута для текущего хода; опасность позиции (`dangerAt`) по профилям угроз. |
| [`fireteam.js`](../scripts/fireteam.js), [`tactics/registry.js`](../scripts/tactics/registry.js) | `buildTeamPlan`: лидер, задачи, мораль и общий фокус; `reserveResources` блокирует клетки маршрутов, `planRejoin` проверяет путь возврата. Сервис `tactics` — deterministic per-preset реестр манёвров (specOps встроен, остальные пресеты пока fallback). Конфиг «Спецназа» читается из `settings.js` и передаётся тактике и планам бойцов. |
| [`reactions.js`](../scripts/reactions.js), [`grudges.js`](../scripts/grudges.js), [`overwatch.js`](../scripts/overwatch.js) | `reactionUsed`, `lastAttacker`, заявка зон (`declare`/`clear`). Overwatch рисуется для GM, но не совершает реакцию сам. |
| [`ui/preview-dialog.js`](../scripts/ui/preview-dialog.js), [`ui/plan-overlay.js`](../scripts/ui/plan-overlay.js) | `resolvePreview`, устаревание и таймаут; `plan`/`overwatch`/`danger` — клиентские слои GM. Превью плана видит только GM-контроллер. |
| [`ui/npc-sheet.js`](../scripts/ui/npc-sheet.js), [`ui/combat-tracker.js`](../scripts/ui/combat-tracker.js) | Конфигурация актёра и токена, временные переопределения у комбатантов. |

## Планировщик

[`scripts/planner.js`](../scripts/planner.js) собирает сервис `planner`:
`planTurn` координирует генерацию кандидатов и выбор победителя;
`validateSnapshot` и `shouldReplan` решают, можно ли продолжать план.
План и snapshot — сериализуемые данные без ссылок на документы Foundry.

| Файл | Где искать |
|---|---|
| [`planner/actions.js`](../scripts/planner/actions.js) | `_resolveActions`: нормализация `actions.list`, стоимость и варианты оружия. |
| [`planner/targets.js`](../scripts/planner/targets.js) | `_resolveTargets`: видимые цели, память и связи между токенами в ближнем бою. |
| [`planner/moves.js`](../scripts/planner/moves.js) | `_resolveMoves`: маршрутные кандидаты с учётом сетки, дистанции и бюджета. |
| [`planner/zones.js`](../scripts/planner/zones.js) | `_bestBlastAim`, `_bestConeAim` и якоря зоны overwatch. |
| [`planner/scoring.js`](../scripts/planner/scoring.js) | `_factorsOf`, `evaluateFactors`, `_applyLookahead`: признаки, веса и оценка ответа противника. |
| [`planner/snapshot.js`](../scripts/planner/snapshot.js), [`planner/documents.js`](../scripts/planner/documents.js) | `buildPlanSnapshot`, `_staleFingerprint`, чтение токенов, статусов и ресурсов. |
| [`planner/steps.js`](../scripts/planner/steps.js), [`planner/contract.js`](../scripts/planner/contract.js) | `_stepsFor`, `STEP_TYPES`, `SCORE_FACTORS` и коды валидации/реплана. |

### Слои решений

- **L0 — вето:** `planTurn` и правила маршрутов/зон отсекают недопустимое
  до скоринга, например `no-ammo` или `beyond-half-move`.
- **L1 — обязательство:** [`layers.js`](../scripts/layers.js) проверяет
  `committedPlan` и `expectedState`; журнал своих перемещений пишет executor.
- **L2 — мораль:** `fireteam.js` оценивает общую позу отряда, `layers.js`
  применяет её к поведению комбатанта.
- **L3 — личность:** [`personalities.js`](../scripts/personalities.js) и
  `boundedPersonalityOverlay` меняют веса, не отменяя вето L0.
- **L4 — скоринг:** `planner/scoring.js`, [`presets/`](../scripts/presets/)
  и threat map определяют оценку; [`trace.js`](../scripts/trace.js)
  форматирует причины L0–L4 и не влияет на выбор.

## Исполнитель

[`scripts/executor.js`](../scripts/executor.js) координирует `runPlan` и
`executePlan`: preflight, бюджет, перевалидацию, реплан и завершение
операции. Запись и продвижение хода разрешены только контроллеру.

| Файл | Где искать |
|---|---|
| [`executor/steps.js`](../scripts/executor/steps.js) | `_stepMove`, `_stepRoll`, обработчики шагов. Идентификатор броска — `operationId.stepId`. |
| [`executor/team-turn.js`](../scripts/executor/team-turn.js) | Прогресс манёвра на Combat, фазовый барьер, проверка обязательных участников, планирование возврата по инициативе и проверка маршрута перед движением. |
| [`executor/bookkeeping.js`](../scripts/executor/bookkeeping.js) | Журналы перемещений и replay, запись/отмена `committedPlan` и маркеры исполнения. |
| [`executor/adjudication.js`](../scripts/executor/adjudication.js) | `gm-confirm` в automatic: GM-карточка, решения и таймаут. |
| [`executor/damage-wait.js`](../scripts/executor/damage-wait.js) | Связывает карточки урона по `apiOperationId` и ждёт применения всех попаданий; урон применяет система, не AI. |
| [`executor/advance.js`](../scripts/executor/advance.js) | `_advanceForOperation`: сериализованный `nextTurn`, проверка, что ход не переведён вручную. |
| [`executor/contract.js`](../scripts/executor/contract.js) | Статусы, причины остановки и список необратимых шагов. |

## Диагностика

| Симптом | Что проверить |
|---|---|
| Нет хода или диалога | Совместимость, `masterEnabled`, effective config, активного GM, фазу `operation` на Combat и `executionMode`. |
| Цель за стеной, атака или маршрут отсутствуют | `perception.js` (LOS, disposition, `hidden`, источник контакта), `navigation.js` (коллизии движения), `planner/zones.js` (безопасная точка или конус). |
| Бот выбрал не то действие | В превью сравнить `diagnostics.rejected`, вклад факторов и блок «Как думал». Для replay см. [описание L0–L4](layers.md). |
| GM переместил бота, план устарел | `planner.validateSnapshot`, `_validate` в `executor.js`, `expectedState` и `moveJournal` для L1. |
| Атака попала, а ход стоит | Проверить, бросили ли урон и отметили ли все хиты применёнными; затем `damageWaitAutoAdvance`, `damageWaitTimeoutSeconds` и связку `apiOperationId`. |
| Ход продвинулся дважды | Сверить `operations.completeTurn`, хук `operationCompleted` и путь через `executor/advance.js`. |

Новые флаги регистрируйте в `FLAG_KEYS`, новые причины — в контракте
владеющего сервиса. При добавлении фактора сверяйте `SCORE_FACTORS`,
дефолтные веса, пресеты и трасс; обновляйте [правила поведения](behavior.md)
и эту карту в том же PR. Модуль не импортирует внутренние файлы системы:
броски, правила оружия и применение урона принадлежат `only-war-local`.
