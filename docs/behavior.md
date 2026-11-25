# Текущее поведение ботов (baseline spec)

Исходный слепок `feature/integration-ai` перед слойным рефактором (issue #24)
с дополнениями из смока `integration/ai-stack`. Точка отсчёта для регрессий:
изменения поведения должны быть осознанными.

Архитектура и API-границы — `docs/capabilities.md`. Здесь — как бот
думает: факторы, веса, порядок кандидатов, жизненный цикл хода.

## 1. Скоринг

`SCORE_FACTORS` (`scripts/planner/contract.js`), большинство факторов в 0..1:
`attackNow, attackAfterMove, charge, melee, advance, threat, proximity,
los, cover, exposure, holdPosition, lastKnown, budgetOver, attackType,
vulnerable, engaged, meleeEngage, area, aim, aimAlone, reload, overwatch,
danger, weaponAffinity, weaponInertia, dropProne, readyWeapon,
alliedEngagement, leaveMeleeEngage, engageDenial, unpin, grudge, order, ev,
stickyTarget, outnumber, tieUp, seek, run`.

Issue #37: EV-срез уклонения живёт на факторе `ev` — `damageNorm ×
attackDesire × (1 − P(dodge))`, где `damageNorm = min(damage/20, 1)`
(ожидаемый урон атаки, кубики → среднее); `attackType` при этом остаётся
сырым `desire`. Недоджибельные атаки (spray/cone/suppression, blast вне
досягаемости half-move убегания, цель с потраченной реакцией) несут
`chance 0` → полный `ev`. `vulnerable` дополнительно включает цель с
флагом `reactionUsed` текущего раунда.

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
| ev | 1 | 1 | 1 | 1 |
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
| seek | 1.5 | 0 | 0 | 3 |
| run | 1.5 | 0.5 | 0 | 1 |

specOps overlay-задачи `SPEC_OPS_TASK_WEIGHTS` (support/advance/flank/
assault/regroup — мерджатся поверх базы), solo-overlay `SPEC_OPS_SOLO_WEIGHTS`.
Конфиг specOps: `flankMinAngleDegrees 60, maxDetachedRounds 2,
highThreatRatio 2, supportWeight 6, flankWeight 8, assaultWeight 7,
cohesionWeight 10, fallbackPreset "hold"`.
GM может менять эти параметры в настройках мира **Only War AI** (поля
«Спецназ: …»). Угол проверяется из фактической позиции планируемой
атаки, а не из расчётной точки. Без допустимой позиции и пути к ней
отряд выбирает тактику без обхода. Порог угрозы сравнивает число видимых
противников с числом доступных бойцов. Нулевой предел отделения запрещает
выход за сплочённость, а ненулевой всё равно требует достижимого пути назад.
Веса меняют оценку укрытия у поддержки, угла у
флангера, атаки после движения у штурмующих и возврата у перегруппировки.
Параметры берутся при построении нового `TeamPlan` и не меняют уже
начатый манёвр; явный допустимый `context.specOpsConfig` имеет приоритет.
Если отряд не может собрать совместный план, бойцы используют выбранный
индивидуальный пресет на обычных ходах. Одиночный «Спецназ» вне отряда
сохраняет своё поведение.

Tuning-константы: `DEFAULT_LOOKAHEAD_LAMBDA 0.5`, `DEFAULT_LOOKAHEAD_TOP_K 4`,
`EASY_MISTAKE_CHANCE 0.3`, `EASY_PICK_TOP_K 3` (planner.js:150–159).

### Тактические факторы (issue #39)

- `alliedEngagement` — цель (hostile-токен из `allyEngagedTargets`, сет
  по `_blastTokens`) стоит в ближнем бою с союзником: любой другой токен
  той же disposition, что у viewer (`includeNeutral` учитывает
  нейтралов, явный `dispositions`-allow-list — «всё не из списка»), в
  радиусе пары — `max(melee-эмиттеры цели, melee-оружие союзника)`,
  фолбэк `DEFAULT_MELEE_RANGE` (2 scene-единицы; копьё и длинные лапы
  реально держат контакт дальше). Сам бот и сама цель союзником не
  считаются. Фактор =1 только для точечных атак — melee,
  blast-шаблон и cone-шаблон освобождены (шаблонные кандидаты уже
  ветируют союзников в зоне). Черта `heretic` обнуляет фактор целиком
  (флаг `firesIntoMelee`) — еретик стреляет в спины без зазрения.
  Дефолт −2.
- `leaveMeleeEngage` — кандидат стартует в melee-reach ≥1 врага и
  заканчивает вне reach *этого же* врага: выход из ближнего боя без
  Disengage провоцирует свободную атаку. Сравнение идёт поконтактно
  (`enemyContacts` из воспринятых `targets` + melee-эмиттеры threat-map,
  фолбэк `DEFAULT_MELEE_RANGE`) — уход от врага A в контакт к врагу B
  всё ещё считается провокацией A.
- `engageDenial` — обратный переход: кандидат стартует вне всех reach и
  заканчивает внутри чужого (вход в ближний бой — «блокировка» цели).
- `unpin` — с issue #93 снятие pinning не конкурирует как кандидат:
  нулевой end-of-turn тест автоматически вставляется в план pinned-бота
  (см. п. 8a). Фактор сохранён в контракте скоринга для совместимости,
  но всегда равен 0.
- `grudge` — цель кандидата совпадает с записанным `lastAttacker`
  (`tokenUuid|tokenId|actorId`), масштаб `min(woundsLost/10, 1)`
  (дефолт 5, когда рекорд без счётчика) — царапина почти не тянет,
  тяжёлый удар тянет в полную силу. Рекорд читается из флага Combatant
  (`context.lastAttacker` — инъекция для тестов/макросов), фильтруется
  `grudgeActive` (окно `GRUDGE_MAX_AGE_ROUNDS = 2` раунда) и снимается,
  если атакующего можно доказать мёртвым (defeated/destroyed
  комбатант). Флаг сознательно **не входит** в stale-fingerprint — свежая
  атака по боту не должна форсировать переплан.

## 2. Генерация кандидатов (`planTurn`)

Детерминированный порядок `targets × actions × moves`:

1. Лимиты: `maxTargets 8`, `maxActions 3` **на группу оружия**
   (`itemUuid ?? itemId ?? name ?? id`), `move candidates 8`.
   До группировки L0 исключает заклинившее оружие (`weapon-jammed`) и
   оставшиеся в выдаче дальние атаки с `clip.value === 0` (`no-ammo`).
   Ближние атаки и оружие без отслеживаемого клипа не получают `no-ammo`;
   `reload`, `ready-weapon` и движение остаются отдельными кандидатами.
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
     move → `full-after-move`; `move-attack` дальше `rates.half` →
     `beyond-half-move` (issue #31); pinned-ход к цели → `pinned`.
     Ничего нет → `out-of-range`/`no-route`.
   - **Charge**: отдельный поиск до `rates.charge` (3× скорректированный
     бонус Ловкости), запрещён при `pinned`/`prone`. Начальная дистанция
     до цели — не менее 4 единиц сцены (4 клетки при масштабе Smoke Arena);
     маршрут прямой с допуском сетки, направлен в цель и заканчивается
     в пределах melee reach. Причины: `charge-too-close`,
     `charge-bent-route`, `charge-off-line`. Движение входит в полное
     действие чарджа.
5. Перемещения без атаки:
   - `approach` — обычный подход; ни атаки, ни approach → `no-route`.
     Если прямо мешает стена и атаки нет, планировщик ищет полный обход с
     ограничением числа клеток и берёт посильный отрезок на этот ход (#70).
     `advance` тогда отражает прогресс по маршруту, а не расстояние по прямой:
     первый шаг к двери может увести от цели.
   - `seek` — для невидимого `last-known`/`team-contact`/`relay`/`intel`
     контакта. Конечная точка ближе по прямой или продвигает бота по обходу
     и скрыта от контакта стеной
     (`los:false`, не `null`); стоимость как у half/full move. Фактор
     `seek = 1` отличает поиск укрытого подхода от обычного.
   - `run` — поиск до `rates.run` (6× скорректированный бонус Ловкости).
     Кандидат только при свободном полном действии, без `pinned`/`prone`,
     и если конец спринта строго ближе к цели, чем лучший `approach`
     (либо `approach` недоступен). Если найден обход, спринт-кандидат
     по прямой не подменяет его. Фактор `run = 1`; тратит оба
     полудействия без последующей атаки.
6. Cone/spray/suppression pass: `_bestConeAim` → `attack-in-place` с
   `cone`-payload; провал `cone-no-safe-aim`; spray (не suppression)
   перебирает `move-attack` по конечным точкам.
7. Action-economy кандидаты: standalone `aim` (нужен `aimFullAction`,
   не pinned, дальняя атака, `aim > carriedAim`); `reload` (+`move-reload`);
   `overwatch` (issue #54: зона по **предсказанным якорям**, а не по пеленгу
   на стоящего врага — nav-waypoint ближайшей угрозы ~на половину полухода
   по её `planRoute(threat → self)` (единственный pathfind на план),
   lead-точка `threatPos + dir × min(halfMove, dist)` каждой видимой
   угрозы, позиции memory-контактов `last-known`/`team-contact` как
   готовые предсказания; невидимые для бота якоря отсекаются LOS-пробой.
   По одному кандидату на геометрию зоны: cone — 45° сектор по
   `_bestConeAim` от всех якорей, spray — собственный конус
   `_coneSpecOf` (arc/range оружия), blast — круг-триггер
   `{targetPoint, blastRadius}` на якоре с максимальным покрытием;
   fallback — bearing на угрозу. Для декларации нужна видимая угроза
   или `team-contact` от живого союзника; своей `last-known` памяти
   недостаточно. Вето `reaction-used`, когда реакция уже потрачена —
   issue #37).
8. Free-action кандидаты (issue #37): `ready-weapon` — явные записи
   `kind:"ready"|"draw"|"equip"` из `actions.list` с собственным `cost`
   (free под Quick Draw; модуль таланты не парсит), иначе — синтез по
   инвентарю: оружие без usable-записи при пустом/сухом списке атак
   (клипы `clip.value === 0` у всех атакующих) → half-cost кандидат.
   Синтез предлагается только при наличии исполнимого endpoint
   (`api.actions.readyWeapon`/`ready`/`equip` — issue #53: без него шаг
   гарантированно падает с `system-api-missing`, бот держит hold);
   `drop-prone` — free-действие при pinned либо при `danger ≥ 0.5`
   на собственной клетке (не для уже prone).
8a. `unpin` end-of-turn шаг (issue #39, пересмотрено в issue #93): по
   корбуке снятие pinning — не действие, а свободный тест Воли в конце
   хода (+0; +30 в укрытии от ближайшей известной угрозы —
   `navigation.coverEstimate` ≥ 0.5; бонус «не обстреливали» не
   выдумывается — данных о выстрелах у модуля нет). Укрытие оценивается
   для позиции КОНЦА хода: probe-точка — endpoint последнего move-шага
   сериализованного плана (`input.to` — центр футпринта в пикселях,
   контракт executor'а; helper `_planEndCentre`), а не стартовая позиция
   — pinned-бот, легально отползающий в укрытие distance-keeping
   move-attack'ом или replay'ящий commitment с перемещением, тестируется
   с +30; без движения — центр футпринта текущей позиции. Никакого
   кандидата:
   у pinned-комбатанта при наличии характеристики `willpower`
   (`system.characteristics.willpower` либо `actor.characteristics.willpower`)
   нулевой шаг `test` (`halves: 0`, `input.unpin/endOfTurn: true`,
   `modifier`/`modifierBasis`, стабильный id `step-test-unpin` —
   идемпотентность повторного теста за ход через operation-journal)
   автоматически вставляется перед end-turn любого плана — scored,
   replay commitment (dedup, если шаг уже есть в записи), team-wait и
   delay-stub. Без характеристики — rejected `unpin-unavailable` и шага
   нет; stunned-план шага не содержит. Executor исполняет шаг через
   `prepareTest`/`executeTest` и снимает `pinned` только при успешном
   броске (`outcome.roll.success` — системный `removeCondition`, фолбэк
   `toggleStatusEffect("pinned", {active:false})`); провал оставляет
   статус, неактуальный шаг (уже не pinned) пропускается с `not-pinned`.
   Нулевая стоимость не блокируется irreversible-бюджетом и не тратит
   его.
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
(cone). Спринт сериализуется как `move` с `input.mode:"run"` и
`cost.halves:2`. `overwatch` несёт `direction`/`arc`/`range` (конусная
зона; для spray — дуга собственного конуса оружия, issue #54) либо
`shape:"blast"` + `targetPoint`/`blastRadius` (круг-триггер — тот же
контракт, что у blast-атаки, оверлей рисует круг без нового читателя).
`ready-weapon` несёт `weaponId`/`itemUuid` и `cost.halves` из
записи системы; `drop-prone` — `statusId:"prone"`, `halves:0`; `unpin`
(issue #93) — шаг `test` с `input {type:"characteristic",
key:"willpower", characteristic:"willpower", testKind:"characteristic",
actionId:"unpin", unpin:true, endOfTurn:true, modifier, modifierBasis}`,
`cost.halves:0` — свободный end-of-turn тест по корбуке, верифицированный
контракт `api.rolls.prepareTest`. Preconditions: move
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
`cone-no-safe-aim`, кандидата нет. Для `overwatch` нужна видимая
угроза (`canAttack === true`, не `hidden`) или свежий `team-contact`,
но не собственная `last-known` память. Issue #54 меняет наведение:
конус смотрит на предсказанные позиции (route-waypoint / lead-точки /
точки контактов), а blast-оружие заявляет круг
`{shape:"blast", targetPoint, blastRadius}`
вместо сектора; melee-зона досягаемости сознательно пропущена.

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
  сдвиге) + `planner.validateSnapshot`. Self-inflicted сдвиги статусов
  самого плана (issue #93: успешный unpin снял `pinned`, drop-prone
  применил `prone`) executor накапливает в `run.selfStatusAdjust`
  (`added`/`removed`) и передаёт в validateSnapshot — они reconcile'ятся
  против планового baseline и не читаются как внешнее вмешательство
  (иначе end-turn после снятия pinned проваливался бы `statuses-changed`
  и форсировал ложный реплан). Реплан сбрасывает adjust: свежий снапшот
  уже несёт живые статусы.
- Шаги: `move` → `TokenDocument#move(..., {method:"api"})` с fallback
  `update({x,y})`; `attack`/`test` → `prepare*+execute*` системного API
  (`operationId.stepId`); `aim` → флаг на combatant'е, снимается
  атакой; `reload` → `api.actions.reload`; `overwatch` →
  `overwatch.declare` (только декларация, реакция — за GM);
  `ready-weapon` → `api.actions.readyWeapon`/`ready`/`equip` (без
  endpoint — `system-api-missing`); `drop-prone` → `api.actions.dropProne`
  или fallback `actor.toggleStatusEffect("prone")`; `end-turn` → ok.
- После исполненного `move` с `input.mode:"run"` executor ставит
  `flags["only-war-ai"].running` на актёре комбатанта (для unlinked-токена
  это синтетический актёр). Система учитывает −20 на дальних атаках по
  нему. Флаг снимается в начале следующего хода бегуна или в конце боя.
- Issue #37: успешная `attack` записывает `lastUsedWeapon` на combatant
  (controller-only) — planner читает его фактором `weaponInertia`.
- Attack adjudication (issue #37): в режиме `attackAdjudication
  "gm-confirm"` перед каждым attack/test шагом в automatic-режиме
  executor спрашивает GM — инъекция `context.adjudication` либо
  whisper-чаткарта с кнопками `execute | manual | skill-test | cancel`
  (`renderChatMessage`-биндинг только для контроллера, `updateCombat`/
  `deleteCombat` авто-отменяют ожидание). `manual` считает шаг исполненным
  без ролла; `skill-test` подменяет канал `prepare/executeTest`; `cancel`
  завершает ход `cancelled` + `completeTurn(advanceTurn:false)`. Гейт
  ограничен таймаутом `previewTimeoutSeconds` (issue #52: без ответа —
  `cancel`, ход возвращается GM; `0` — ждать вечно), а отсутствие
  chat-канала/ошибка `ChatMessage.create` — fail-closed `cancel`
  (`adjudication-unavailable`): в мире `gm-confirm` необратимые роллы
  без спроса не делаются. В preview-режиме гейт не работает — диалог
  предпросмотра уже является единственной точкой подтверждения, GM не
  спрашивается дважды.
- Replan: `shouldReplan`, макс `DEFAULT_MAX_REPLANS = 1`; reset
  `stepIndex=0`; неудачный реплан → `plan-failed`.
- Финиш: `operations.completeTurn` + продвижение хода через
  `operationCompleted`-хук или `_advanceForOperation` (сериализованный
  `nextTurn` + verify windows 600/1200/2400, 2 retry).
- Попадание откладывает `nextTurn`: `executor/damage-wait.js` ждёт
  применения всех попаданий на связанных карточках. Бот не применяет
  урон сам. С `damageWaitAutoAdvance: false` после применения ход
  переводит GM. Сквозная проверка — [сценарий T33](test-scenarios.md#t33-урон-применяет-владелец-цели).
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
  складывает в `vulnerable` и режет damage-scaled `ev`-фактор;
  `breakdown.dodge` показывает вердикт.
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
  атрибуция, прирост/отсутствие изменений — нет. `start()` сеет кэш по
  `game.actors`, `createCombat` — по комбатантам нового боя: первая
  потеря ран после подключения уже атрибутится.
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
- LOS: стены и собственный источник зрения NPC, не сводная видимость GM.
  Если зрение токена отключено, используется геометрическая проверка стен.
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
- Если геометрический маршрут укладывается в бюджет, но замер Foundry
  делает его недоступным, навигация ищет доступный обход с ограничением
  числа проверок. Стоимость оценивается по всему префиксу пути,
  в том числе при чередующейся стоимости диагоналей.
- `checkCollision`: polygonBackends → `walls.checkCollision` → ручной
  сегментный fallback; `hasLineOfSight` — отрицание sight-коллизии;
  v13/v14 схемы стен; terrain-совместимость routinglib/terrain-ruler и т.п.

## 9. Fireteams (fireteam.js)

- Задачи `FIRETEAM_TASKS = [support, advance, flank, assault, regroup]`;
  характеры `[disciplined, shock, elite, rabble]`.
- `assignTasks`: явный override > regroup-флаг > лидер → assault >
  первый не-лидер → flank (≥2 члена, `allowFlank`) > остальные support.
  Override обратно совместим: legacy-строка `"support"` читается как
  `{task:"support"}`, объектная форма — `{task, role?, element?, objective?}`.
  `role`/`element` — непустые строки, `objective` — member-scoped JSON-only
  объект; они копируются в assignment, `teamPlan.members[]`, diagnostics,
  compiled maneuver state и `context.team` исполнения. Неизвестный `task`
  по-прежнему деградирует в `support`; morale/GM demotion меняет только
  task/group и сохраняет метаданные. `context.team.objective` остаётся
  backward-compatible scalar id общей цели (`tactic.objective.targetId` или
  `context.objective.targetId`); member-scoped polymorphic objective идёт
  отдельно через `context.team.memberObjective` и канонический
  `context.team.assignment = {task, role?, element?, objective?}`. Если у
  member-objective есть `targetId`, он имеет приоритет над shared objective
  при вычислении `assignedTargetId`. Роли/элементы не входят в ключи
  reservations (`task|target`) и не меняют barriers.
- `evaluateCohesion` — мягкая: flank/assault могут отходить как
  `detached-maneuver` (лимит `maxDetachedPhases`, `rejoinAvailable`,
  штраф overshoot×0.25); остальные — `beyond-cohesion` штраф.
- Перед отделением планировщик проверяет маршрут от будущей позиции до
  свободной клетки в радиусе сплочённости вокруг будущей позиции лидера.
  Для гарантии достаточно одного полного перемещения по системному
  бюджету; если такого пути нет, выбирается безопасный `regroup-fallback`.
  Исполнитель отдельно проверяет, что в порядке инициативы останется
  ход на возврат до конца разрешённого раунда. Если расписание изменилось
  после выхода, возврат в срок имеет приоритет над оставшейся атакой.
- Резервации учитывают footprint на всех клетках маршрута и диагональных
  переходах. Клетки, занятые другим назначением, нельзя использовать даже
  для прохода. После перепланирования конфликтующие маршруты не принимаются.
- Лидер: flagged > инициатива > HP > seeded-хэш > id.
- `buildTeamPlan`: фазы 0 movement → 1 action → 2 regroup; конвергенция
  фокус-файра когда Σ EV ≥ wounds цели (#16); командный манёвр резолвится
  через per-preset tactic registry (issue #92; explicit `context.tactic`
  по-прежнему выше, specOps зарегистрирован базовым селектором);
  `leader-lost` инвалидирует план.
- `collectMembers` дополнительно отдаёт тактикам `turnIndex` из
  `combat.turns` и `hasActed` для текущего раунда (`turn:null` — false).

### Исполнение TeamPlan в бою

- При первом подходящем ходе контроллер строит черновик без записи
  документов. Перед первым шагом проверяются участники и достижимость их
  назначенных клеток. Запись `flags["only-war-ai"].teamManeuvers` на Combat
  содержит оставшиеся назначения, ожидаемые позиции и метки прогресса, а
  не старые снапшоты или броски. Нужны минимум два участника с работой.
- Пока есть невыполненные перемещения, атакующая фаза закрыта. Если у
  текущего NPC нет доступного шага, он передаёт инициативу. Если флангер
  дошёл позже стрелка, стрелок может атаковать не раньше своего
  следующего хода. В `preview` GM подтверждает и такой пропуск.
- После атак отделившиеся участники возвращаются на обычных ходах.
  Путь строится заново по текущей геометрии и бюджету; если не удаётся
  найти его или истёк срок отделения, оставшиеся шаги отменяются.
  Если на подтверждении превью путь возврата уже невалиден, NPC не
  перемещается по нему.
  Секция «План отряда» в превью показывает будущие маршруты, затраты,
  общий замысел и условия воссоединения, но подтверждает только один ход.
- Перед первой атакой заново проверяются все оставшиеся атакующие:
  собственная видимость цели, доступное оружие и бюджет. Сохраняется
  задержка передачи хода при ожидании применения урона.
- Смена контроллера, потеря обязательного участника, ручное перемещение,
  устаревший маршрут или обрыв исполняемого хода отменяют остаток.
  Сделанные перемещения и броски не откатываются. Следующий подходящий
  ход строит новый манёвр или индивидуальный план из текущего состояния.
- Прогресс действителен до конца следующего раунда. Нет отдельной
  очереди инициативы или общей кнопки подтверждения. Сложные планы со
  самостоятельным setup-действием пока идут через индивидуальный
  планировщик. Runtime-барьер не использует системный `delay`.

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
  движение и blast-удар по точке разрешены, прямой атаки нет. В отличие от
  собственной `last-known` памяти, `team-contact` **крутит конус
  overwatch** — свежие координаты от живого тиммейта валидны для
  ориентации зоны огня (#30-правило для своей памяти сохраняется).
- Самовольство: флаг черты `distrustsContacts` (у `loner`) или командный
  характер `rabble` сбрасывают общие контакты целиком — бот не доверяет
  чужой разведке, собственная память работает как раньше.
- Записей в отдельное хранилище нет — контакты читаются из существующей
  памяти членов; запись остаётся controller-only на каждом combatant.

### Синхронный удар (delay)

- `_syncDelay` — post-pass `buildTeamPlan` после планов членов (и после
  retry перераспределения): если есть конвергентная цель и флангер с
  move-only планом (ETA ≥ 1 хода), main-члены, чей план атакует
  `convergence.targetId`, получают delay-stub план `[delay, end-turn]`
  (unpin-шаг pinned-члена сохраняется перед end-turn, issue #93).
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
  `command`, прошло `ORDER_COOLDOWN_ROUNDS = 3` раунда с `lastOrder`.
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
заявленные зоны в тот же корень (конусы — общий `coneFanPoints`,
blast-декларации — круг по `targetPoint`/`blastRadius`, issue #54); сервис
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
  `replayPlan` проверяет воспроизводимость фикстур с явными входными
  данными; см. [ограничения replay](layers.md#replay-захват).
