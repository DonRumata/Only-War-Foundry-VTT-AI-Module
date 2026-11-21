# Architecture map — какой код за что отвечает

Карта владения: файл → ответственность → ключевые точки → инварианты.
Дополняет `capabilities.md` (что умеем) и `behavior.md` (как думаем) —
здесь **где искать** при чтении и отладке.

## Поток данных

```
Foundry hooks (updateCombat/Token/Combatant/Actor, userConnected)
  → authority.js        фильтр релевантности + выбор controller
  → operations.js       claim/transition/complete — state machine хода
  → perception.js       snapshot: visibleTargets + lastKnown (memory flag)
  → navigation.js       сетка/пути/коллизии/move-candidates
  → fireteam.js         teamId/leader/tasks/cohesion/convergence
  → planner.js          candidates × factors → plan (steps DTO)
  → executor.js         шаги → documents / system API / advance turn
  → preview-dialog.js   GM-решение confirm/cancel/replan
  → game.darkHeresy.api (система OnlyWar: rolls/actions/movement)
```

## Файлы и ответственность

| Файл | За что отвечает | Ключевые точки | Инвариант |
|---|---|---|---|
| `module.js` | init/ready, settings, API, UI-хуки | публикует `api` | AI не активирует NPC сам |
| `compatibility.js` | system id + api major gate | `api.enabled` | несовместимо → одно уведомление, off |
| `constants.js` | `FLAG_KEYS`, настройки, reason-сеты | все флаги тут | единая точка ключей |
| `settings.js` | world settings регистрация | `masterEnabled`, `executionMode`, `turnPacingMs`, `aiDifficulty`… | дефолты в одном месте |
| `config-resolver.js` | эффективная конфигурация | `resolveEffectiveConfig` | **pure**, read-only, не читает `game` |
| `authority.js` | кто controller + какие хуки релевантны | `electController`, claim key `combat:combatant:round:turn`, `RELEVANT_KEYS`, debounce 150ms | один controller; нет GM → `waiting-for-gm` |
| `operations.js` | state machine AI-хода | `claimTurn`, `transitionOperation`, `completeTurn`, `computeRevision` (FNV) | идемпотентность; фазы строго |
| `perception.js` | что бот видит/помнит | `visibleTargets`, `buildPerceptionSnapshot`, memory TTL 3, `lastKnownPositions` | LOS с точки NPC; memory — controller-only write; GM-данные не используются |
| `navigation.js` | сетка, маршруты, стены | A* `searchRoute`, `floodReachable`, `checkCollision` (3 уровня fallback), `measurePathCost` | gridless → `gridless-unsupported`; детерминизм |
| `planner.js` | выбор плана | `planTurn`, `_resolveMoves`, `_factorsOf`, `_bestBlastAim`, `_bestConeAim`, `_stepsFor`, `validateSnapshot` | **pure скоринг** из снапшота; seeded; сериализуемый план |
| `personalities.js` | черты и overlay весов | `resolvePersonality`, `applyPersonalityOverlay`, jitter | seeded из actor.id; флаг override |
| `presets/*.js` | веса факторов + veto | assault/ranged-cover/hold/spec-ops + SPEC_OPS_TASK_WEIGHTS | данные, не логика |
| `threat-map.js` | карта опасности | `dangerAt(point)`, emitters оружия | строится раз на план/инвалидацию |
| `fireteam.js` | командный уровень | `assignTasks`, `evaluateCohesion`, `electLeader`, `buildTeamPlan`, `_convergentObjective` | мягкая связность; `leader-lost` инвалидирует |
| `executor.js` | исполнение шагов | `_preflight`, `_execute`, `_validate`, `_stepRoll`, `_handleFailure`, advance | controller-only writes; attack/test один раз; pacing; idempotent по operationId |
| `overwatch.js` | заявки на overwatch | `declare`/`clear`, GM-only конус, expiry hooks | declare-only — выстрел за GM |
| `ui/preview-dialog.js` | GM-превью | `resolvePreview` (confirm/cancel/replan), timeout, stale-watch | закрытие = cancel; players не видят |
| `ui/npc-sheet.js` | инъекция конфига в лист | preset/override/personality/fireteam поля | GM+owner permissions |
| `api.js` | модульный API | `services` registry, `capabilities` | внешняя граница модуля |

## Слои #24 → файлы

- **L0 veto** — planner.js (`_factorsOf` veto-ветки, `_bestBlastAim` вето, statuses), navigation.js (reachability), settings (master/config gate)
- **L1 commitment** — *(#25)* `memory.committedPlan` на combatant + `validateSnapshot`/журнал executor
- **L2 morale** — *(#26)* fireteam.js (тир по тиме) → модификаторы задач
- **L3 personality** — personalities.js + `fireteam.character`
- **L4 scoring** — planner.js (`evaluateFactors`, lookahead), presets, threat-map (`danger`)

## Диагностика отладки (симптом → файл)

| Симптом | Смотреть |
|---|---|
| Ход не заявляется | authority.js (controller? RELEVANT_KEYS? waiting-for-gm?), settings masterEnabled |
| Ход заявлен, но не исполняется | operations.js (фаза?), executor `_preflight` reasons |
| «Бот стоит/делает глупость» | planner diagnostics → rejected + score breakdown; `docs/test-scenarios.md` |
| Бот атакует несуществующего | perception memory TTL/last-known; `target-gone` stale |
| Ход не продвигается/дважды | operations `completeTurn` + hook `operationCompleted` vs `_advanceForOperation` |
| Preview не открывается/не закрывается | preview-dialog `previewRequested` hook, `phaseChanged`, `isController` |
| «Не видит врага» | perception LOS-цепочка + dispositions/includeNeutral + hidden |
| «Игнорирует стены/проходит сквозь» | navigation `checkCollision` fallback-цепочка, sense move vs sight |
| Файртим не назначает задачи | fireteam flag на всех уровнях, `resolveTeamConfig`, `teamId` совпадение |
| Черты не применяются | config-resolver `personality` в результате → `context.personality` |
| Конус/бласт не стреляет | planner `blast-no-safe-aim`/`cone-no-safe-aim` в rejected; blastRadius на item |

## Правила владения (для будущих изменений)

1. **Pure-функции не трогают документы**: config-resolver, planner-факторы, navigation, personalities — вход/выход DTO.
2. **Запись — только executor + controller-only сервисы** (memory, overwatch, aim, lastAttacker).
3. **Новый reason-код → constants.js**, новый флаг → `FLAG_KEYS`.
4. **Любое поведение → trace** (#27): не объяснимо строкой — не едет.
5. **Новый фактор → SCORE_FACTORS + default + preset weights + behavior.md таблица** — держать доки синхронными (этот файл + behavior.md обновляются в том же PR).
