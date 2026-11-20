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
| `api.actions.list(actor)` | Записи действий: по записи на `attackType` на оружие (`standard`, `semi_auto`, `full_auto`, `ripper_charge`, `called_shot`, melee: `allOut`, `charge`, `swift`, `lightning`, `suppressing_fire` при `canSuppress`). Поля: `{id, kind:"attack", weaponId, weaponName, attackType, cost, requirements[], available, reason}`. `available:false` когда тип запрещён RoF/блоком оружия |
| `api.rolls.prepareAttack(input)` | JSON-сериализуемый prepared-объект (`fingerprint`, `refs`, `rollData`, `preview`) — без броска и без трат ресурсов. Вход: `actorUuid|actorId`, `weaponId|itemUuid`, `targetUuid`, `attackType`, `targetPoint`, `template` и флаги |
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
  called_shot`; melee: `allOut, charge, standard, lightning, swift,
  called_shot`); `suppressing_fire` исключён — шаг не умеет
  `targetPoint`/`template` шаблоны (issue #14).
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

### Executor (issue #407)

- Шаги плана последовательно: `move` — `TokenDocument#move` по
  сериализованным waypoints (fallback `update({x,y})`); `attack`/`test` —
  `prepare*`/`execute*` системного API со step-scoped `operationId`.
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

- Флаги `fireteam = {teamId, leaderId, teamPreset, preferredCohesion}` на
  актёре и/или токене (TokenConfig отображает только token-флаги).
- `TeamPlan` координирует задания (`support|advance|flank|assault|regroup`)
  и мягкую связность; исполнение всё равно пер-член на своём ходу —
  превью идёт per-бот.

### Preview (issue #409)

- `executionMode: preview` — диалог на каждый AI-ход (per-бот, per-turn):
  Confirm → исполнение, Cancel → ход под ручным управлением GM
  (`advanceTurn:false`), Replan — в пределах `maxReplans`. Таймаут
  `previewTimeoutSeconds` (60c, `0` — бесконечно). Ход-устаревание
  авто-отменяет; stale — баннер + disabled Confirm.
- Нет «подтвердить команду»/«подтвердить раунд» — только per-бот.

### Конфигурация и зоны видимости

- `flags["only-war-ai"].config` на актёре: `{enabled, preset,
  includeNeutral}`; token/combatant `override = {mode, preset,
  includeNeutral?}` — `resolveEffectiveConfig` (combatant → token → actor).
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
| `suppressing_fire`, spray-оружие (огнемёты), overwatch-конусы | Шаг не передаёт `template` — **issue #14** |
| Aim, half/full экономия, reload, реакции | Не моделируется — **issue #15** |
| Гранаты на союзников | Нет (`blast-friendly-fire` вето); на нейтралов — только при `includeNeutral` |
| GM «подтвердить команду/раунд» | Нет — только per-бот preview |
| Нейтральный бот (disp 0) | Считает враждебными всех — ставить корректную disposition |
| LOS к aim-точке | Требуется (кроме memory-strike) |
| Gridless | Не поддерживается (контролируемый отказ) |
| Бот защищается | Нет авто-уворота (защищающийся — ручной) |

## 5. Точки расширения

- **Issue #14** — step-контракт `targetPoint`/`template` → spray,
  `suppressing_fire`, GM-only overwatch-конусы.
- **Issue #15** — модель действий: aim/overwatch/reload, half+half,
  перенос aim-бонуса, реакции.
- **Системное расширение #398** — `rolls.executeDamage`,
  `rolls.applyDamage`, `rolls.evasionTest` — замыкает боевой цикл
  «попадание → урон → применение» и авто-реакцию AI-защитника.
