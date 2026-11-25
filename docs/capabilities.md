# Only War AI — возможности API и ботов

Сводная документация по контракту системы `only-war-local` (`game.darkHeresy.api`,
system API v1.x, issue #398/PR #440) и тому, что на нём построено в модуле
`only-war-ai` (эпик #363). Документ — точка входа для понимания поведения;
реализация описана в `AGENTS.md`.

## 1. Системный API (`game.darkHeresy.api`)

Публикуется ядром системы; модуль — отдельный opt-in, ничего из
`script/common/*` не импортирует.

| Эндпоинт | Что делает |
|---|---|
| `api.version` / `api.capabilities` | `version` (`"1.x"`, major-совместимость), мапа поддерживаемых операций |
| `api.movement.getRates(actor)` | `{half, full, charge, run}` — скорости движения актёра (метры) |
| `api.actions.list(actor)` | Записи действий: по записи на `attackType` на оружие (`standard`, `semi_auto`, `full_auto`, `ripper_charge`, `called_shot`, melee: `allOut`, `charge`, `swift`, `lightning`, `suppressing_fire` при `canSuppress`) + `{id:"reload", kind:"reload"}` для clip-fed оружия (`cost` из `system.reload`, `spans` для «2 Full», `cause` недоступности). Поля: `{id, kind, weaponId, weaponName, attackType, cost, requirements[], available, reason}`. `available:false` когда тип запрещён RoF/блоком оружия |
| `api.actions.reload(input, {operationId})` | Перезарядка clip-fed оружия: магазинное — своп на `magazineItemId` или самый полный совместимый запасной, интегральный клип — до `clip.max`. Идемпотентно по `operationId`, чат-карточка, `resourceDelta {clip, magazine}` |
| `api.rolls.prepareAttack(input)` | JSON-сериализуемый prepared-объект (`fingerprint`, `refs`, `rollData`, `preview`) — без броска и без трат ресурсов. Вход: `actorUuid|actorId`, `weaponId|itemUuid`, `targetUuid`, `attackType`, `targetPoint`, `template`, `suppressionFire`+burst-mode и флаги |
| `api.rolls.executeAttack(prepared, {operationId})` | Исполняет тест попадания и постит карточку в чат (speaker — актёр/токен атакующего, не выбор пользователя). Headless: диалоги не открываются, `game.user.targets` не читается |
| `api.rolls.prepareTest(input)` / `executeTest` | Тест характеристики/навыка/специальности (characteristic/skill/speciality) без UI |

**Идемпотентность.** Каждый `operationId` выполняется один раз: повторный вызов
возвращает прежний результат с `reason:"already-completed"`. In-memory реестр
(50 записей) + журнал на актёре `flags["only-war-local"].apiOperations`
(32 записи — переживает reload). Ресурсы не тратятся дважды.

**Контроль свежести.** `fingerprint` prepared-состояния перепроверяется на
execute: расхождение — `stale-state` (перемещение, смена ресурсов и т.п.).

**Граница контракта: урон и уворот.** При обычном попадании `executeAttack`
создаёт карточку с кнопкой «Урон» (`.invoke-damage`). Бросок и применение
урона, уворот и пари — ручные действия, без headless-эндпоинтов.
В системе с [#470](https://github.com/DonRumata/Only-War-Foundry-VTT-System/pull/470)
владелец указанной цели при активном GM может применить попадание с
видимой чужой карточки, не выбирая токен. GM по-прежнему распределяет
попадания без указанной цели с чужих карточек.

**Требования на вход (`requirements`).** Машинно-читаемые коды:
`rateOfFire.burst|full`, `talent`, `charge`, `movement.charge`, `target`,
`targetPoint|target` (blast-оружие), `template` (spray/subpressing), `ammo`.
Чего нет — ошибка `action-unavailable`/`invalid-input`.

## 2. Архитектура модуля

Конвейер: **authority → perception → navigation → planner → executor**,
с fireteam-слоями и GM-preview поверх.

### Authority и lifecycle (issue #400)

- Детерминированный контроллер: активный GM с наименьшим user id —
  вычисляется одинаково на всех клиентах без голосования. Нет GM — статус
  `waiting-for-gm`, ничего не заявляется и не исполняется.
- `claimTurn` ключ: `combatId : combatantId : round : turn` — операция
  строго привязана к точному ходу; пропуски не накапливают «долги».
- Смена контроллера: незавершённые операции помечаются `controller-changed`,
  локальный процесс останавливается.
- Фазовая машина операции на флаге Combat: `idle → planning →
  awaiting-preview | executing → completed | failed | cancelled`
  (compare-before-update, идемпотентный `completeTurn`).

**GM-гибкость.** GM может двигать ботов руками, пропускать их ходы на любое
число раундов и возвращать авто-обсчёт в любой момент — заявка существует
только пока бот является текущим `combat.combatant`; ручное перемещение
токена делает план stale (`token-moved` → переплан); ручной `nextTurn`
снимает заявку. Мастер-выключатель `masterEnabled` гасит все хуки;
включение назад подхватывает следующий AI-ход (а при любом релевантном
обновлении — и текущий).

### Perception (issue #401)

- LOS строго от зрителя-бота: его `visionSource` и проверка стен (`type:"sight"`).
  Если зрение не настроено, проверяется только геометрия, не видимость GM.
- Цели: противоположная disposition (viewer-симметричная: FRIENDLY-бот
  атакует HOSTILE, и наоборот), живые, не hidden. Нейтралы — только через
  `includeNeutral`/`dispositions`. Нейтральный бот (disp 0) считает
  враждебными всех — не полагаться.
- Память последней позиции на Combatant-флаге (`memory[targetUuid]`):
  sanitized `{sceneId, x, y, elevation, lastSeenRound, lastSeenTurn,
  dispositionAtDetection}`, истекает через 3 раунда; last-known разрешает
  поиск/движение/blast-удар, но не прямую атаку.
- Общие контакты отряда (issue #38): `mergeTeamMemory` — чистый
  детерминированный мёрж памяти членов (свежая запись побеждает, при
  равном ts — своя, tie между тиммейтами — лексикографический
  `combatantId`); `teamLastKnownPositions(combat, combatant, teamId)` —
  мёрж только живых/enabled тиммейтов той же команды с provenance
  `sourceCombatantId`. Отдельного хранилища контактов нет — читается
  существующая память членов.

### Navigation (issue #402)

- A* по сетке с waypoints, кандидаты возвращаются с реальными маршрутами
  (фикс «move через стены» — waypoints сериализуются в шаг `move`).
- Кандидат движения получает измеренную стоимость и путь до своей клетки;
  частичный маршрут не заканчивается на занятой клетке или сверх бюджета.
  Без диагоналей резервное измерение суммирует ортогональные шаги (#50).
- При закрытом стеной направлении без доступной атаки `approach` может
  вести сначала в сторону от цели, к проходу по найденному обходу (#70).
- Стены разделяются по `sense`: `"move"` для маршрутов, `"sight"` для LOS —
  смок (`move:0, sight:20`) проходим и не даёт видеть — поддержано без
  особых настроек.
- Четыре системных режима движения: `half`, `full`, `charge`, `run`
  (1×, 2×, 3× и 6× скорректированный бонус Ловкости). `approach` и
  `seek` расходуют half/full move; `charge` ведёт по прямой к цели,
  `run` тратит полный ход, без атаки.
- Gridless-сцены — контролируемый `gridless-unsupported` (не ошибка).

### Planner (issue #403 + #413)

- Детерминированные кандидаты, в том числе `attack-in-place`,
  `move-attack`, `charge`, `approach`, `seek`, `run`, `hold`: факторный
  вектор + веса пресета; равные оценки разрешает seeded pick (mulberry32).
- Типы атаки из `actions.list`: на оружие кандидатизируется до 3 типов в
  курируемом порядке (ranged: `full_auto, semi_auto, standard, ripper_charge,
  called_shot, suppressing_fire`; melee: `allOut, charge, standard, lightning,
  swift, called_shot`); `EXCLUDED_ATTACK_TYPES` пуст — `suppressing_fire`
  как отдельная роль area-denial проходит всегда (issue #14). Дальние атаки
  с пустым клипом исключаются (`no-ammo`).
- Статусы: `stunned` → короткий `end-turn`-план; `pinned` — вето charge,
  run и сближающих перемещений; `prone` — бюджет движения пополам,
  вето charge и run.
- `vulnerable`-фактор за цель pinned/prone/stunned; `engaged`/`meleeEngage`
  за контакт ближнего боя.
- Сужение пула атак (epic #84): опциональные `context.attackTargetIds` /
  `context.excludedAttackTargetIds` ограничивают только direct-attack
  кандидатов (включая blast memory-strike и наведение attack-конусов);
  осведомлённость — движение, threat-map, melee-engagement, nearest
  threat, overwatch, commitment-угрозы — читает полный пул восприятия.
  Точное строковое совпадение по `tokenId`/`tokenUuid`/`actorId`; сужение
  не ослабляет `canAttack`/memory-правила и не входит в
  snapshot/validate; без полей поведение бит-в-бит прежнее.
- `validateSnapshot` перед каждым шагом: `turn-stale | token-moved |
  target-gone | resources-changed | collision-changed | statuses-changed |
  combat-ended`. `shouldReplan` — не более `maxReplans` (1) за ход.

#### Blast-awareness (гранаты и пр.)

- Blast-действие (`blastRadius` из `item.system.blastRadius`/`traits.blast`)
  целится в *точку*, а не в токен: `_bestBlastAim` перебирает центр цели +
  8 оффсетов на полрадиуса; выигрывает точка с максимумом hostiles под
  шаблоном. Союзник в зоне — вето; нейтрал — вето, кроме `includeNeutral`.
  Покрытие — `_blastTokens` (canvas placeables / боевой fallback /
  `context.blastTokens` в тестах).
- Удар по last-known позиции (зачистка помещений) — без LOS и без передачи
  токена цели в систему. Запомненная точка считается одним предполагаемым
  противником; координаты из трекера без наблюдения годятся лишь для поиска.
  Проверки дальности и безопасности союзников сохраняются.
- Шаг несёт `input.targetPoint` → `prepareAttack` ставит шаблон по точке.
- Фактор `area` = `min(blastHits/2, 1)`; веса: specOps 5, assault 4,
  rangedCover 3, hold 2.
- Ограничения первой итерации: move-attack-бласты оцениваются с конечных
  точек маршрутов; memory-strike — только из текущей позиции; LOS к точке
  броска требуется (кроме memory-strike); высота не учитывается.

#### Cone-awareness (spray и suppressing fire, issue #14)

- Шаблонное оружие (`requirements` содержит `template` — spray 30°) и
  `suppressing_fire` (45°) целится *направлением*, а не токеном:
  `_bestConeAim` перебирает пеленги на каждого hostile + середину дуги
  каждой влезающей в конус пары (кластер-центрированный конус).
  Союзник/нейтрал в конусе — вето; требуется LOS хотя бы к одному
  покрытому hostile.
- Шаг несёт `input.template.direction` + `input.covered` (uuid покрытых);
  для подавления — канонический `attackType:"suppressing_fire"` +
  `suppressionFire:true` + `burstMode` (`semi_auto` при burst-RoF, иначе
  `full_auto`). Executor транслирует это в системный вызов
  (`attackType=burstMode, suppressionFire:true`).
- Suppression — только из текущей позиции (длительная зона); spray может
  идти после move-attack (прицел пересчитывается с конца маршрута).

#### Тактический уровень (issue #16)

- **Threat map** (`scripts/threat-map.js`, сервис `threatMap`) — агрегированное
  поле опасности сцены: пересчитывается один раз на план (`refresh(input)`),
  все решения читают один и тот же `dangerAt(point) → 0..1`. Источники —
  оружейные эмиттеры известных врагов `{ev, range, melee}` из инвентаря
  актёра (EV урона — детерминированное среднее кубов) или инъекция
  `context.threats`. Ranged-эмиттер вносит полную силу `min(1, ev/10)`
  внутри дальности, melee — полную в reach и линейный спад по полосе
  чарджа (2 + 6 м). LOS-гейт — проба стен (`createGridAdapter`), без пробы
  угроза считается открытой. `explain(point)` — разбивка по источникам.
  Отличие от `cover`/`exposure`: те меряют укрытие относительно *выбранной*
  цели, `danger` суммирует покрытие всех известных врагов — точка, безопасная
  от текущей цели, может оказаться убийственной зоной второго стрелка.
- Фактор `danger` (норм. 0..1) оценивает endpoint кандидата; веса пресетов
  отрицательны: assault −0.5, hold −2, specOps −2, rangedCover −3,
  default/skeleton −1.
- **Lookahead** (2-ply, модельный, без симуляции мира): после базового
  скоринга top-K (default 4) кандидатов для каждого endpoint'а считается
  максимальный ожидаемый контр-урон вражеского эмиттера
  (`expectedCounterDamage` — та же модель, что у threat map: дальность +
  LOS + melee-полоса). Оценка: `adjusted = score − λ × EV`, λ default 0.5.
  Выбор идёт по top-K с детерминированным tie-break; pass записывается в
  `diagnostics.lookahead`, результат победителя — в `breakdown.lookahead`.
  Оверрайды: `context.lookahead` (on/off), `lookaheadLambda`, `lookaheadTopK`.
  Мастер-гейт — world setting `layersLookahead` (default `true`, issue
  #24): выкл отключает pass даже на hard и при `context.lookahead`.
- **`aiDifficulty`** (world setting `easy|normal|hard`, default `normal`;
  `getAIDifficulty()`; `context.difficulty` переопределяет на план):
  `easy` — бот не читает производную карту угроз и с вероятностью ~30%
  (`EASY_MISTAKE_CHANCE`, переопределяется `context.easyMistakeChance`)
  выбирает не-argmax — seeded pick из следующих кандидатов, детерминирован
  по seed (XOR-поток mulberry32); `normal` — threat map активна;
  `hard` — дополнительно lookahead по умолчанию. `plan.difficulty` и
  `diagnostics.difficulty/easyPick` отражают выбор. Настройка — точка
  опоры для личностей ботов (issue #19).
- **Fireteam concentrate-fire / kill-EV конвергенция** (issues #16/#85):
  `buildTeamPlan` нормализует видимых hostile в pure selector
  `scripts/presets/concentrate-fire.js`. Семантика wounds — *оставшийся*
  запас здоровья: `system.wounds.value` — нанесённый урон, поэтому объект
  `{value, max}` читается как `max − value`; plain-число и value-only
  инъекции уже считаются эффективным запасом. Живой scan требует, чтобы
  хотя бы один живой enabled член видел цель через perception; injected
  memory/relay/hidden контакты кандидатами не являются. Команда читает
  statuses, `reactionUsed`, threat EV из weapon emitters, melee gang-up и
  `lastTarget` hysteresis; killEV считается per member/per target по
  дальности лучшего emitter.
  Гарантированный kill остаётся legacy-режимом `mode:"kill"`: все capable
  members получают цель, cap/exclusions нет, flank не выделяется (если не
  задан явно), а `diagnostics.convergence` остаётся backward-compatible
  alias. Scored `mode:"focus"` выбирает приоритетную цель по угрозе,
  уязвимости, потраченной реакции, friendly-fire/gang-up доктрине пресета,
  exposure и hysteresis. Descriptor — backward-compatible superset:
  `targetId, targetUuid, killEV, wounds, margin, capableMembers` плюс
  `mode, focusScore, focusCap, assignedMembers, excludedMembers,
  woundsKnown, breakdown, runnerUp` (и `actorId` для planner identity).
  Objective precedence: explicit `context.objective` → independent
  `tactic.objective` → focus; focus выбирается до registry и подаётся в
  specOps как входной objective. Назначенные члены получают additive
  `role:"focus"` только если role не задана; member-scoped objective target
  сильнее focus. Отключение — `context.convergence === false`,
  `context.killEV === false` или `context.focus === false`;
  `excludeTargetIds` убирает candidacy, но не threat mass. Диагностика —
  JSON-safe `diagnostics.focus` с coefficients, candidates, visibility и
  assignment/exclusion summary.
- **Focus attack pools**: назначенные члены сохраняют полный
  threat/engagement `targets` и получают direct-attack `attackTargetIds`;
  capable overflow сохраняет полный pool и получает focus target в
  `excludedAttackTargetIds`. Caller allow-list является hard constraint и
  пересекается с focus, caller deny-list сохраняется; member-objective
  redirect важнее focus pool. Target-conflict и target-gone replan не наследуют
  derived focus allow-list.

#### Личности ботов (issue #19)

- **`scripts/personalities.js`** — data-driven пул из 24 черт в 4
  категориях (агрессия/смелость, навык/опыт, позиция/манёвр, командность):
  `brave, reckless, fanatic, bloodthirsty, cunning, cautious, cowardly,
  veteran, marksman, rookie, heavyHanded, grenadier, duelist, sniper,
  flanker, sentinel, pursuer, wanderer, liaison, loner, leader, executor,
  thrifty, unsteady`. Каждая черта — `{category, deltas, jitter, weight,
  bias, flags?}`: `deltas` — аддитивные смещения на веса `SCORE_FACTORS`
  (плюс preset-only `flankAngle`/`cohesionRestore` — инертны вне specOps),
  `jitter` — смещение амплитуды шума, `bias` — мультипликаторы пула по
  сложности.
- **Генерация seeded**: `fnv1a("personality|<actor.id>")` → mulberry32,
  1–2 черты взвешенной выборкой без повторов. Сид — только стабильный id
  документа (`actor.id → token.uuid → token.id → combatant.id`), не
  бой/раунд — личность одинакова на всех клиентах и сохраняется между
  боями. Сложность смещает пул: easy тянет к
  cowardly/rookie/unsteady/reckless, hard — к
  veteran/marksman/flanker/cunning, normal — полный пул.
- **`flags["only-war-ai"].personality`** — явный override списком id черт
  (массив или строка через запятую); резолвится по цепочке
  combatant → token → actor в `resolveEffectiveConfig` (поле
  `personality` результата). Повреждённые значения игнорируются —
  откат на генерацию. `context.personality` (массив/false) —
  план-оверрайд и способ отключить систему целиком
  (`source: "disabled"`).
- **Интеграция со скорингом**: дельты черт складываются и мерджатся поверх
  `preset.weights` до scoring'а (тот же overlay-паттерн, что у
  SPEC_OPS_TASK_WEIGHTS, но аддитивный); `diagnostics.weights` несёт уже
  эффективные веса. С issue #24 дельты — слой L3 воронки и ограничены
  скобой ±30% от базового веса (фактор с нулевой базой — ±6; зажатые
  дельты репортятся `diagnostics.personality.clamped`). Поведенческие
  флаги (`fanatic.ignoreRegroup`)
  работают через сильные отрицательные дельты (`cohesionRestore −12`,
  теперь зажимаемые до −6),
  отдельных веток генерации кандидатов нет. Победитель получает
  `breakdown.jitter {amp, factor}`, план — `personality {traits,
  character, source}`, диагностика — `personality {traits, character,
  source, jitter, flags}`.
- **Jitter**: seeded мультипликатор `1 ± amp` на оценку каждого
  кандидата, keyed по стабильному id кандидата (не индексу) через
  XOR-поток mulberry32. Амплитуда = baseline сложности (easy 0.04 /
  normal 0.02 / hard 0) + Σ смещений черт + смещение характера, кап
  0.15: `unsteady` ≈ ±14–15%, `rookie` средний, `veteran` → 0.
- **`fireteam.character`** (`disciplined|shock|elite|rabble`) — поле
  fireteam-флага, резолвится `resolveTeamConfig` по той же цепочке
  (в `buildTeamPlan` — `context.character` → team ref → первый член с
  флагом). Командный overlay применяется к весам каждого члена
  (`context.team.character` в member-планах): disciplined — связность,
  shock — charge/штурм, elite — низкий jitter, rabble — высокий jitter и
  слабая связность. Персональные черты поверх командного overlay; при
  конфликте по фактору личная дельта заменяет командную. Поле едет в
  `teamPlan.character` и `diagnostics.character`.
- **Видимость**: строка личности в GM preview (`OWAI.Personality.*` /
  `OWAI.FireteamCharacter.*`), поле ввода черт и resolved-строка в
  NPC-sheet, селект характера в fireteam-секции, `plan.personality` и
  `diagnostics.personality` для диагностики.
- **Настройка GM**: в секции Only War AI на листе NPC введите id черт через
  запятую (например `marksman, cautious`). Пустое поле возвращает seeded
  выбор, если на токене или комбатанте нет override. В превью проверяйте
  эффективные черты и вклад L3 в оценку: черта меняет предпочтения, но
  не делает недоступное действие легальным.

#### Экономия действий (issue #15)

- Бюджет хода — две half-actions: `cost` из `actions.list` нормализуется
  в half-единицы (`"half"|1` → 1, `"full"|2`/числа → 2, без поля — 1).
  Full-действие после движения запрещено (`full-after-move` в
  diagnostics); half+half — легально.
- Движение имеет стоимость по OW (issue #31): ход в связке с другим
  полудействием — half move, т.е. комбо-варианты (`move-attack`,
  `move-reload`, blast/spray move-attack) генерируются только для
  конечных точек в пределах `rates.half` — дальше `beyond-half-move`
  в diagnostics и остаются только move-only кандидаты (full action).
  Half rate берётся из `context.halfMove`/`context.rates.half`/кэша
  `getMovementRates`; prone половинит его как и бюджет. Move-шаг
  сериализует `cost.halves` (charge → 0, bundled → 1, standalone за
  половинным порогом → 2). Чтобы у комбо была хоть одна дешёвая конечная,
  набор точек дополняется «кромкой дальности»: второй `findCandidates`
  нацелен на точку `0.9 × maxRange` от цели — клетки рядом с ней укладываются
  в half move и уже в дистанции выстрела.
- `aim` — universal-действие: явные `kind:"aim"` записи из API берут
  собственный бонус, иначе синтезируются `aim.half` (+10) и `aim.full`
  (+20). `aim-attack` — half aim + half-атака за один ход; шаг `aim`
  бронирует бонус в `input.aim` атаки. Standalone `aim` (полный ход) —
  только при видимом контакте и ranged-оружии, пишет бонус во флаг
  `flags["only-war-ai"].aim` (aimedUntil): он переносится на атаку
  следующего хода и снимается executor'ом после выстрела. Переприцел на
  равный/меньший бонус не планируется.
- `reload` — `kind:"reload"` записи `actions.list`: шаг `reload` идёт
  через `api.actions.reload` со step-scoped `operationId`
  (идемпотентно); `move-reload` допустим при half-стоимости.
- `overwatch` — полное действие, объявляет зону на видимую угрозу или
  свежий `team-contact` через сервис из #14 (флаг + GM-only отрисовка).
  Своей `last-known` памяти для декларации недостаточно. Issue #54: зона
  наводится на предсказанные позиции — nav-waypoint `planRoute(threat → self)`
  ближайшей угрозы (~половина её полухода по маршруту — «в проход»),
  lead-точки `min(halfMove, distToSelf)` видимых угроз («на
  опережение»), позиции memory-контактов (валидный якорь зоны, #45);
  все якоря в `_bestConeAim`, fallback — bearing. Оружейная геометрия:
  cone 45°, spray — собственный конус `_coneSpecOf`, blast — круг
  `{shape:"blast", targetPoint, blastRadius}`; melee-зона пропущена.
  Issue #37: бот с потраченной реакцией
  (`flags["only-war-ai"].reactionUsed` текущего раунда) зону не
  декларирует — rejected `reaction-used`.
  **Для GM:** подтвердите `overwatch` в превью; зона остаётся на сцене до
  следующего хода владельца, перемещения его токена или конца боя.
  Обновление флага операции в том же ходу не снимает зону. Вход врага
  в зону — повод разыграть реакцию вручную, не автоматический бросок.
- Ориентация конусов (issue #30): spray/suppression наводятся только по
  воспринимаемым якорям — видимая цель на текущую позицию, last-known на
  запомненную точку; невидимые/неизвестные hostile на сцене шаблон не
  наводят (вето союзников сканирует всю сцену). Overwatch наводится на
  предсказанные позиции угрозы (issue #54).
- Статусы: pinned запрещает движение, standalone aim, overwatch и
  move-reload — стационарные reload/attack-in-place остаются.
- Веса пресетов: `aim` (прицельный выстрел), `aimAlone` (standalone aim —
  ниже легальных атак), `reload`, `overwatch`. Направленности: assault —
  перезарядка без прицелов; rangedCover/hold — aim-ветка и конус;
  specOps — умеренно.

#### Экономия действий II (issue #37)

- **`ready-weapon`** — free/полу-действие «достать оружие»: явные записи
  `actions.list` с `kind:"ready"|"draw"|"equip"` планируются с
  собственным `cost` системы (free под Quick Draw — таланты в модуле не
  парсятся, стоимость приходит из записи). Без явных записей — синтез из
  инвентаря: оружие без usable-атакующей записи кандидатизируется как
  half-cost ready, когда действующий список атак пуст или все клипы
  `clip.value === 0` («боеприпасы кончились — смена ствола»). Шаг
  `ready-weapon {weaponId, itemUuid}` → executor вызывает
  `api.actions.readyWeapon`/`ready`/`equip` (без эндпоинта —
  `system-api-missing`); превью шага — только показ.
- **`drop-prone`** — free-действие «залечь» при `pinned` либо при
  `danger ≥ 0.5` на собственной клетке (threat map видит перекрёстный
  обстрел); уже лежачий/здоровый бот кандидата не получает. Шаг
  `drop-prone {statusId:"prone"}` → `api.actions.dropProne` или
  fallback `actor.toggleStatusEffect("prone")`.
- **`reactionUsed`** (`flags["only-war-ai"].reactionUsed` на Combatant,
  рекорд `{round, reason}`) — сервис `reactions` (`api.services`):
  `markUsed`, `markUsedByToken`, `clear`, `reactionUsedOf`,
  `handleUpdateCombat`. Пишет только контроллер; читают все —
  planner проверяет флаг документа цели. Сбрасывается в начале хода
  владельца (`updateCombat`-вотчер). Рекорд без `round` — консервативно
  потрачен; рекорд прошлого раунда — уже чист.
- **Counter-EV dodge-модель**: `dodgeChanceOf(target, action)` →
  `{dodgeable, chance}` — TN уворота цели/100 (поле `dodge` в записи
  цели, дефолт `DEFAULT_DODGE_TN = 30`, cap 0.95). Недоджибельные:
  spray/cone/suppression, blast при недоказанном выходе из зоны за
  half-move, цель с потраченной реакцией (`chance 0`). Фактор
  `attackType` несёт `desire × (1 − chance)` — атака по уворотливой цели
  теряет EV, по беззащитной выигрывает; цель `reactionUsed` дополнительно
  размечается `vulnerable`. `breakdown.dodge` экспонирует вердикт.
- **`attackAdjudication`** (world setting `auto|gm-confirm`, default
  `auto`): в `gm-confirm` перед каждым attack/test шагом в
  automatic-режиме GM получает whisper-чаткарту с решениями
  `execute | manual | skill-test | cancel` (клик — только контроллер,
  смена хода или истечение `previewTimeoutSeconds` отменяет ожидание;
  `0` отключает таймаут). `manual` — шаг исполнен без ролла; `skill-test` — подмена
  на `prepare/executeTest`; `cancel` — отмена операции с
  `advanceTurn:false`. Preview-режим не меняется: диалог предпросмотра —
  единственная точка подтверждения, гейт не дублирует вопрос.
- **Оружейные предпочтения**: `preferredWeapon` — поле конфига/листа NPC
  (uuid/id/имя оружия; chain Combatant → Token → Actor), скорится
  фактором `weaponAffinity` (полный вес при совпадении, половина — при
  совпадении класса оружия со spec черты личности). Executor пишет
  `lastUsedWeapon` на combatant после успешной атаки — фактор
  `weaponInertia` даёт мягкое предпочтение тому же стволу.

#### Тактические факторы (issue #39)

- **`alliedEngagement`** — штраф за точечную атаку по цели, стоящей в
  ближнем бою с союзником (стрельба в свалку — правильный −20 DH2e).
  «Занятость» считается по сценскому скану `_blastTokens` — та же
  выборка, что защищает blast/cone от friendly fire: враг в
  `DEFAULT_MELEE_RANGE` (2 м) от токена той же disposition (нейтралы —
  только с `includeNeutral`); сам бот и сама цель не считаются. Melee,
  blast- и cone-атаки фактор не получают — шаблоны уже ветируют
  союзников в зоне.
- **`leaveMeleeEngage` / `engageDenial`** — осознание свободной атаки:
  выход кандидата из melee-reach врага (выход без Disengage) и вход в
  reach врага снаружи оцениваются *по каждому врагу отдельно* — уйти от
  противника A в контакт к противнику B всё равно провоцирует A. Reach —
  melee-эмиттеры threat-профиля цели с фолбэком `DEFAULT_MELEE_RANGE`.
- **`unpin`** (issue #93) — по корбуке снятие pinning не действие, а
  свободный тест Воли в конце хода: нулевой `test`-шаг
  (`halves: 0`, `type:"characteristic", key:"willpower"`,
  `unpin/endOfTurn: true`, `modifier` +0 либо +30 в укрытии от ближайшей
  известной угрозы — probe из endpoint'а последнего move-шага плана,
  т.к. тест идёт в конце хода) автоматически вставляется перед end-turn
  любого плана pinned-бота → `api.rolls.prepareTest`/`executeTest`;
  executor снимает
  `pinned` только при успешном броске. Без характеристики — rejected
  `unpin-unavailable` и шага нет; активная альтернатива в бюджете хода —
  `drop-prone` из issue #37.
- **`grudge` / `lastAttacker`** — Combatant-флаг `{tokenUuid, tokenId,
  actorId, round, turn, woundsLost, attribution}`, controller-only.
  Сервис `grudges` (`api.services`): вотчер `updateActor` + кэш wounds
  на актёра — потеря ран атрибутируется только по targeted-карточкам
  чата (`damageOperation`-summary системы с `target` бота и
  `source.messageId` на damage-карточку либо `rollData.damages[]` с
  `targetActorId`/`targetTokenId` бота). Self-damage и доказуемо
  дружественная карточка grudge не дают; без targeted-свидетельства
  эвристикой не угадываем. Рекорд живёт `GRUDGE_MAX_AGE_ROUNDS = 2`
  раунда и снимается доказанной смертью атакующего; в
  stale-fingerprint не входит — свежая атака не форсирует реплан.
  Черты: `cunning` alliedEngagement −2, `reckless` +1, `duelist`
  engageDenial +3, `bloodthirsty` engageDenial +3 / grudge +4,
  `cowardly` grudge −2.

### Executor (issue #407)

- Шаги плана последовательно: `move` — `TokenDocument#move` по
  сериализованным waypoints (fallback `update({x,y})`); `attack`/`test` —
  `prepare*`/`execute*` системного API со step-scoped `operationId`;
  `aim` — флаг aimedUntil на combatant (снимается после выстрела);
  `reload` — `api.actions.reload`; `overwatch` — заявка зоны через
  сервис overwatch (флаг Combatant + GM-only зона на сцене, реакция —
  ручная у GM).
- **Контракт бега с системой:** после фактического `move(run)` модуль
  ставит `flags["only-war-ai"].running = {combatId, round, operationId}`
  на актёре комбатанта (синтетическом у unlinked-токена). Система читает
  этот маркер и включает −20 в дальних атаках по бегущей цели
  (`rollData.flags.isTargetRunning`). Модуль снимает маркер на следующем
  ходу бегуна или в конце боя; без маркера «Бег» остаётся ручной опцией.
- Безопасность: перед каждым шагом `validateSnapshot`; stale → один
  replan; повторный stale — hold-and-report. Без контроллера — `not-controller`.
- Продвижение хода: сериализовано по боевому `id`, ключи `(round,turn)`,
  проверка результата и ограниченное число повторных попыток.
- После попадания ход ждёт применения всех хитов. Карточки связываются
  по `apiOperationId`; бот не применяет урон. При
  `damageWaitAutoAdvance: false` после снятия ожидания ход передаёт GM.
- `turnPacingMs` (world setting, default 800, `0` — выкл): паузы между
  шагами и перед продвижением хода — ходы наблюдаемы.
- Диагностика остановок: GM-уведомление + шёпот с причиной и сводкой
  отклонённых кандидатов (`pinned ×3, no-los ×2`). `no-valid-plan` —
  контролируемый тактический исход, не runtime-ошибка.

### Fireteam (issue #408)

- Флаги `fireteam = {teamId, leaderId, teamPreset, preferredCohesion,
  character}` на актёре и/или токене (TokenConfig отображает только
  token-флаги). `character` (issue #19) — общий темперамент группы,
  overlay на веса всех членов.
- Per-preset tactic registry (issue #92, сервис `api.services.get("tactics")`):
  selector `{presetId, kind, priority, select}` — pure/deterministic;
  меньший priority раньше, tie-break — порядок регистрации, в v1 побеждает
  первый non-null `maneuver` descriptor. Явный `context.tactic` function/object
  сохраняет более высокий приоритет, `null`/`false` отключают тактику. specOps
  использует прежний `specOpsTactic`; rangedCover теперь тоже имеет
  зарегистрированный maneuver-selector. assault/hold без тактик получают
  null/fallback.
- Suppress-and-bound (issue #86): чистое ядро `tactics/suppress-and-bound.js`
  выбирает capable suppressor по полуавтоматической/полностью автоматической
  очереди, заряду, актуальному `turnIndex` и безопасному конусу. В каскаде
  specOps тактика стоит после regroup/casualty/pressure/no-contacts, но до
  flank-and-fix/coordinated-assault; rangedCover v1 — suppress-or-null.
  Descriptor отдаёт object assignments `{task,role,element,objective}` —
  suppressor `support/fire`, maneuver element `advance|flank/bound` — и
  сериализуемые `exclusionZones`. Участник с role `suppressor` получает preset-only
  suppression factor `min(covered/2,1) × 8`; обычная стрельба не запрещена и
  остаётся fallback. Остальные member contexts получают `team.exclusionZones`:
  preset veto отклоняет только move endpoint в конусе (`suppression-zone`),
  stay/attack-in-place легальны. После сборки TeamPlan проверяется фактический
  cone step подавителя и waypoints/endpoints остальных маршрутов; повторное
  нарушение после одного replan становится конфликтом `type:"zone"` с безопасной
  деградацией без движения.
- Interdiction-screen (issue #87): чистое ядро `presets/interdiction.js`
  выбирает интердиктора по профилю ближнего боя, выживаемости (`rtd` —
  раунды до гибели против порога темперамента) и предпроверке чарджа;
  в каскаде specOps оно стоит после suppression и до flank/assault, композитно
  переопределяя до двух членов базового манёвра. Триггер A — видимый
  attackable «чистый стрелок» (confidence ≥ `interdictConfidenceMin`,
  rangedEV ≥ `interdictMinRangedEV`), триггер B — melee-чарджер,
  угрожающий стрелкам отряда; B строго приоритетнее A, memory/relay/intel
  и hidden цели не участвуют. При нелегальном чардже интердиктор идёт к
  точке экрана на сегменте «враг → защищаемый стрелок» (fallback-цепочка
  contact/mid/deep): `team.screenPoint` мерджит nav-кандидаты в
  `planner/moves.js`, а preset-only фактор `screenProgress` оценивает
  приближение без жёстких вето. Цель перехвата исключается из direct-attack
  pool всех остальных членов через `excludedAttackTargetIds` (pool угроз
  остаётся полным), не может быть focus-целью concentrate-fire (фокус
  перевычисляется с исключениями как входными ограничениями) и при
  gm/morale-демоции роль вместе с objective-геометрией и target-pin
  снимается, а командный запрет начинает действовать и на демотированного.
  Превью видит триггер/confidence/rtd в `diagnostics.tactic.breakdown.interdiction`.
- `TeamPlan` координирует временные задания и мягкую связность. Для
  жизнеспособного отряда с назначенной инициативой исполнитель сохраняет
  прогресс манёвра на Combat и строит свежий план только для текущего хода.
  Атаки не начинаются, пока не закончены запланированные перемещения.
  Неподготовленные участники получают свой ход, остальные передают ход
  обычным способом. Превью остаётся по одному NPC.
- Перед первым совместным действием проверяются все оставшиеся атакующие.
  Если участник выбыл, потерял возможность атаки, был перемещён GM или
  маршрут перестал быть легальным, оставшаяся часть манёвра отменяется;
  выполненные шаги не откатываются. На манёвр отводятся текущий и
  следующий раунды. Без пригодного общего плана действует обычный
  индивидуальный план. Чардж не разделяется на перемещение и атаку
  на разных ходах.
- Squad tactics (issue #38): `buildTeamPlan` раздаёт каждому члену общий
  мёрж контактов (`team.contacts`), лидеру — `orderCandidate` (приказ
  требует навык `command`, ≥2 живых члена и кулдаун
  `ORDER_COOLDOWN_ROUNDS` от `flags["only-war-ai"].lastOrder`), а
  post-pass `_syncDelay` ставит main-членам delay-план ожидания
  транзитного флангера при конвергентной цели. `memberEntries[].delayed`
  = `{reason, until, syncRound, awaitId}`; падение ожидаемого флангера
  инвалидирует план причиной `sync-broken`. Executor `delay`-шага пишет
  системный `flags["only-war-local"].delayed` + модульный
  `flags["only-war-ai"].delaySync {round, until, count}`; `maxSyncRounds`
  (default 2) ограничивает повторные ожидания. Приказ исполняется как
  обычный `test`-шаг (`type:"skill", key:"command", flags.isOrder`),
  успех пишет `lastOrder {round, orderId, result}`.
- **Мораль отряда (issue #26, слой L2)**: `buildTeamPlan` раз в ход
  оценивает командную позу `confident | pressured | desperate` по
  счётчикам — численность членов/врагов, суммарные и свежие потери
  (журнал `losses` за 3 раунда), все-прижаты, доля безопасных опорных
  точек (`spaceControl` через threat-map), гибель лидера. Смена тира —
  гистерезис 2 раунда (`pending` в записи); гибель флагged-лидера
  форсирует переход мгновенно и никогда в confident. Evaluated-рекорд
  `{tier, pending, counters, losses, leaderId, combatId, round, state}`
  пишется controller'ом на флаг `morale` всех живых членов; ручные
  stub-записи `{state}` — членские оверрайды, не перезатираются.
  `context.morale` — чистая инъекция без оценки/записей.
- **Эффекты позы**: `confident` — до двух assault + до двух flank;
  `desperate`-member ремаппится assault→support, flank/advance→regroup
  (`diagnostics.moraleDemotions`), не ждёт синхро-удара и сдвигает свой
  скоринг bounded-дельтами `MORALE_POSTURE_DELTAS` (тяга к укрытию/
  удержанию/связности, давление charge/melee); `pressured` — baseline.
  Личные исключения читают только member-effective tier: `fanatic`
  игнорирует `desperate`, `cowardly` читает `pressured` как `desperate` —
  командная поза одна и не меняется. Смена тира инвалидирует
  committed-план (`morale-changed`, issue #25). Тумблер —
  `layersMorale` (default `true`): выкл — ни оценки, ни записей, ни
  ремапа/дельт.
- **Barks (issue #26)**: короткие чат-фразы телеграфируют намерения —
  коммитнутый переход тира (`OWAI.Bark.Morale.<tier>`, дедуп на
  бой/команду/раунд/тир) и старт свежего многоходового commitment
  (`OWAI.Bark.Plan.Start` с цепочкой шагов, дедуп на боевую единицу/
  раунд). Настройки: `aiBarks` (default `true` — мастер-тумблер),
  `barksToPlayers` (default `false` — GM-шёпот, `true` — видит весь
  стол). `context.barks === false` гасит план-разово.

### Preview (issue #409)

- `executionMode: preview` — диалог на каждый AI-ход (per-бот, per-turn):
  Confirm → исполнение, Cancel → ход под ручным управлением GM
  (`advanceTurn:false`), Replan — в пределах `maxReplans`. Таймаут
  `previewTimeoutSeconds` (60c, `0` — бесконечно). Ход-устаревание
  авто-отменяет; stale — баннер + disabled Confirm.
- Canvas-оверлей плана (issue #29, сервис `planOverlay`): GM-only
  PIXI-визуализация previewed-плана — маршрутная полилиния со стрелкой,
  конусы `template`/`overwatch`, круг blast `targetPoint`, подсветка цели,
  маркер замысла `шаг/total` над токеном, тонированный тиром морали
  (issue #26). Рисуется на open/replan/stale, чистится любым решением или
  снятием сессии; документы не трогает, игрокам и не-контроллерам не
  виден.
- Телеграфирование в диалоге (issue #26): строка «Замысел» — цепочка
  типов шагов плана (`planIntentOf`, без `end-turn`), строка «Мораль
  отряда» — командный тир (+ effective-тир, когда черты члена его
  смещают).
- Нет «подтвердить команду»/«подтвердить раунд» — только per-бот.

### Отладка (issue #36)

- `threatMapOverlay` (world setting, default `false`) + GM-keybinding
  Alt+M → `planOverlay.setDangerEnabled/toggleDanger`: теплокарта
  `dangerAt` поверх сетки (`dangerShade` — детерминированная раскраска),
  режимы `plan` (карта текущего бота) и `all` (агрегат угроз команды),
  подписи top-вкладчиков из `explain`. GM-only, чистится по disable/
  canvasTeardown.

### Конфигурация и зоны видимости

- `flags["only-war-ai"].config` на актёре: `{enabled, preset,
  includeNeutral}`; token/combatant `override = {mode, preset,
  includeNeutral?}` — `resolveEffectiveConfig` (combatant → token → actor).
- `flags["only-war-ai"].personality` (issue #19): явный список черт на
  любом из трёх уровней — `resolveEffectiveConfig` возвращает поле
  `personality`; без флага черты генерируются seeded по id документа.
- Все AI-визуалы/диагностика — GM-only (whisper на GM-пользователей);
  игрокам ничего не утекает (проверено smoke).
- **Слои поведения L0–L4** (issues #24/#25, `scripts/layers.js` +
  `docs/layers.md`, capability `planner.layers`): планирование — воронка
  вето/commitment/morale/
  personality/scoring. World settings `layersCommitment` (default
  `true` — L1 реализован: флаг `committedPlan` + `expectedState`,
  TTL, own-move `moveJournal`, `gm-intervention`/`gmControlled`,
  `manualOverrideGrace`, reactive-режим), `layersMorale` (default
  `false` — каркас под #26),
  `layersPersonality`, `layersLookahead` (default `true`); план-оверрайд —
  `context.layers`. Каждый слой пишет `{layer, code, detail}` в
  `plan.diagnostics.layers`.
- **Трасс решений (issue #27, `scripts/trace.js`, capability
  `planner.trace`)**: `plan.diagnostics.trace` — сериализуемые записи
  `{layer, kind, ...}` по каждому слою (L0 вето по кандидатам, L1
  вердикт обязательства, L2 поза+сдвиг весов, L3 дельты черт по
  факторам, L4 top-3/победитель/дельта/w·f-вклады). Рендер
  compact|full (`aiTraceVerbose`, default compact) в превью-блоке
  «Как думал» и однострочным GM-шёпотом при отказе/отмене хода.
  Replay-захват `aiCaptureContext` (default off): bounded (8) журнал
  `captureJournal` на комбатанте — sanitized `planContext`+snapshot.
  Ограничения офлайн-replay описаны в [документе о слоях](layers.md#replay-захват).
  Трасс — только диагностика, на выбор
  плана не влияет.

## 3. Что боты умеют — по пресетам

| Пресет | Поведение |
|---|---|
| `assault` | Сближение/штурм: charge в мили-реч, meleeEngage-фактор, blast 4 |
| `rangedCover` | Стрельба с позиции: LOS-вето атак, cover/rangeBand, blast 3; memory-strike по гранатам освобождён от LOS-вето |
| `hold` | Держит позицию: approach запрещён политикой, blast 2, `allowNoTarget/allowNoAction` |
| `specOps` | Файртим-пресет: task-оверлеи (support/advance/flank/assault/regroup), cohesionRestore, blast 5 |

Общее: выбор типа атаки по RoF (очереди — если оружие умеет), гибрид
melee/ranged (подбор по факторам), статусные правила, blast-awareness,
атаки нейтралов при `includeNeutral`, союзник-бот корректен (симметричная
disposition-матрица).

## 4. Явные ограничения

| Область | Состояние |
|---|---|
| Урон/уворот/пари | Модуль не применяет урон и не выполняет реакции автоматически; для них используются ручные действия системы. |
| `suppressing_fire`, spray-оружие (огнемёты) | Поддержано: `template.direction` + вето союзников (issue #14) |
| Overwatch-зоны | Заявка в плане + GM-only отрисовка есть (issues #14/#15); предсказанные якоря + spray/blast геометрия (issue #54); авто-реакция — нет |
| Aim, half/full экономия, reload-шаг | Реализовано (issue #15): бюджет 2×half, `aim`/`aim-attack` с aimedUntil-флагом, `reload` через `api.actions.reload` |
| Реакции бота (overwatch-триггер, авто-уворот) | Нет — реакцию объявляет конус, но исполняет её GM вручную |
| Гранаты на союзников | Нет (`blast-friendly-fire` вето); на нейтралов — только при `includeNeutral` |
| GM «подтвердить команду/раунд» | Нет — только per-бот preview |
| Нейтральный бот (disp 0) | Считает враждебными всех — ставить корректную disposition |
| LOS к aim-точке | Требуется (кроме memory-strike) |
| Gridless | Не поддерживается (контролируемый отказ) |
| Бот защищается | Нет авто-уворота (защищающийся — ручной) |
| Тактический lookahead | 2-ply модельный (top-K + λ·counterEV, issue #16) — MCTS/глубокий поиск не планируется |
| Сложность AI | `aiDifficulty` easy/normal/hard: easy ~30% намеренно не-оптимальных ходов, hard включает lookahead (issue #16); также смещает пул черт и baseline jitter личностей (#19) |
| Личности ботов | 24 черты → аддитивные дельты весов + seeded jitter ≤ ±15%; флаги `ignoreRegroup` — через дельты, без отдельных веток кандидатов (issue #19) |
| Карта угроз | danger-фактор на endpoint кандидата; цели без оружейного профиля угрозу не проецируют |

## 5. Точки расширения

- ~~Issue #14~~ — реализовано: step-контракт `targetPoint`/`template`,
  spray и `suppressing_fire` с конусным прицеливанием, заявочный
  overwatch (флаг + GM-only зона; issue #54 — конус, spray-шаблон и
  blast-круг по предсказанным якорям).
- ~~Issue #15~~ — реализовано: бюджет half+half и вето move+full, aim
  (+10/+20) с переносом `aimedUntil`-бонуса, `reload` через
  `api.actions.reload` (PR #440), заявочный `overwatch`-кандидат.
  Авто-реакция остаётся точкой расширения (нужны триггеры в системе).
- **Системное расширение #398** — `rolls.executeDamage`,
  `rolls.applyDamage`, `rolls.evasionTest` — замыкает боевой цикл
  «попадание → урон → применение» и авто-реакцию AI-защитника.
