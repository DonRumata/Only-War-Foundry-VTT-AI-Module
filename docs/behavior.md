# Текущее поведение ботов (baseline spec)

Слепок поведения по состоянию на `feature/integration-ai` перед слойным
рефактором (issue #24). Точка отсчёта для регрессий: если что-то из
описанного изменилось — это должно быть осознанное решение, а не побочка.

Архитектура и API-границы — `docs/capabilities.md`. Здесь — как бот
думает: факторы, веса, порядок кандидатов, жизненный цикл хода.

## 1. Скоринг

`SCORE_FACTORS` (planner.js) — факторы считаются в 0..1:
`attackNow, attackAfterMove, charge, melee, advance, threat, proximity,
los, cover, exposure, holdPosition, lastKnown, budgetOver, attackType,
vulnerable, engaged, meleeEngage, area, aim, aimAlone, reload, overwatch,
danger, weaponAffinity, weaponInertia, dropProne, readyWeapon,
alliedEngagement, leaveMeleeEngage, engageDenial, unpin, grudge`.

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
| alliedEngagement | −2 | −5 | −3 | −4 |
| leaveMeleeEngage | −4 | −3 | −5 | −2 |
| engageDenial | 4 | 0 | 2 | 1 |
| unpin | 4 | 3 | 3 | 4 |
| grudge | 4 | 1 | 2 | 3 |

specOps overlay-задачи `SPEC_OPS_TASK_WEIGHTS` (support/advance/flank/
assault/regroup — мерджатся поверх базы), solo-overlay `SPEC_OPS_SOLO_WEIGHTS`.
Конфиг specOps: `flankMinAngleDegrees 60, maxDetachedRounds 2,
highThreatRatio 2, supportWeight 6, flankWeight 8, assaultWeight 7,
cohesionWeight 10, fallbackPreset "hold"`.

Tuning-константы: `DEFAULT_LOOKAHEAD_LAMBDA 0.5`, `DEFAULT_LOOKAHEAD_TOP_K 4`,
`EASY_MISTAKE_CHANCE 0.3`, `EASY_PICK_TOP_K 3` (planner.js:150–159).

### Тактические факторы (issue #39)

- `alliedEngagement` — цель (hostile-токен из `allyEngagedTargets`, сет
  по `_blastTokens`) стоит в ближнем бою с союзником: любой другой токен
  той же disposition, что у viewer (`includeNeutral` учитывает
  нейтралов, явный `dispositions`-allow-list — «всё не из списка»), в
  радиусе `DEFAULT_MELEE_RANGE` (2 scene-единицы). Сам бот и сама цель
  союзником не считаются. Фактор =1 только для точечных атак — melee,
  blast-шаблон и cone-шаблон освобождены (шаблонные кандидаты уже
  ветируют союзников в зоне). Дефолт −2.
- `leaveMeleeEngage` — кандидат стартует в melee-reach ≥1 врага и
  заканчивает вне reach *этого же* врага: выход из ближнего боя без
  Disengage провоцирует свободную атаку. Сравнение идёт поконтактно
  (`enemyContacts` из воспринятых `targets` + melee-эмиттеры threat-map,
  фолбэк `DEFAULT_MELEE_RANGE`) — уход от врага A в контакт к врагу B
  всё ещё считается провокацией A.
- `engageDenial` — обратный переход: кандидат стартует вне всех reach и
  заканчивает внутри чужого (вход в ближний бой — «блокировка» цели).
- `unpin` — кандидат `unpin` (см. п. 8a) существует только у
  pinned-бота с WP-характеристикой; фактор =1 у него одного.
- `grudge` — цель кандидата совпадает с записанным `lastAttacker`
  (`tokenUuid|tokenId|actorId`). Рекорд читается из флага Combatant
  (`context.lastAttacker` — инъекция для тестов/макросов), фильтруется
  `grudgeActive` (окно `GRUDGE_MAX_AGE_ROUNDS = 2` раунда) и снимается,
  если атакующего можно доказать мёртвым (defeated/destroyed
  комбатант). Флаг сознательно **не входит** в stale-fingerprint — свежая
  атака по боту не должна форсировать переплан.

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
8a. `unpin` кандидат (issue #39): у pinned-комбатанта при наличии
   характеристики `willpower` (`system.characteristics.willpower` либо
   `actor.characteristics.willpower`) генерируется синтетическое
   full-cost действие — WP-тест, снимающий pinning. Без характеристики —
   rejected `unpin-unavailable`; при `cost > actionBudget` —
   `over-budget`. Сериализуется шагом `test` по обычному контракту
   executor'а (`prepareTest`/`executeTest`).
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
записи системы; `drop-prone` — `statusId:"prone"`, `halves:0`; `unpin`
(issue #39) — шаг `test` с `input {type:"characteristic",
key:"willpower", characteristic:"willpower", testKind:"characteristic",
actionId:"unpin"}`, `cost.halves:2` — верифицированный контракт
`api.rolls.prepareTest`. Preconditions: move
`["turn","self-position","collision"]`, attack
`["turn","target","resources"]`, aim/end-turn `["turn"]`, ready-weapon
`["turn","resources"]`, drop-prone/unpin `["turn"]`.

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

## 6b. Grudge и lastAttacker (issue #39, grudges.js)

- Флаг `flags["only-war-ai"].lastAttacker` на Combatant — «кто последний
  ранил бота». Рекорд `{tokenUuid, tokenId, actorId, round, turn,
  woundsLost, attribution}`; пишет только контроллер (`authority
  .isController()` иначе `game.user.isGM`), читают все.
- Сервис `grudges` (`api.services`): `handleUpdateActor` — вотчер
  `updateActor`; in-memory кэш последних wounds на actorId (старое
  значение в hook недоступно). Отслеживаемый тотал — `wounds.value +
  wounds.critical` (в системе раны растут при уроне): потеря →
  атрибуция, прирост/отсутствие изменений — нет.
- Атрибуция консервативная (`attributeLastAttacker`, pure): только
  targeted-карточки чата — (1) summary-карточка
  `flags["only-war-local"].damageOperation`, чей `target` называет бота
  (источник урона — карточка `source.messageId` → её `rollData`
  атакующего: `tokenId`/`ownerId`/`speaker`); (2) damage-карточка,
  `rollData.damages[]` которой несёт `targetActorId`/`targetTokenId`
  бота. Без targeted-свидетельства эвристику не пишем; self-damage и
  resolved same-side токен (дружественный огонь) не дают grudge. Если
  токен атакующего не резолвится — запись принимается: hostile не
  опровергнуть, а targeted-карточка уже сильное доказательство.
- Экспирация: `GRUDGE_MAX_AGE_ROUNDS = 2` — рекорд раунда R активен на
  R..R+2; рекорд без `round` — консервативно активен. Мёртвый атакующий
  (defeated/destroyed комбатант в бою) снимает grudge.
- Planner читает флаг (или `context.lastAttacker`) и помечает цель
  атакующего фактором `grudge`; флаг в stale-fingerprint не входит —
  свежая атака не форсирует реплан.

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

## 9a. Синхронная тактика отряда (issue #38)

### Общие контакты (shared squad contacts)

- `mergeTeamMemory(ownMemory, teammateMemories, currentRound)` — чистая
  функция (perception.js): свежая запись побеждает; при равном ts своя
  запись побеждает, между тиммейтами — лексикографически меньший
  `combatantId`. Каждая чужая запись получает `sourceCombatantId`
  (null — своя). Дедуп после `sanitizeMemory`/`expireMemoryEntries`.
- `teamLastKnownPositions(combat, combatant, teamId)` — мёрж памяти
  только живых, не-disabled и стоящих на сцене тиммейтов того же
  `teamId`; prune по сцене/tokenExists сохраняет provenance.
- `buildPerceptionSnapshot({teamMemory})` — чужие записи попадают в
  `lastKnownTargets` с `source:"team-contact"`; свежая запись тиммейта
  перекрывает устаревшую свою, при равном ts — своя.
- Планнер принимает `context.team.contacts` (список от fireteam) либо
  вызывает `perception.teamLastKnownPositions` сам по `context.teamId`/
  fireteam-флагу; `team.shareContacts === false` отключает мёрж.
  Нормализованный target: `source:"team-contact"`, `canAttack:false`,
  `lastKnown`-фактор (в `_isMemorySource` вместе с `last-known`/`memory`) —
  движение и blast-удар по точке разрешены, прямой атаки нет.
- Записей в отдельное хранилище нет — контакты читаются из существующей
  памяти членов; запись остаётся controller-only на каждом combatant.

### Синхронный удар (delay)

- `_syncDelay` — post-pass `buildTeamPlan` после планов членов (и после
  retry перераспределения): если есть конвергентная цель и флангер с
  move-only планом (ETA ≥ 1 хода), main-члены, чей план атакует
  `convergence.targetId`, получают delay-stub план `[delay, end-turn]`.
- Флангер никогда не ждёт сам; `morale`-desperate (#26 graceful) не ждёт;
  `delaySync.count ≥ maxSyncRounds` (default 2) снимает ожидание для
  того же `until`; `context.syncDelay === false` отключает проход.
- `memberEntries[].delayed = {reason:"await-sync", until:"flank-ready",
  syncRound, awaitId}`; диагностика `diagnostics.syncDelays`.
- Executor `delay`-шаг пишет **системный** флаг
  `flags["only-war-local"].delayed = true` (трекер сам очищает его при
  начале следующего хода комбатанта — `clearExpiredStates`) и модульный
  `delaySync {round, until, count}`; повторный delay инкрементирует count.
- `validateTeamPlan`: если ожидаемый `awaitId` погиб/недоступен —
  `sync-broken` (TEAM_PLAN_REASONS.syncBroken) до member-unavailable.

### Приказы лидера (orders)

- `_orderCandidateOf`: только электнутый лидер, ≥2 живых члена, навык
  `command`, прошло `ORDER_COOLDOWN_ROUNDS = 5` раундов с `lastOrder`.
- Источники приказов: owned `order`-items (тип `veteran` = advanced,
  cost 2 halves), затем speciality-перки с `activation.type ∈ {order,
  generalOrder}` (например `sergeant_charge`), resolved через
  `fromUuidSync` с graceful-fallback.
- Вариант `order` — отдельный кандидат (не target-scoped): шаг `test`
  `{type:"skill", key:"command", orderId, orderBenefit, flags:{isOrder:true}}`;
  ниже готового выстрела, выше пустого hold (фактор `order` вес 5,
  +0.5 для disciplined/elite, +0.5 при pressured морали).
- Executor: успешный order-тест пишет `lastOrder {round, orderId,
  result:"success"}` — кулдаун считается от этой метки; неуспешный
  приказ не блокирует повтор.

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
или GM-карточка подтверждения перед каждым attack/test шагом) ·
`manualOverrideGrace false` (issue #25 — вкл: ручной перенос токена
безусловен и не отменяет committed-план; выкл: необъяснённый перенос —
`gm-intervention`) · `aiTraceVerbose "compact"` (issue #27 —
compact|full рендер трасса решений в блоке «Как думал») ·
`aiCaptureContext false` (issue #27 — bounded-журнал replay-захватов
`captureJournal` на комбатанте).

Override-цепочка: Combatant → Token → Actor → disabled. Флаги:
`config/override {enabled|mode, preset, includeNeutral, preferredWeapon}`,
`personality` (массив id черт на всех уровнях), `fireteam {teamId,
leaderId, teamPreset, preferredCohesion, character}`, `reactionUsed`
(combatant, рекорд `{round, reason}`), `lastUsedWeapon` (combatant,
рекорд `{itemUuid, itemId, name, actionId, round}` — controller-only),
`lastAttacker` (combatant, рекорд `{tokenUuid, tokenId, actorId, round,
turn, woundsLost, attribution}` — controller-only, issue #39),
`committedPlan` (combatant, рекорд `{id, status, combatId, combatantId,
createdRound, createdTurn, ttl, source, steps, expectedState,
cancelledReason?}` — controller-only, issue #25), `moveJournal`
(combatant, bounded 32 записи `{round, turn, x, y, elevation,
operationId}` собственных ходов — controller-only, issue #25),
`gmControlled` (combatant, рекорд `{round, turn, reason}` на один
раунд — пометка GM-вмешательства, issue #25), `captureJournal`
(combatant, bounded 8 записей `{version, at, preset, config, flags,
context, snapshot, result}` — replay-захваты `planContext`+snapshot,
issue #27, controller-only).

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
- **#39** — тактические факторы: `alliedEngagement` (стрельба по цели в
  рукопашке союзника — только точечные атаки, союзники/нейтралы из
  `_blastTokens`), `leaveMeleeEngage`/`engageDenial` (поконтактные
  свободные атаки при выходе/входе в melee-reach врага), кандидат
  `unpin` (WP-тест против pinning, шаг `test`), `grudge` по флагу
  `lastAttacker` (сервис `grudges` + консервативная атрибуция по
  targeted-карточкам урона; экспирация 2 раунда, вне
  stale-fingerprint).

## 13. Воронка слоёв поведения (issue #24)

Pipeline планирования переформализован как вложенная воронка L0–L4 —
контракт, скобы влияния, reason-формат и флаги описаны в
`docs/layers.md`. Кратко:

- **L0 hard-veto** — все отказы легальности: `diagnostics.rejected`
  (blast/конусы по союзникам, дальность, бюджет, `canAttack`, статусы,
  preset-veto) + входные гейты (`gridless-unsupported`, `stunned`).
  Абсолютно: отвергнутый кандидат не достигает скоринга никогда.
- **L1 commitment** — `applyCommitmentLayer` (`scripts/layers.js`,
  issue #25): валидная committed-запись (флаг `committedPlan`
  комбатанта либо инъекция `context.commitment`) → её сериализованные
  шаги исполняются без генерации и скоринга (`breakdown.reason:
  "commitment"`). Запись валидируется каждый ход по `expectedState`;
  инвалидация — стабильные коды (`ttl-expired`, `gm-intervention`,
  `target-gone`, `morale-changed`, `threat-drift`, `combat-ended`,
  `l0-veto`) → отмена + обычный реплан. Подробности — ниже, «L1
  commitment (issue #25)».
- **L2 morale** — `applyMoraleLayer` (issue #26): общий тир позы
  файртимы (`confident`/`pressured`/`desperate`) из evaluated-рекорда
  флага `morale` (счётчики команды, гистерезис 2 раунда, форс при гибели
  лидера — пишет `buildTeamPlan` на всех членов, только controller) →
  member-effective tier через исключения черт (`fanatic` игнорирует
  `desperate`, `cowardly` эскалирует `pressured`) → bounded-дельты
  `MORALE_POSTURE_DELTAS` на веса (`morale-weight-shift`) + remap задач
  в `buildTeamPlan` (confident — шире assault/flank, desperate-member —
  assault→support, flank/advance→regroup; `moraleDemotions`) и снятие
  sync-delay для desperate-members. Смена тира инвалидирует commitment
  (`morale-changed`). Легаси-чтение `orderBoost` остаётся безусловным.
- **L3 personalities** — дельты #19 через `boundedPersonalityOverlay`:
  каждая дельта зажата в ±30% от базового веса (нулевая база — ±6 от
  опорной шкалы 20); зажатые факторы репортятся
  `diagnostics.personality.clamped`. Jitter без изменений.
- **L4** — существующий scoring + lookahead; `layersLookahead` —
  мастер-гейт поверх difficulty/`context.lookahead`.

Каждый слой пишет `{layer, code, detail}` в `plan.diagnostics.layers`
(хронологический trace — plumbing под #27); эффективные тумблеры —
`diagnostics.layerFlags`, источники — world settings
`layersCommitment`/`layersMorale`/`layersPersonality`/`layersLookahead`
(дефолты в `DEFAULT_LAYER_FLAGS`) с оверрайдом `context.layers`.
Выключенный слой деградирует на предыдущий уровень без ошибок.

## 14. L1 commitment (issue #25)

Слой обязательств: многоходовый план бота переживает ходы и исполняется
без перескоринга, пока мир совпадает с ожиданиями. Компоненты:

- **`committedPlan`-флаг** (combatant, controller-only через executor):
  `{id, status, combatId, combatantId, createdRound, createdTurn, ttl,
  source, steps, expectedState, cancelledReason?}`. `steps` — тот же
  сериализованный формат, что `plan.steps`. Пишется после выполненного
  (completed/partial) скореного хода из `plan.commitment`-payload'а
  планировщика; при commitment-hit — обновляется только
  `expectedState.self`; при инвалидации — штамп `cancelled` +
  `cancelledReason`.
- **`expectedState`** — компактный отпечаток условий (не snapshot):
  `self` (документная позиция конца хода: центр footprint минус половина
  размера клетки), `target` (`{tokenId, tokenUuid, x, y}`), `morale`
  (tier `"pressured"|"desperate"|null` — graceful под #26: без флага
  `morale` tier нейтральный), `threats` (`{tokenId, x, y}` ≤ 16 —
  snapshot целей + выбранная цель).
- **`moveJournal`-флаг** — bounded (32) журнал собственных move-шагов
  executor'а `{round, turn, x, y, elevation, operationId}`. Источник
  истины «свой ход vs чужой»: дрейф позиции с журнальной записью в
  окне жизни плана — свой (`accepted.selfMoved`), без неё —
  `gm-intervention` либо, при `manualOverrideGrace`, молчаливое
  принятие (`accepted.gmMoved`).
- **`ttl`** — раунды жизни записи (`round - createdRound >= ttl` →
  `ttl-expired`); дефолт `COMMITMENT_TTL_ROUNDS = 2`
  (оверрайд `context.commitmentTtl`), reactive-режим — 1.
- **Инвалидаторы** (первый сработавший, стабильные коды в trace L1):
  `combat-ended` → `ttl-expired` → `gm-intervention` → `target-gone`
  (цель мертва/скрыта/нерезолвима) → `morale-changed` → `threat-drift`
  (>1 записанной угрозы сдвинулось дальше клетки/умерла/пропала) →
  `l0-veto` (pinned/prone + committed charge-шаг). L0 не обходится:
  `stunned` опережает L1, каждый committed-шаг ревалидируется
  executor'ом перед исполнением.
- **`gmControlled`-флаг** `{round, turn, reason}` на один раунд —
  помечает бота при `gm-intervention`: `buildTeamPlan` понижает его со
  сложных заданий (flank/assault/advance → support, диагностика
  `gmControlled`/`gmDemotions`), свежая детекция помечает флаг и
  перепланирует члена один раз — команда деградирует, не ломаясь.
- **Reactive mode** — при `> COMMITMENT_REACTIVE_THRESHOLD (1)`
  одинакомандных пометок `gmControlled` за раунд эффективный ttl
  сворачивается до одного раунда: ручной хаос → возврат к per-turn
  планированию (baseline) до конца хаоса. Счётчик/признак идут в
  `diagnostics.commitment` (`{recordId, invalidated, reactive,
  interventions}`).
- **`manualOverrideGrace`** (world setting, default off) — off: ручной
  перенос без журнальной записи = `gm-intervention` (отмена + реплан +
  пометка). on: GM-ход безусловен — commitment принимает новую позицию
  как ожидание и продолжается; пометка не ставится.
- **Delay × commitment**: синхронное ожидание (#38) побеждает — команда
  важнее собственного плана. `_syncDelay` заменяет план члена
  delay-заглушкой независимо от commitment-hit; сама запись `committedPlan`
  не отменяется и, если остаётся валидной, продолжается следующим ходом.

## 15. Трасс решений и replay (issue #27)

GM-прозрачность при наслоении L0–L4: трасс — рендер-поверхность над
`plan.diagnostics.layers` (`{layer, code, detail}`, контракт #24), на
выбор плана не влияет. `scripts/trace.js` — pure-модуль:

- **`diagnostics.trace`** — материализуется планировщиком на каждом
  выходе с диагностикой: одна сериализуемая запись `{layer, kind, ...}`
  на reason-запись (`buildLayerTrace`); `run.trace` executor'а
  зеркалит её.
- **Донесённые поля**: L3 `personality-overlay` — `detail.deltas`
  (применённые дельты по фактору); L4 `winner` — `top` (top-3
  `{candidate, score}`), `runnerUp`, `margin` и `factors` (разность
  `w × f`-вкладов победителя и runner-up, top-3 по |дельте|).
- **Рендер** `renderTrace(entries, {i18n, mode})` — `compact`
  (`aiTraceVerbose`): строка вердикта на слой (`L0: veto out-of-range
  ×3`, единая L4 scoring-строка с top-3 и дельтой); `full`: строка на
  запись. en/ru — `OWAI.Trace.*` (слои, причины, варианты кандидатов).
- **Поверхности**: свёрнутый блок «Как думал» в GM-превью
  (`vm.traceLines`, шаблон `ai-preview.hbs`); однострочный GM-шёпот
  `compactTraceLine` в диагностическом чат-репорте остановленного/
  отменённого хода.
- **Replay**: `aiCaptureContext` (default off; `context.capture`) —
  executor журналит bounded (8) sanitized-запись `planContext`+флаги+
  snapshot+отпечаток в `captureJournal` комбатанта (controller-only);
  `tests/unit/replay-helpers.mjs` `replayPlan` перепрогоняет `planTurn`
  из JSON-записи к идентичному плану и трассу.
