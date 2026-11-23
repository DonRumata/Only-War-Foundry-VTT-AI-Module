# Only War AI — правила для разработки

## Назначение

Модуль `only-war-ai` — opt-in AI для системы Foundry VTT `only-war-local`
(Warhammer 40,000: Only War). Каркас создан по issue #399 эпика #363; игровая
система предоставляет только стабильные правила и публичный API
`game.darkHeresy.api` (issue #398) — модуль не импортирует `script/common/*`
системы.

Сводка возможностей API и ботов + явные границы — `docs/capabilities.md`.
Baseline-спецификация поведения (факторы, веса, pipeline кандидатов,
жизненный цикл хода) — `docs/behavior.md`; точка отсчёта для слойного
рефактора #24/#25/#26/#27.

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

- Actor: `config = { enabled: boolean, preset: string|null,
  includeNeutral?: boolean, preferredWeapon?: string }` — `includeNeutral`
  разрешает атаковать нейтральные токены (владение, казни заложников и
  т.п.); `preferredWeapon` (issue #37) — uuid/id/имя предпочтительного
  оружия, скорится фактором `weaponAffinity`.
- Token: `override = { mode: "inherit"|"enabled"|"disabled", preset: string|null }`.
- Combatant: `override = { mode: "inherit"|"enabled"|"disabled", preset: string|null }`
  — временный override с наивысшим приоритетом.
- Combatant: `reactionUsed = { round, reason }` (issue #37) — реакция
  потрачена в текущем раунде; пишет только контроллер, сбрасывается
  сервисом `reactions` в начале хода владельца. Рекорд без `round`
  считается потраченным, рекорд прошлого раунда — уже неактивен.
- Combatant: `lastUsedWeapon = { itemUuid, itemId, name, actionId,
  round }` (issue #37) — последнее оружие успешной атаки; пишет
  executor после `executeAttack`, читает planner (фактор
  `weaponInertia`).
- Combatant: `lastAttacker = { tokenUuid, tokenId, actorId, round, turn,
  woundsLost, attribution }` (issue #39) — кто последний нанёс урон
  боту; пишет сервис `grudges` по `updateActor` + targeted-карточкам
  чата, читает planner (фактор `grudge`). Рекорд живёт
  `GRUDGE_MAX_AGE_ROUNDS` (2) раунда, снимается доказанной смертью
  атакующего; в stale-fingerprint не входит.
- Combatant: `lastOrder = { round, orderId, result }` (issue #38) —
  последний успешный приказ лидера; пишет executor только после
  успешного order-теста, читает fireteam (кулдаун
  `ORDER_COOLDOWN_ROUNDS = 5` раундов).
- Combatant: `delaySync = { round, until, count }` (issue #38) —
  буккипинг синхронного удара: счётчик повторных delay-ожиданий одного
  `until`; пишет executor delay-шагом, читает `_syncDelay` (предел —
  `DEFAULT_MAX_SYNC_ROUNDS = 2`).
- Combatant: `committedPlan = { id, status, combatId, combatantId,
  createdRound, createdTurn, ttl, source, steps, expectedState,
  cancelledReason? }` (issue #25) — действующий многоходовый план L1;
  пишет только controller через executor (hit — обновление
  `expectedState.self`, скореный план — новая запись, инвалидация —
  штамп `cancelled`). `expectedState` — компактный отпечаток
  `{self, target, morale, threats}`.
- Combatant: `moveJournal = [{round, turn, x, y, elevation,
  operationId}]` (issue #25) — bounded (32) журнал собственных
  перемещений executor'а; источник истины «свой ход vs GM-перенос»
  при валидации `expectedState.self`.
- Combatant: `gmControlled = { round, turn, reason }` (issue #25) —
  пометка `gm-intervention` на один раунд; файртим понижает меченного
  члена со сложных заданий (flank/assault/advance → support).
- Combatant: `captureJournal = [{version, at, preset, config, flags,
  context, snapshot, result}]` (issue #27) — bounded (8) журнал
  replay-захватов: санитизированный `planContext` + AI-флаги + snapshot
  + отпечаток результата (`steps`, `winner`, `trace`); пишет executor
  при `aiCaptureContext`/`context.capture`, только controller. Каждая
  запись — готовая фикстура `replayPlan` (tests/unit/replay-helpers.mjs):
  JSON → `planTurn` → идентичный план и трасс.
- Combatant: `morale` (issue #26) — рекорд позы файртимы; evaluated
  форма `{tier, pending, counters, losses, seenEnemies, leaderId,
  combatId, round, state, schema}` пишется только controller'ом на всех
  живых членов при `buildTeamPlan`; короткая форма `{state|tier:
  "confident"|"pressured"|"desperate", pressured?, desperate?}` —
  ручной членский оверрайд (не перезатирается оценкой). Гистерезис 2
  раунда; гибель лидера форсирует переход. Headcount `enemies` — только
  увиденный противник (`seenEnemies` + членские `memory` + live-LOS).
  Легаси-чтения: `desperate` снимает delay-ожидание (member-effective
  tier), `pressured` усиливает фактор `order`. Отсутствие флага =
  нормальная мораль.
- Combatant: `overwatch` (issues #14/#54) — декларация зоны овервотча;
  пишет только controller через сервис `overwatch`, живёт до хода
  владельца/перемещения токена. Конусная форма `{shape:"cone", direction,
  arc, range, combatantId, tokenId, sceneId, weaponId, weaponName,
  attackType, round}`; blast-форма `{shape:"blast", targetPoint:{x,y}
  (пиксели), blastRadius (ед. сцены), range, ...}` — круг-триггер
  «враг вошёл → граната туда».
- Actor/Token/Combatant: `personality = string[]` — явный список черт
  личности (issue #19, id из пула `scripts/personalities.js`); резолвится
  той же цепочкой Combatant → Token → Actor, без флага черты
  генерируются seeded по `actor.id`.
- Actor/Token/Combatant: `fireteam = { teamId, leaderId, teamPreset,
  preferredCohesion, character }` — `character` (`disciplined|shock|
  elite|rabble`, issue #19) задаёт командный overlay на веса всех членов.
- World settings: `masterEnabled` (default `true`) — общий выключатель модуля:
  при выключении ходы не заявляются и не исполняются, preview не открывается,
  внедрённые UI-секции скрыты, executor отвечает `module-disabled`.
  `executionMode = "automatic"|"preview"` (default `"preview"`),
  `diagnosticsEnabled` (default `false`), `preferredCohesion` (default 5),
  `previewTimeoutSeconds` (default 60, `0` — без авто-отмены),
  `turnPacingMs` (default 800, `0` — без паузы) — пауза между шагами
  AI-хода и перед `combat.nextTurn()`, чтобы автоходы оставались
  наблюдаемыми. `threatMapOverlay` (default `false`, issue #36) —
  персистентный тумблер GM-only отладочной теплокарты угроз.
  `attackAdjudication` (default `"auto"`, issue #37) — арбитраж атак:
  `auto` — бросок через системный API сразу, `gm-confirm` — перед каждым
  attack/test шагом (только `executionMode === "automatic"`) GM получает
  whisper-чаткарту с решениями `execute | manual | skill-test | cancel`.
  `layersCommitment` (default `true` — L1 реализован, issue #25),
  `layersMorale` (default `true` — L2 реализован, issue #26) и
  `layersPersonality`/`layersLookahead` (default `true`, issue #24) —
  тумблеры слоёв воронки поведения L0–L4; дефолты живут в
  `DEFAULT_LAYER_FLAGS`, план-оверрайд — `context.layers` (см.
  `scripts/layers.js`, контракт — `docs/layers.md`).
  `manualOverrideGrace` (default `false`, issue #25) — ручной перенос
  токена GM: off — `gm-intervention` (отмена committed-плана + реплан),
  on — безусловный ход, план продолжается с новой позиции.
  `aiTraceVerbose` (default `"compact"`, issue #27) — рендер трасса
  решений: `compact` — строка вердикта на слой (сгруппированные вето,
  объединённый скоринг), `full` — строка на каждую запись
  `{layer, code, detail}`.
  `aiCaptureContext` (default `false`, issue #27) — запись
  `captureJournal` (bounded 8 захватов `planContext`+snapshot на флаге
  комбатанта) для офлайн-реплея `planTurn`.
  `moraleDesperateRatio` (default `2`, issue #26) — кратность перевеса
  врагов, при которой численность одна предлагает `desperate`
  (`enemies >= members × ratio`; 5 на 10 — грань, малый недобор —
  pressured). План-оверрайд — `context.moraleOutnumberRatio`.
- Combat: `operation = { id, combatId, combatantId, round, turn, controllerId,
  phase, revision, startedAt, completedAt?, reason?, result? }` —
  авторитетная запись жизненного цикла AI-хода; пишет только
  выбранный controller (issue #400).

Системный namespace `flags["only-war-local"]` модуль не хозяйничает, но
читает/пишет по контракту системы: `delay`-шаг (issue #38) ставит
`delayed = true` — трекер `only-war-local` сам снимает его при начале
следующего хода комбатанта (`clearExpiredStates`), модульное ожидание
синхрона живёт отдельно в `delaySync`.

Фиксированные пресеты: `assault`, `rangedCover`, `hold`, `specOps`.

## Pure resolver

`scripts/config-resolver.js` → `resolveEffectiveConfig(actorOrTokenOrCombatant)`
возвращает `{enabled, preset, source, includeNeutral?, personality?}`
(`source`: `"combatant" | "token" | "actor" | "none"`; `includeNeutral`
присутствует только при `true`: override > actor config; `personality` —
только при непустом списке черт из флага, issue #19). Приоритет Combatant →
Token → Actor → disabled. Resolver
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

## Perception (issue #401)

`scripts/perception.js` — сервис `perception` (`api.services`):

- LOS/видимость строго с перспективы NPC-токена: `hasLineOfSight(from, to)`
  обходит `canvas.visibility.testVisibility` (v13+) → `canvas.effects.visibility`
  → `token.testVisibility` → `visionSource` → геометрический fallback по стенам
  (`canvas.walls.checkCollision` или ручной тест сегментов; v13 и legacy-схемы
  `sight`/`door`). GM-only данные не используются: скрытые от NPC токены не
  попадают в цели только потому, что controller — GM.
- `visibleTargets(token)` — кандидаты в цели: противоположная disposition
  (hostile↔friendly; neutral — только через `includeNeutral`/`dispositions`),
  без dead/defeated/hidden; `blinded` viewer не видит никого. Записи:
  `{tokenId, tokenUuid, actorId, name, sceneId, disposition, x, y, elevation,
  distance, hidden, canAttack}` — hidden-цели никогда не атакуемы.
- `buildPerceptionSnapshot({combat, combatant, token, includeNeutral,
  dispositions})` — immutable `{status, sceneId, round, turn, viewer,
  visibleTargets, lastKnownTargets, revision}`; без сцены/токена —
  `perception-unavailable`. `includeNeutral`/`dispositions` пробрасываются
  в `visibleTargets` (конфиг `config.includeNeutral` доезжает через
  planContext из эффективной конфигурации).
- Память последней позиции на флаге Combatant
  `flags["only-war-ai"].memory[targetTokenUuid] = {sceneId, x, y, elevation,
  lastSeenRound, lastSeenTurn, dispositionAtDetection}` — sanitized, без
  actor-данных и текущих скрытых координат; пишет только authority controller
  (`authority.isController()` при наличии сервиса #400, иначе `game.user.isGM`).
  Запись истекает через 3 полных раунда без повторного обнаружения; last-known
  разрешает поиск/движение, но не прямую атаку. Pure-функции: `sanitizeMemory`,
  `rememberContact`, `expireMemoryEntries`, `pruneMemory`, `isMemoryExpired`.
- `scoreTarget(npc, target, {weights})` / `rankTargets` — pure
  детерминированный utility: canAttack-гейт, ожидаемая эффективность
  (damage + penetration − armour), угроза, дистанция; веса пресета через
  `context.weights`.
- Общие контакты отряда (issue #38): `mergeTeamMemory` — pure-дедуп
  памяти членов с provenance `sourceCombatantId`;
  `teamLastKnownPositions(combat, combatant, teamId)` — только живые,
  enabled и стоящие на сцене тиммейты делятся памятью;
  `buildPerceptionSnapshot({teamMemory})` маркирует чужие записи
  `source:"team-contact"`. Отдельного team-contact store не существует —
  читается существующая память членов, запись остаётся controller-only.
- Debounce ~150 мс на `updateCombat` (round/turn), `updateToken`
  (x/y/elevation/hidden/disposition/sight), `deleteToken`, `canvasReady`.

## Planner (issue #403, статусы/типы атак — #413)

`scripts/planner.js` — сервис `planner` (`api.services`): `planTurn(combat,
combatant, context)` строит immutable DTO-снапшот и детерминированно выбирает
план из кандидатов (`attack-in-place`, `move-attack`, `charge`, `approach`,
`hold`) по взвешенному factor-вектору пресета; равные оценки разрешаются
mulberry32 по `plan.seed`. План сериализуем (`move`/`attack`/`test`/
`end-turn` шаги), `validateSnapshot` перед каждым state-changing шагом
сверяет дешёвый fingerprint и выдаёт стабильную причину (`turn-stale`,
`token-moved`, `target-gone`, `resources-changed`, `collision-changed`,
`statuses-changed`, `combat-ended`); `shouldReplan` разрешает не более
`maxReplans` (default 1) перепланировок за ход.

Типы атак системного API (`actions.list(actor)` — по записи на attackType
на оружие): недоступные (`available === false`) отбрасываются; для каждого
оружия сохраняется до 3 типов в курируемом порядке — melee `[allOut,
charge, standard, lightning, swift, called_shot]`, ranged `[full_auto,
semi_auto, standard, ripper_charge, called_shot, suppressing_fire]`;
`suppressing_fire` достижим — step-контракт несёт `targetPoint`/`template`
(issue #14). Вариант `charge` использует
действие с `attackType: "charge"` того же оружия, если оно есть. Новые
факторы: `attackType` (привлекательность типа атаки), `vulnerable` (цель
pinned/prone/stunned), `engaged`/`meleeEngage` (контакт ближнего боя после
движения) — веса заданы в `scripts/presets/*.js`.

Тактические факторы (issue #39): `alliedEngagement` — точечная (не
melee/blast/cone) атака по цели, стоящей в melee-reach союзника из
`_blastTokens` (та же disposition; нейтралы — только с `includeNeutral`;
сам бот и цель не считаются); `leaveMeleeEngage`/`engageDenial` —
поконтактный учёт свободной атаки: выход кандидата из melee-reach врага
и вход в него снаружи (reach — melee-эмиттеры threat-профиля, фолбэк
`DEFAULT_MELEE_RANGE` = 2); `unpin` — синтетический full-cost WP-тест
для pinned-бота (`test`-шаг `type:"characteristic", key:"willpower"`,
rejected `unpin-unavailable` без характеристики); `grudge` — цель
совпадает с записью флага `lastAttacker` (сервис `grudges`, ниже).

Blast-awareness: blast-действия (`blastRadius` из `item.system.blastRadius`
или `traits.blast`, метры) не целятся в токен — `_bestBlastAim` перебирает
точку центра цели + 8 оффсетов на полрадиуса и выбирает максимум покрытых
hostiles при строгом запрете союзных/нейтральных (нейтрали легальны только
при `includeNeutral`) токенов в шаблоне (`_blastTokens` — инъекция
`context.blastTokens` в тестах, canvas placeables live, боевой fallback).
LOS до точки обязателен, кроме ударов по last-known позиции («зачистка
комнаты» — запомненная точка считается одним предполагаемым hostile,
`rangedCover` освобождает такие броски от LOS-вето). Шаг несёт
`input.targetPoint` + `input.blastRadius` (issue #29 — зона для GM-
оверлея и системного шаблона) → `prepareAttack`. Фактор `area` =
min(blastHits/2, 1); веса в пресетах (assault 4, specOps 5, rangedCover
3, hold 2).

Конусы (spray/`suppressing_fire`, overwatch): ориентация строго по
воспринимаемым якорям (issue #30) — `_bestConeAim` наводит сектор только
на записи `targets` (видимая цель — живая позиция, last-known —
запомненная точка); hostile-токены сцены без восприятия шаблон не
наводят, но по-прежнему срабатывают в вето союзников/нейтралов.
`overwatch`-кандидат заявляет зону лишь на видимую угрозу
(`canAttack === true`, не `hidden`), но наводит её на предсказанные
позиции (issue #54): nav-waypoint кратчайшего маршрута ближайшей угрозы
(`planRoute(threat → self)`, точка ~на половину её полухода), lead-точки
`min(halfMove, dist)` всех видимых угроз и позиции memory-контактов;
все якоря идут в `_bestConeAim`, bearing — fallback. Геометрия зоны по
оружию: cone 45°, spray — собственный конус `_coneSpecOf`, blast —
круг `{shape:"blast", targetPoint, blastRadius}` (второй тип зоны в
`overwatch.declare`; melee пропущен). Шаг сериализует
`template {direction, angle, range}` + `covered`/`suppressionFire`/
`burstMode` — geometry хватает и системе, и GM-оверлею (#29).

Статусы: `snapshot.self.statuses` — отсортированные id из `actor.statuses`
+ статусов токен-документа (+ `context.selfStatuses` для тестов); входят в
stale fingerprint, расхождение даёт причину `statuses-changed`. Цели
(`visibleTargets`, combatant-fallback) несут `statuses` — только id, без
actor-данных; в fingerprint цели не входят. Детерминированные ограничения:
`stunned` — короткий ok-план из одного `end-turn` с причиной `stunned`;
`pinned` — вето `charge` и любых перемещений, заканчивающихся ближе к цели
(`move.distance < target.distance`), легальны атака на месте и движение с
сохранением/увеличением дистанции; `prone` — бюджет движения делится
пополам (floor, ползком; `{mode}` → `half`) и вето `charge`.

Free-действия и реакция (issue #37): `ready-weapon` — явные записи
`kind:"ready"|"draw"|"equip"` из `actions.list` планируются с `cost`
системы (free под Quick Draw; таланты не парсятся), иначе синтез из
инвентаря при сухом списке атак (`clip.value === 0` у всех атакующих) —
half-cost кандидат; `drop-prone` — free-шаг `statusId:"prone"` при
pinned или `danger ≥ 0.5` на своей клетке. Факторы `weaponAffinity`
(`preferredWeapon` конфига — полный вес, affinity-спека черты личности —
половина) и `weaponInertia` (флаг `lastUsedWeapon`). Counter-EV:
`dodgeChanceOf(target, action)` → `{dodgeable, chance}` — TN уворота
цели (поле `dodge` записи цели, дефолт 30, cap 0.95); недоджибельные —
spray/cone/suppression, blast без доказанного выхода из зоны за
half-move, цель `reactionUsed`. Фактор `attackType` несёт
`desire × (1 − chance)`; цель с потраченной реакцией добавляет
`vulnerable` (planner читает флаг документа её комбатанта); бот с
потраченной реакцией не декларирует overwatch (`reaction-used`).

## Реакции (issue #37)

`scripts/reactions.js` — сервис `reactions` (`api.services`): учёт слота
реакции через `flags["only-war-ai"].reactionUsed` на Combatant. Пишет
только контроллер (`authority.isController()` иначе `game.user.isGM`),
читают все клиенты — включая цели-комбатанты. `markUsed({combat,
combatant, reason})`, `markUsedByToken(combat, tokenId)`,
`clear(combatant)`, `reactionUsedOf(combatant, combat)` (толерантно к
рекорду старого раунда), `handleUpdateCombat` — вотчер `updateCombat`,
сбрасывающий флаг владельца в начале его хода. Писателями реакции
сейчас выступают системная сторона/GM-макросы — модуль только хранит и
читает состояние.

## Граджи (issue #39)

`scripts/grudges.js` — сервис `grudges` (`api.services`): учёт
`flags["only-war-ai"].lastAttacker` на Combatant. Пишет только
контроллер (тот же паттерн, что `reactions`). `handleUpdateActor` —
вотчер `updateActor` с in-memory кэшем `wounds.value + wounds.critical`
на actorId (старое значение в hook недоступно); потеря ран →
консервативная атрибуция `attributeLastAttacker` по targeted-карточкам
чата: `damageOperation`-summary системы (`target` — бот, `source
.messageId` — damage-карточка атакующего) либо `rollData.damages[]` с
`targetActorId`/`targetTokenId` бота. Self-damage и доказуемо
дружественная карточка не пишутся; без targeted-свидетельства —
нет записи вообще. `grudgeActive` — окно `GRUDGE_MAX_AGE_ROUNDS = 2`
раунда; `grudgeOf` — читатель с проверкой экспирации и смерти
атакующего (defeated/destroyed). `seedWounds` — тест/инспекция кэша.

## Слои поведения L0–L4 (issue #24)

`scripts/layers.js` — pure-модуль воронки планирования; полный контракт —
`docs/layers.md`. Порядок в `planTurn`: гейты L0 (gridless, статусы,
права) → L1 `applyCommitmentLayer` (issue #25: флаг `committedPlan` или
инъекция `context.commitment` — валидная запись исполняется без
скоринга; `expectedState`-валидация с кодами `ttl-expired`,
`gm-intervention`, `target-gone`, `morale-changed`, `threat-drift`,
`combat-ended`, `l0-veto`) → L2 `applyMoraleLayer` (issue #26: командный
tier морали + member-effective tier через исключения черт — `fanatic`
игнорирует `desperate`, `cowardly` эскалирует `pressured`; effective tier
сужает скоринг bounded-дельтами `MORALE_POSTURE_DELTAS`) → L3
`boundedPersonalityOverlay`
(дельты #19 в скобе ±30% от базы; нулевая база — ±6 от
`L3_DELTA_BASE_FLOOR = 20`) → генерация кандидатов (L0-вето через
`rejectL0`) → L4 scoring + lookahead (гейт `layersLookahead` поверх
difficulty/`context.lookahead`). Каждый слой пишет унифицированную
запись `{layer, code, detail}` в `diagnostics.layers`; тумблеры плана —
`diagnostics.layerFlags` (`resolveLayerFlags` =
`context.layers` > world settings > `DEFAULT_LAYER_FLAGS`); поза —
`diagnostics.morale` (`{tier, effectiveTier, shift?}`); зажатые дельты —
`diagnostics.personality.clamped`.
Выключенный слой деградирует на предыдущий уровень; поведение при
дефолтах идентично прежнему, кроме документированной скобы L3.

## Трасс решений (issue #27)

`scripts/trace.js` — pure-рендер поверх `diagnostics.layers` +
replay-захват; полный контракт — `docs/layers.md` (раздел трассировки).

- `buildLayerTrace(diagnostics)` материализует `plan.diagnostics.trace`
  — одна сериализуемая запись `{layer, kind, ...}` на каждую
  reason-запись (L0-вето с кандидатом, L1 hit/miss/код инвалидатора,
  L2 posture/shift, L3 traits+дельты по факторам, L4 scored/lookahead/
  easy-slip/winner). `run.trace` executor'а зеркалит её.
- `renderTrace(entries, {i18n, mode})` — локализованные строки
  `L<#>: …`; `compact` (настройка `aiTraceVerbose`) сворачивает L0-вето в
  одну строку по кодам и L4 в одну scoring-строку (top-3, дельта
  победителя, top-3 |вклад| факторов), `full` — строка на запись.
- Winner-рекорд L4 несёт `top` (top-3 `{candidate, score}`), `runnerUp`,
  `margin` и `factors` — разность вкладов `w × f` победителя и
  runner-up, top-3 по |дельте| (`factorDelta`); easy-slip оставляет
  отрицательную дельту видимой.
- `compactTraceLine(diagnostics)` — однострочный GM-шёпот остановленного/
  отменённого хода («plan cancelled: gm-intervention; morale
  desperate; winner …») в диагностическом чат-репорте executor'а.
- Превью: свёрнутый блок «Как думал» (`OWAI.Preview.Trace`) рендерит
  `traceLines` режимом настройки — без гейта `diagnosticsEnabled`.
- Replay: `buildCaptureEntry`/`appendCaptureEntry`/`sanitizeCaptureContext`
  — санитизированный bounded (8) журнал `captureJournal` на комбатанте
  (записываемые AI-флаги + planContext + snapshot + отпечаток плана);
  `tests/unit/replay-helpers.mjs` `replayPlan(capture)` перепрогоняет
  `planTurn` детерминированно (JSON → идентичные steps/score/trace).
  Трасс никогда не влияет на выбор плана: это только диагностическая
  поверхность.

## Личности ботов (issue #19)

`scripts/personalities.js` — data-driven пул из 24 черт (`PERSONALITIES`,
категории courage/skill/maneuver/command): каждая черта несёт аддитивные
`deltas` на веса `SCORE_FACTORS` (плюс preset-only `flankAngle`/
`cohesionRestore`), `jitter`-смещение, базовый `weight` и `bias` по
сложности, опционально `flags` (`fanatic.ignoreRegroup` реализован
дельтами — отдельных веток кандидатов нет). `resolvePersonality` —
приоритет `context.personality` (`false` отключает систему) → флаг
`personality` (из `resolveEffectiveConfig`) → seeded генерация
`generatePersonalityTraits` (fnv1a+mulberry32 от `actor.id`/`tokenUuid`,
1–2 черты взвешенным пулом, bias по `aiDifficulty`; стабильна между
клиентами и боями). `boundedPersonalityOverlay` (`scripts/layers.js`, issue #24) мерджит
дельты поверх `preset.weights` до scoring'а со скобой ±30% от базы
(паттерн SPEC_OPS-оверлеев, но аддитивный);
личные дельты заменяют командные при конфликте фактора. Jitter —
`personalityJitterFactor`: seeded мультипликатор `1 ± amp` на оценку
кандидата keyed по candidate id; `amp` = baseline сложности
(easy 0.04/normal 0.02/hard 0) + черты + `fireteam.character`, кап 0.15.
`fireteam.character` (`disciplined|shock|elite|rabble`) — поле флага
через `resolveTeamConfig`, едет в `context.team.character` всех
member-планов `buildTeamPlan` и в `teamPlan.character`. Видимость:
`plan.personality {traits, character, source}`, `diagnostics.personality`
(+`flags`, `jitter`), `breakdown.jitter`, строка в GM preview
(`OWAI.Personality.*`/`OWAI.FireteamCharacter.*`), ввод черт +
resolved-строка и селект характера в NPC-sheet.

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
`ready-weapon` — `api.actions.readyWeapon`/`ready`/`equip` (без
эндпоинта — `system-api-missing`); `drop-prone` — `api.actions.dropProne`
или fallback `actor.toggleStatusEffect("prone")`. `delay` (issue #38) —
системный флаг `flags["only-war-local"].delayed` + модульный `delaySync`
буккипинг синхронного удара. Успешная `attack`
пишет `lastUsedWeapon` на combatant (issue #37); успешный `test` с
`input.orderId` пишет `lastOrder` (issue #38, кулдаун приказов). Adjudication
(issue #37): `attackAdjudication === "gm-confirm"` и режим `automatic` —
перед attack/test шагом `context.adjudication` резолвер (тесты,
интеграции) либо GM-чаткарта (`renderChatMessage`-биндинг решений,
`updateCombat` авто-отменяет ожидание); `manual` — шаг исполнен без
ролла, `skill-test` — канал `prepare/executeTest`, `cancel` —
`cancelled` + `completeTurn(advanceTurn:false)`; в preview-режиме гейт
не срабатывает — GM уже подтвердил план в диалоге. Stale → один replan
через `planner.shouldReplan`; повторный stale — hold-and-report.
operationId дедупликация: повторный вызов возвращает
прежний результат, roll-шаги проксируют step-scoped operationId, move к
уже достигнутой точке пропускается. Темп: между шагами и перед
`nextTurn()` вставляется пауза `turnPacingMs` (deps `pacing`, `0` — без
паузы). Терминальные статусы
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

## GM canvas overlays (issues #29/#30/#36)

`scripts/ui/plan-overlay.js` — сервис `planOverlay` (`api.services`) и
общий GM-only корень PIXI-контейнеров `ow-ai-overlay` на слое templates:
именованные подслои `plan`/`overwatch`/`danger`, чистый клиентский рендер
— без записи документов и broadcast, виден только GM (`plan` — только
контроллеру, как и preview-диалог). Превью плана (issue #29) рисует
route-полилинию со стрелкой на финальную клетку, конусы по сериализованным
`template`/`overwatch` шагам, круг blast `targetPoint`+`blastRadius` и
подсветку цели; контроллер preview вызывает `showPlan` на open/replan/
stale и `clearPlan` на любом решении/снятии сессии. `overwatch.js`
(#14/#30/#54) рисует заявленные зоны в тот же корень: конусы через общий
`coneFanPoints`, blast-декларации — круг по `targetPoint`/`blastRadius`. Danger-heatmap (issue #36): world setting
`threatMapOverlay` + GM-keybinding Alt+M (`restricted`) —
`setDangerEnabled`/`toggleDanger`/`setDangerMode` (`"plan"` — карта
текущего бота `threatMap.map()`, `"all"` — агрегат по hostile-комбатантам);
`dangerShade`/`dangerCells` — детерминированные pure-функции, top-8 клеток
подписываются вкладчиком из `explain`. Сервис подписан на
`canvasReady`/`canvasTearDown`/`updateCombat`/`deleteCombat`; `describe()`
/`model()` — точки интроспекции для e2e.

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
