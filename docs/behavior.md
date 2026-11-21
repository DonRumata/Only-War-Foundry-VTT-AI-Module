# Текущее поведение ботов (baseline spec)

Слепок поведения по состоянию на `feature/integration-ai` перед слойным
рефактором (issue #24). Точка отсчёта для регрессий: если что-то из
описанного изменилось — это должно быть осознанное решение, а не побочка.

Архитектура и API-границы — `docs/capabilities.md`. Здесь — как бот
думает: факторы, веса, порядок кандидатов, жизненный цикл хода.

## 1. Скоринг

`SCORE_FACTORS` (planner.js:118–142) — факторы считаются в 0..1:
`attackNow, attackAfterMove, charge, melee, advance, threat, proximity,
los, cover, exposure, holdPosition, lastKnown, budgetOver, attackType,
vulnerable, engaged, meleeEngage, area, aim, aimAlone, reload, overwatch,
danger, weaponAffinity, weaponInertia, dropProne, readyWeapon`.

Issue #37: `attackType` теперь несёт EV-срез уклонения — значение фактора
`desire × (1 − P(dodge))` для уклоняемых атак; недоджибельные
(spray/cone/suppression, blast вне досягаемости half-move убегания,
цель с потраченной реакцией) сохраняют полный `desire`. `vulnerable`
дополнительно включает цель с флагом `reactionUsed` текущего раунда.

Preset-only: `rangeBand`, `aimOpportunity` (rangedCover/hold);
`insideZone, returnToZone, moveToLos, escapeMelee, searchMove,
anchorDrift` (hold); `flankAngle, cohesionRestore` (specOps).

### Веса пресетов

| Фактор | assault | rangedCover | hold | specOps |
|---|---:|---:|---:|---:|
| attackNow | 10 | 10 | 12 | 9 |
| attackAfterMove | 8 | 7 | 5 | 7 |
| charge | 14 | −6 | −8 | 3 |
| melee | 5 | −12 | 0 | 0 |
| advance | 6 | 0.5 | 0 | 3 |
| threat | 3 | 3 | 2 | 3 |
| proximity | 2 | 0.5 | 0.5 | 1.5 |
| los | 2 | 6 | 4 | 3 |
| cover | 0 | 8 | 1 | 3 |
| exposure | −1 | −3 | −1 | −2 |
| holdPosition | −4 | 2 | 10 | 1 |
| lastKnown | 0.5 | 1 | 0.5 | 1 |
| budgetOver | −8 | −8 | −8 | −6 |
| rangeBand | — | 6 | — | — |
| insideZone/returnToZone/moveToLos/escapeMelee/searchMove/anchorDrift | — | — | 3/26/6/10/14/−4 | — |
| aimOpportunity | — | 1.5 | 1.5 | — |
| attackType | 0.2 | 0.1 | 0.05 | 0.15 |
| vulnerable | 1 | 0.5 | 0.5 | 1 |
| meleeEngage | 6 | 2 | 2 | 3 |
| area | 4 | 3 | 2 | 5 |
| aim | 0 | 0.5 | 3 | 2 |
| aimAlone | 0.5 | 1.5 | 0 | 0.5 |
| reload | 3 | 3 | 3 | 3 |
| overwatch | 0 | 2 | 0.5 | 1 |
| danger | −0.5 | −3 | −2 | −2 |
| weaponAffinity | 1 | 1 | 1 | 1 |
| weaponInertia | 0.15 | 0.15 | 0.15 | 0.15 |
| dropProne | 0 | 1.5 | 2 | 1 |
| readyWeapon | 2 | 2 | 2 | 2 |

specOps overlay-задачи `SPEC_OPS_TASK_WEIGHTS` (support/advance/flank/
assault/regroup — мерджатся поверх базы), solo-overlay `SPEC_OPS_SOLO_WEIGHTS`.
Конфиг specOps: `flankMinAngleDegrees 60, maxDetachedRounds 2,
highThreatRatio 2, supportWeight 6, flankWeight 8, assaultWeight 7,
cohesionWeight 10, fallbackPreset "hold"`.

Tuning-константы: `DEFAULT_LOOKAHEAD_LAMBDA 0.5`, `DEFAULT_LOOKAHEAD_TOP_K 4`,
`EASY_MISTAKE_CHANCE 0.3`, `EASY_PICK_TOP_K 3` (planner.js:150–159).

## 2. Генерация кандидатов (planner.js:2597–3109)

Детерминированный порядок `targets × actions × moves`:

1. Лимиты: `maxTargets 8`, `maxActions 3` **на группу оружия**
   (`itemUuid ?? itemId ?? name ?? id`), `move candidates 8`.
2. На цель: `moves = _resolveMoves()`, `approachMove` — минимальная
   дистанция не-stay. Когда цель дальше самого дальнего оружия,
   `findCandidates` вызывается дважды: на позицию цели (ближайшие
   клетки — подход/charge) и на точку `0.9 × maxRange` от неё («кромка
   дальности» — дешёвые конечные для move-attack на half move).
3. `memoryStrike` = last-known цель + любой non-melee blast. Цель с
   `canAttack !== true` и не memoryStrike → `target-not-attackable`.
4. На действие: `_actionCost > actionBudget` → `over-budget`;
   `actionBudget = 2` half-action'а (`ACTION_BUDGET_HALVES`).
   - **Blast** (радиус > 0, non-melee): `_bestBlastAim` (`requireLos` выкл
     только для presumed-ударов по памяти) → `attack-in-place`
     (+ `aim-attack` если aim-half и `aim > carriedAim`); провал —
     `blast-no-safe-aim` / `blast-unclear-position`. Далее
     `move-attack` blast на каждый non-stay move.
   - **Non-blast**: `distance <= range` → `attack-in-place`
     (+ `aim-attack` вариант); иначе `out-of-range`. На каждый ход в
     дистанции: `charge` (melee) / `move-attack` (ranged); full-cost после
     move → `full-after-move`; дальше `rates.half` → `beyond-half-move` (issue #31); вето `pinned`/`prone`; pinned-ход
     к цели → `pinned`. Ничего нет → `out-of-range`/`no-route`.
5. `approach` кандидат; ни атаки, ни approach → `no-route`.
6. Cone/spray/suppression pass: `_bestConeAim` → `attack-in-place` с
   `cone`-payload; провал `cone-no-safe-aim`; spray (не suppression)
   перебирает `move-attack` по конечным точкам.
7. Action-economy кандидаты: standalone `aim` (нужен `aimFullAction`,
   не pinned, дальняя атака, `aim > carriedAim`); `reload` (+`move-reload`);
   `overwatch` (45° дуга на ближайшую видимую угрозу; не для memory-only;
   вето `reaction-used`, когда реакция бота уже потрачена — issue #37).
8. Free-action кандидаты (issue #37): `ready-weapon` — явные записи
   `kind:"ready"|"draw"|"equip"` из `actions.list` с собственным `cost`
   (free под Quick Draw; модуль таланты не парсит), иначе — синтез по
   инвентарю: оружие без usable-записи при пустом/сухом списке атак
   (клипы `clip.value === 0` у всех атакующих) → half-cost кандидат;
   `drop-prone` — free-действие при pinned либо при `danger ≥ 0.5`
   на собственной клетке (не для уже prone).
9. `hold` кандидат: `alwaysOfferHold`, или `allowNoTarget`, или
   `allowNoAction`.
9. Скоринг: `_factorsOf` → `preset.veto` (reject в диагностику) →
   `evaluate` → personality jitter (по id кандидата). Сортировка score↓.
10. Lookahead: `adjusted = score − λ × expectedCounterDamage` по top-K
    (hard difficulty или `context.lookahead`).
11. Победитель — top-score; тай-брейк `_seededPick` (mulberry32). Easy:
    seeded slip с вероятностью 0.3 берёт из следующих 3 кандидатов.

Варианты атаки: `attack-in-place | move-attack | charge | aim-attack`.

## 3. Сериализация шагов (`_stepsFor`)

Порядок шагов плана: `aim → move → attack|test → reload → overwatch →
ready-weapon → drop-prone → end-turn` (всегда последний). Attack input:
`attackType`, `mode:"charge"`, `aim`, `targetPoint` + `blastRadius`
(blast, issue #29 — зона для оверлея/системного шаблона),
`template.direction/angle/range` + `covered/suppressionFire/burstMode`
(cone). `ready-weapon` несёт `weaponId`/`itemUuid` и `cost.halves` из
записи системы; `drop-prone` — `statusId:"prone"`, `halves:0`.
Preconditions: move `["turn","self-position","collision"]`, attack
`["turn","target","resources"]`, aim/end-turn `["turn"]`, ready-weapon
`["turn","resources"]`, drop-prone `["turn"]`.

## 4. Blast / cone / память

`_bestBlastAim`: центр + 8 смещений на пол-радиуса, максимизация
покрытия hostile; союзники ветируются всегда, нейтралы — без
`includeNeutral`. `area = min(blastHits/2, 1)`. Удары по last-known —
без LOS.

**Ориентация конусов по восприятию (issue #30):** `_bestConeAim` берёт
направление только по воспринимаемым якорям — `targets` планирования:
видимая цель наводит на текущую позицию, last-known контакт — на
запомненную точку (то же правило памяти, что у blast-«зачистки»).
Токены `blastTokens` без восприятия (нет LOS, нет памяти, `hidden`)
конус не наводят — они участвуют только в вето союзников/нейтралов.
Проверка LOS — до якорей, а не до всего покрытия. Без якорей —
`cone-no-safe-aim`, кандидата нет. `overwatch`-декларация — строго по
видимой цели (`canAttack === true`, не `hidden`): на last-known конус
не заявляется — память накрывает spray/blast, а не заявочный конус.

## 5. Executor (executor.js)

Статусы: `completed | partial | failed | cancelled | preview`.
Причины: `not-controller, controller-changed, config-disabled,
module-disabled, preview-mode, system-api-missing, no-planner,
no-combatant, plan-failed, move-failed, roll-failed, invalid-step,
already-at-endpoint, action-budget-spent, adjudication-cancelled,
adjudicated-manual, adjudicated-skill-test`.

- Preflight: `module-disabled`/`config-disabled` → cancelled без
  продвижения хода; не контроллер → `not-controller`.
- Цикл шагов: перед каждым — abort check → `controller-changed`;
  `attack`/`test` один раз за ход, повторы — `action-budget-spent`.
- `_validate`: позиция с толерантностью 0.5px (`token-moved` при внешнем
  сдвиге) + `planner.validateSnapshot`.
- Шаги: `move` → `TokenDocument#move(..., {method:"api"})` с fallback
  `update({x,y})`; `attack`/`test` → `prepare*+execute*` системного API
  (`operationId.stepId`); `aim` → флаг на combatant'е, снимается
  атакой; `reload` → `api.actions.reload`; `overwatch` →
  `overwatch.declare` (только декларация, реакция — за GM);
  `ready-weapon` → `api.actions.readyWeapon`/`ready`/`equip` (без
  endpoint — `system-api-missing`); `drop-prone` → `api.actions.dropProne`
  или fallback `actor.toggleStatusEffect("prone")`; `end-turn` → ok.
- Issue #37: успешная `attack` записывает `lastUsedWeapon` на combatant
  (controller-only) — planner читает его фактором `weaponInertia`.
- Attack adjudication (issue #37): в режиме `attackAdjudication
  "gm-confirm"` перед каждым attack/test шагом в automatic-режиме
  executor спрашивает GM — инъекция `context.adjudication` либо
  whisper-чаткарта с кнопками `execute | manual | skill-test | cancel`
  (`renderChatMessage`-биндинг только для контроллера, `updateCombat`
  авто-отменяет ожидание). `manual` считает шаг исполненным без ролла;
  `skill-test` подменяет канал `prepare/executeTest`; `cancel` завершает
  ход `cancelled` + `completeTurn(advanceTurn:false)`. В preview-режиме
  гейт не работает — диалог предпросмотра уже является единственной
  точкой подтверждения, GM не спрашивается дважды.
- Replan: `shouldReplan`, макс `DEFAULT_MAX_REPLANS = 1`; reset
  `stepIndex=0`; неудачный реплан → `plan-failed`.
- Финиш: `operations.completeTurn` + продвижение хода через
  `operationCompleted`-хук или `_advanceForOperation` (сериализованный
  `nextTurn` + verify windows 600/1200/2400, 2 retry).
- Pacing: `turnPacingMs` пауза между шагами и перед nextTurn (0 — выкл).
- Preview-mode: только preflight + plan + validate → хук
  `only-war-ai.previewRequested`, статус `preview`.
- Диагностика: при не-completed — warn + GM-шёпот с причиной и top-4
  rejected-кандидатами.
- Идемпотентность: `executions` Map по `operationId`.

## 6. Authority (authority.js)

- Контроллер: активный GM с наименьшим user id; нет GM → `waiting-for-gm`.
- Claim key: `combatId:combatantId:round:turn` — пропущенный ход не
  копится.
- `RELEVANT_KEYS` фильтр обновлений + debounce 150ms; смена контроллера —
  abort локальных и пометка чужих операций `controller-changed`.
- Master switch off → нет claims/execution/preview.

## 6a. Реакция и counter-EV (issue #37, reactions.js)

- Флаг `flags["only-war-ai"].reactionUsed` на Combatant — «реакция
  потрачена в текущем раунде». Запись `{round, reason}`; рекорд без
  `round` считается потраченным консервативно; рекорд прошлого раунда —
  уже неактивен. Пишет только контроллер (`authority.isController()` иначе
  `game.user.isGM`); читают все.
- Сервис `reactions` (`api.services`): `markUsed({combat, combatant})`,
  `markUsedByToken(combat, tokenId)`, `clear(combatant)`,
  `reactionUsedOf(combatant, combat)`, `handleUpdateCombat` — авто-сброс
  флага владельца на `updateCombat` (смена turn/round) — реакция
  восстанавливается в начале его хода.
- Counter-EV: `dodgeChanceOf(target, action)` → `{dodgeable, chance}` —
  `dodgeTN/100` (дефолт `DEFAULT_DODGE_TN = 30`, cap 0.95). Недоджибельно:
  cone/spray/suppression, blast при недоказанном выходе из зоны за
  half-move, цель `reactionUsed` (`chance 0`). Planner читает флаг
  `reactionUsed` с документа цели-комбатанта (не только инъекцию),
  складывает в `vulnerable` и режет `attackType`-EV; `breakdown.dodge`
  показывает вердикт.
- Бот с потраченной реакцией не декларирует overwatch (`reaction-used`
  rejected) — слот занят, конус всё равно не выстрелит.

## 7. Perception

- `MEMORY_MAX_AGE_ROUNDS = 3`; память на combatant
  `flags["only-war-ai"].memory[tokenUuid]` — controller-only writes.
- LOS: `canvas.visibility.testVisibility` → `canvas.effects.visibility`
  → `token.testVisibility` → visionSource → геометрический fallback.
- Hidden исключены (с `includeHidden` — `canAttack:false`); blinded viewer
  — нет целей; сортировка по tokenId.
- Dispositions: противоположные ненулевые = hostile; `0` — только с
  `includeNeutral`; `options.dispositions` — явный allow-list.

## 8. Navigation

- `gridless-unsupported` — отклонение до планирования.
- `MOVEMENT_MODES = [half, full, charge, run]`; rate из
  `api.movement.getRates` или `actor.system.movement`.
- A* `searchRoute` + `floodReachable` (Dijkstra), детерминированные;
  лимиты 20000/512/8 кандидатов.
- `checkCollision`: polygonBackends → `walls.checkCollision` → ручной
  сегментный fallback; `hasLineOfSight` — отрицание sight-коллизии;
  v13/v14 схемы стен; terrain-совместимость routinglib/terrain-ruler и т.п.

## 9. Fireteams (fireteam.js)

- Задачи `FIRETEAM_TASKS = [support, advance, flank, assault, regroup]`;
  характеры `[disciplined, shock, elite, rabble]`.
- `assignTasks`: явный override > regroup-флаг > лидер → assault >
  первый не-лидер → flank (≥2 члена, `allowFlank`) > остальные support.
- `evaluateCohesion` — мягкая: flank/assault могут отходить как
  `detached-maneuver` (лимит `maxDetachedPhases`, `rejoinAvailable`,
  штраф overshoot×0.25); остальные — `beyond-cohesion` штраф.
- Лидер: flagged > инициатива > HP > seeded-хэш > id.
- `buildTeamPlan`: фазы 0 movement → 1 action → 2 regroup; конвергенция
  фокус-файра когда Σ EV ≥ wounds цели (#16); `specOpsTactic` hook;
  `leader-lost` инвалидирует план.

## 10. Preview (preview-dialog.js)

- Решения `confirm | cancel | replan`. Confirm — ревалидация snapshot →
  executing. Cancel/timeout — op cancelled, ход остаётся ручным.
  Replan — новый planTurn, общий `maxReplans`.
- `previewTimeoutSeconds` авто-cancel (0 выкл). Stale-хуки:
  `turn-stale|combat-ended|invalid-plan` — авто-cancel, остальные —
  disabled Confirm. Закрытие = cancel.
- View-model: шаги, projectedResourceDelta, npc (имя, пресет, черты,
  характер), цель, маршрут, breakdown факторов, диагностика (rejected ≤20,
  ranking ≤10), stale, timeout.
- Canvas-оверлей плана (issue #29, `planOverlay.showPlan`): на открытии
  preview, после replan и при stale-баннере рисуется route-полилиния со
  стрелкой на конечную клетку, конусы `template`/`overwatch`, круг blast
  `targetPoint` и подсветка цели; stale план рисуется приглушённо. Любое
  решение/снятие сессии (`_drop`: confirm, cancel, timeout, внешнее
  изменение фазы операции) очищает слой. Только controller-GM — игроки и
  не-контроллер клиенты не видят ничего.

## 10a. GM canvas overlays (plan-overlay.js, issues #29/#30/#36)

`scripts/ui/plan-overlay.js` — общий GM-only корень `ow-ai-overlay` на
слое templates с именованными подслоями (`plan`, `overwatch`, `danger`):
чистый PIXI, без записи документов и сокетов. `overwatch.js` рисует
заявленные конусы в тот же корень (общий `coneFanPoints`); сервис
`planOverlay` (`api.services`) держит `start/stop`, хуки
`canvasReady`/`canvasTearDown`/`updateCombat`/`deleteCombat` и
`describe()`/`model()` для отладки и e2e.

Danger-оверлей (issue #36): `setDangerEnabled`/`toggleDanger` +
`setDangerMode` (`"plan"` — карта последнего плана `threatMap.map()`,
`"all"` — агрегат по всем hostiles активного комбатанта через
`buildMap`); `dangerCells` сканирует сетку (бюджет 2500 клеток, stride
ростёт на больших сценах), `dangerShade` детерминированно мапит 0..1 в
цвет/прозрачность; top-8 клеток подписываются вкладчиком из `explain`.
Обновляется на `canvasReady`/`updateCombat`/`deleteCombat` и при redraw
превью.

## 11. Настройки (world)

`masterEnabled true` · `executionMode "preview"` · `diagnosticsEnabled false`
· `preferredCohesion 5` · `previewTimeoutSeconds 60` · `turnPacingMs 800`
· `aiDifficulty "normal"` (easy|normal|hard) · `threatMapOverlay false`
(issue #36 — GM-only отладочная теплокарта угроз; переключается также
keybinding Alt+M, `restricted`) · `attackAdjudication "auto"`
(auto|gm-confirm, issue #37 — арбитраж атак: бросок через системный API
или GM-карточка подтверждения перед каждым attack/test шагом).

Override-цепочка: Combatant → Token → Actor → disabled. Флаги:
`config/override {enabled|mode, preset, includeNeutral, preferredWeapon}`,
`personality` (массив id черт на всех уровнях), `fireteam {teamId,
leaderId, teamPreset, preferredCohesion, character}`, `reactionUsed`
(combatant, рекорд `{round, reason}`), `lastUsedWeapon` (combatant,
рекорд `{itemUuid, itemId, name, actionId, round}` — controller-only).

## 12. Уже реализованные слои (#14/#15/#16/#19)

- **#14** — cone/spray/suppression в plan-step + `overwatch` step
  (declare-only, реакция GM).
- **#15** — `ACTION_BUDGET_HALVES = 2`, aim.half(+10)/aim.full(+20),
  `aimedUntil`-флаг, `full-after-move` вето, reload/overwatch шаги.
- **#16 (часть)** — `danger`-фактор, lookahead по top-K, easy-slip 0.3,
  kill-EV конвергенция тимы.
- **#19** — `scripts/personalities.js`: ~24 черты в 4 категориях,
  `MAX_GENERATED_TRAITS=2`, `DOUBLE_TRAIT_CHANCE=0.5`,
  `JITTER_MAX=0.15`, `DIFFICULTY_JITTER {easy:0.04, normal:0.02, hard:0}`,
  seeded fnv1a+mulberry32, overlay-дельты, `fireteam.character`, показ
  в превью (`npc.traits`). Issue #37: `weaponAffinity`-спеки
  (`classes|keywords|blast`) у heavyHanded/grenadier/duelist/sniper —
  `personalityWeaponAffinity(traits, action)` подпитывает фактор
  `weaponAffinity` (0.5 от базового значения, preferredWeapon побеждает).
- **#37** — free-action кандидаты `ready-weapon`/`drop-prone` + шаги;
  `reactionUsed`-флаг и сервис `reactions` со сбросом в начале хода;
  `attackAdjudication "auto"|"gm-confirm"` с GM-чаткартой;
  counter-EV `attackType × (1 − P(dodge))` + `vulnerable` по
  `reactionUsed`; `preferredWeapon` в конфиге и NPC-листе +
  `lastUsedWeapon`-флаг (факторы `weaponAffinity`/`weaponInertia`).

## 13. Позиция перед рефактором #24

Соответствие слоям: L0 = существующие вето/reason-коды; L1 commitment —
нет (план живёт один ход); L2 morale — нет (ближайшее — fireteam
character как статический overlay); L3 — personalities (#19, внедрено);
L4 = текущий scoring + lookahead (#16, внедрено). Рефактор #24 —
формализация того, что уже частично есть, + добавление L1/L2 и
обязательного trace (#27).
