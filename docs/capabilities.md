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

**Граница контракта: урон и уворот.** `executeAttack` заканчивается карточкой
*теста попадания* с кнопкой «Урон» (`.invoke-damage`). Броски урона
(`damageRoll`) и тесты уворота/пари (`flags.isEvasion`) — отдельные ручные
шаги: системный API их headless-эндпоинтов не экспонирует. Автоматическая
цепочка «попадание → урон → применение» требует новых эндпоинтов
(`rolls.executeDamage`/`applyDamage`/`evasionTest` — кандидаты на расширение
#398) или клика GM по карточке.

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

- LOS строго от зрителя-бота: `canvas.visibility.testVisibility` → legacy
  API → `visionSource` → геометрический fallback по стенам (`type:"sight"`).
- Цели: противоположная disposition (viewer-симметричная: FRIENDLY-бот
  атакует HOSTILE, и наоборот), живые, не hidden. Нейтралы — только через
  `includeNeutral`/`dispositions`. Нейтральный бот (disp 0) считает
  враждебными всех — не полагаться.
- Память последней позиции на Combatant-флаге (`memory[targetUuid]`):
  sanitized `{sceneId, x, y, elevation, lastSeenRound, lastSeenTurn,
  dispositionAtDetection}`, истекает через 3 раунда; last-known разрешает
  поиск/движение/blast-удар, но не прямую атаку.

### Navigation (issue #402)

- A* по сетке с waypoints, кандидаты возвращаются с реальными маршрутами
  (фикс «move через стены» — waypoints сериализуются в шаг `move`).
- Стены разделяются по `sense`: `"move"` для маршрутов, `"sight"` для LOS —
  смок (`move:0, sight:20`) проходим и не даёт видеть — поддержано без
  особых настроек.
- Gridless-сцены — контролируемый `gridless-unsupported` (не ошибка).

### Planner (issue #403 + #413)

- Детерминированные кандидаты `attack-in-place | move-attack | charge |
  approach | hold`; факторный вектор + веса пресета; равные оценки —
  seeded pick (mulberry32).
- Типы атаки из `actions.list`: на оружие кандидатизируется до 3 типов в
  курируемом порядке (ranged: `full_auto, semi_auto, standard, ripper_charge,
  called_shot, suppressing_fire`; melee: `allOut, charge, standard, lightning,
  swift, called_shot`); `suppressing_fire` — отдельная роль, проходит всегда
  (issue #14).
- Статусы: `stunned` → короткий `end-turn`-план; `pinned` — вето charge и
  сближающих перемещений; `prone` — бюджет движения пополам, вето charge.
- `vulnerable`-фактор за цель pinned/prone/stunned; `engaged`/`meleeEngage`
  за контакт ближнего боя.
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
- Удар по last-known позиции (зачистка помещений) — без LOS; запомненная
  точка считается одним предполагаемым hostile; rangedCover LOS-вето для
  таких бросков снято.
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
- **`aiDifficulty`** (world setting `easy|normal|hard`, default `normal`;
  `getAIDifficulty()`; `context.difficulty` переопределяет на план):
  `easy` — бот не читает производную карту угроз и с вероятностью ~30%
  (`EASY_MISTAKE_CHANCE`, переопределяется `context.easyMistakeChance`)
  выбирает не-argmax — seeded pick из следующих кандидатов, детерминирован
  по seed (XOR-поток mulberry32); `normal` — threat map активна;
  `hard` — дополнительно lookahead по умолчанию. `plan.difficulty` и
  `diagnostics.difficulty/easyPick` отражают выбор. Настройка — точка
  опоры для личностей ботов (issue #19).
- **Fireteam kill-EV конвергенция**: `buildTeamPlan` суммирует ожидаемый
  урон членов, чьё оружие достаёт до цели (ranged — по дальности, melee —
  reach + полоса), и сравнивает с `wounds` цели (из snapshot/инъекции).
  `killEV ≥ wounds` → конвергентный объект: `teamPlan.convergence
  {targetId, targetUuid, killEV, wounds, margin, capableMembers}`,
  общий `assignedTargetId` всем способным, flank-группа не выделяется
  (если не задана явно). Цель без читаемых wounds не конвергентна;
  приоритет — `context.objective`/тактика/`context.assignments`,
  отключение — `context.convergence === false`.

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
  эффективные веса. Поведенческие флаги (`fanatic.ignoreRegroup`)
  работают через сильные отрицательные дельты (`cohesionRestore −12`),
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
- `overwatch` — кандидат объявляет конус 45° на видимую угрозу через
  сервис из #14 (флаг + GM-only отрисовка); реакция остаётся ручной у GM.
  На last-known контакт конус не объявляется.
- Ориентация конусов (issue #30): spray/suppression наводятся только по
  воспринимаемым якорям — видимая цель на текущую позицию, last-known на
  запомненную точку; невидимые/неизвестные hostile на сцене шаблон не
  наводят (вето союзников сканирует всю сцену). Overwatch — строго по
  видимой угрозе.
- Статусы: pinned запрещает движение, standalone aim, overwatch и
  move-reload — стационарные reload/attack-in-place остаются.
- Веса пресетов: `aim` (прицельный выстрел), `aimAlone` (standalone aim —
  ниже легальных атак), `reload`, `overwatch`. Направленности: assault —
  перезарядка без прицелов; rangedCover/hold — aim-ветка и конус;
  specOps — умеренно.

### Executor (issue #407)

- Шаги плана последовательно: `move` — `TokenDocument#move` по
  сериализованным waypoints (fallback `update({x,y})`); `attack`/`test` —
  `prepare*`/`execute*` системного API со step-scoped `operationId`;
  `aim` — флаг aimedUntil на combatant (снимается после выстрела);
  `reload` — `api.actions.reload`; `overwatch` — заявка конуса через
  сервис overwatch (флаг Combatant + GM-only конус на сцене, реакция —
  ручная у GM).
- Безопасность: перед каждым шагом `validateSnapshot`; stale → один
  replan; повторный stale — hold-and-report. Без контроллера — `not-controller`.
- Продвижение хода: сериализовано по боевому `id`, ключи `(round,turn)`,
  верификация + bounded retry — двойных `nextTurn` и гонок нет.
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
- `TeamPlan` координирует задания (`support|advance|flank|assault|regroup`)
  и мягкую связность; исполнение всё равно пер-член на своём ходу —
  превью идёт per-бот.

### Preview (issue #409)

- `executionMode: preview` — диалог на каждый AI-ход (per-бот, per-turn):
  Confirm → исполнение, Cancel → ход под ручным управлением GM
  (`advanceTurn:false`), Replan — в пределах `maxReplans`. Таймаут
  `previewTimeoutSeconds` (60c, `0` — бесконечно). Ход-устаревание
  авто-отменяет; stale — баннер + disabled Confirm.
- Canvas-оверлей плана (issue #29, сервис `planOverlay`): GM-only
  PIXI-визуализация previewed-плана — маршрутная полилиния со стрелкой,
  конусы `template`/`overwatch`, круг blast `targetPoint`, подсветка цели.
  Рисуется на open/replan/stale, чистится любым решением или снятием
  сессии; документы не трогает, игрокам и не-контроллерам не виден.
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
| Урон/уворот/пари | Только тест попадания — урона/реакции нет (нужны `rolls.executeDamage`/`applyDamage`/`evasionTest` в системе) |
| `suppressing_fire`, spray-оружие (огнемёты) | Поддержано: `template.direction` + вето союзников (issue #14) |
| Overwatch-конусы | Заявка в плане + GM-only отрисовка есть (issues #14/#15); авто-реакция — нет |
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
  overwatch (флаг + GM-only конус).
- ~~Issue #15~~ — реализовано: бюджет half+half и вето move+full, aim
  (+10/+20) с переносом `aimedUntil`-бонуса, `reload` через
  `api.actions.reload` (PR #440), заявочный `overwatch`-кандидат.
  Авто-реакция остаётся точкой расширения (нужны триггеры в системе).
- **Системное расширение #398** — `rolls.executeDamage`,
  `rolls.applyDamage`, `rolls.evasionTest` — замыкает боевой цикл
  «попадание → урон → применение» и авто-реакцию AI-защитника.
