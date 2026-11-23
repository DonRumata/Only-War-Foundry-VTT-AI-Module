# Архитектура слоёв поведения L0–L4 (issue #24)

Поведение бота — **вложенная воронка**: каждый слой только *сужает*
пространство кандидатов слоя ниже и никогда не генерирует параллельных
кандидатов сам. Реализация — `scripts/layers.js` (pure-модуль) + точки
входа внутри `planner.planTurn`. Этот документ — формальный контракт:
семантика слоёв, скобы влияния, порядок вызова, формат reason-записей,
флаги и порядок rollout.

Каркас заложен в issue #24; L1 commitment реализован в issue #25 —
этот документ описывает оба. L2 morale (#26) и инструмент полного
reason trace (#27) — отдельные PR.

## Слои

| Слой | Имя | Что делает | Статус |
|---|---|---|---|
| L0 | hard-veto | Абсолютные вето легальности | внедрено (формализовано) |
| L1 | commitment | Валидный многоходовый план → следующий шаг без скоринга | внедрено (#25) |
| L2 | morale | Поза файртимы сужает назначение задач/факторы | pass-through (#26) |
| L3 | personalities | Дельты весов в скобе ±30% + jitter | внедрено (#19 + скоба) |
| L4 | base utility + lookahead | Детерминированный скоринг с нуля | внедрено (#16) |

### L0 — hard-veto (абсолютный)

Всё, что делает кандидата *нелегальным*: союзники/нейтрали под
blast-шаблоном и конусом (`blast-no-safe-aim`, `cone-no-safe-aim`),
недостижимость (`out-of-range`, `no-route`, `over-budget`,
`full-after-move`, `beyond-half-move`, `target-not-attackable` /
`canAttack`), отсутствие прав и среды (`gridless-unsupported`,
`config-disabled`, `combat-ended`, `not-controller`), статусные вето
(`stunned` — short-circuit; `pinned`/`prone` — charge и сближение),
`reaction-used`, `unpin-unavailable`, `order-unavailable`,
`preset-veto`.

**Абсолютно**: ни черта (L3), ни morale (L2), ни что-либо ещё не может
вернуть отвергнутый кандидат. Это гарантируется структурно: вето
применяется в момент генерации, отвергнутые кандидаты никогда не попадают
в scored-набор. L0 применяется дважды: на входе (gate-вето: права, бой,
конфиг, сетка, `stunned`) и при генерации кандидатов (все коды
`diagnostics.rejected`).

### L1 — commitment (issue #25)

Если у бота есть **действующий многоходовый план** и он валиден —
исполняется следующий шаг, скоринг не вызывается вообще (ни генерация
кандидатов, ни веса). Реализовано в issue #25; записи приходят из двух
источников:

1. `context.commitment` — инъекция для тестов/интеграций. Голая запись
   `{valid?, steps, source?}` доверена напрямую (контракт #24); запись
   с персистентной формой (`expectedState`/`combatId`/`status`/
   `createdRound`) проходит ту же валидацию, что и флаг.
2. Флаг комбатанта `flags["only-war-ai"].committedPlan` — запись вида
   `{id, status, combatId, combatantId, createdRound, createdTurn, ttl,
   source, steps, expectedState, cancelledReason?}`. Пишет только
   controller через executor в конце хода (hit — обновление
   `expectedState.self`; свежий скореный план — новая активная запись;
   инвалидированная — штамп `cancelled` + `cancelledReason`).

**`expectedState`** — компактный отпечаток условий (не полный snapshot):
`{self: {x, y, elevation}, target: {tokenId, tokenUuid, x, y} | null,
morale: "pressured" | "desperate" | null, threats: [{tokenId, x, y}]}`
(`threats` ограничены `COMMITMENT_THREAT_MAX = 16`).

**Валидация каждый ход** (`validateCommitment`, чистая; первый провал
выигрывает): `combat-ended` → `ttl-expired` → `gm-intervention` →
`target-gone` → `morale-changed` → `threat-drift` → `l0-veto`.

- `ttl-expired` — `round - createdRound >= ttl` (запись —
  `COMMITMENT_TTL_ROUNDS = 2`, reactive-режим жмёт эффективный ttl до 1).
- `gm-intervention` — токен не там, где его оставил план, и bounded
  журнал собственных ходов (`moveJournal`, до `COMMITMENT_JOURNAL_MAX =
  32` записей — пишет executor на каждом move-шаге) не объясняет дрейф.
  `manualOverrideGrace = true` принимает дрейф молча
  (`accepted.gmMoved`), журнальная запись — как собственный ход
  (`accepted.selfMoved`).
- `target-gone` — записанная цель умерла/скрыта/уничтожена или не
  резолвится по `tokenId`/`tokenUuid`.
- `morale-changed` — tier позы морали изменился; отсутствие флага
  `morale` читается как нейтральный tier (graceful под #26).
- `threat-drift` — более `COMMITMENT_THREAT_TOLERANCE = 1` записанных
  угроз сдвинулись дальше клетки, умерли или пропали.
- `l0-veto` — дешёвая проверка L0 поверх committed шагов: `pinned`/
  `prone` не исполняет `charge`-шаг. Commitment **не обходит L0**:
  `stunned` опережает проверку, а каждый committed-шаг проходит
  пошаговую ревалидацию executor'а.

**Reactive mode:** при `interventions > COMMITMENT_REACTIVE_THRESHOLD
(=1)` одинакомандных пометок `gmControlled` за раунд эффективный ttl
сворачивается до одного раунда — в ручном хаосе бот возвращается к
baseline-планированию по ходу. Счёт идёт по `fireteam.teamId` члена;
бот **без** команды не привязан ни к какому teamId и читает пометки
всего боя — включая вражеских комбатантов (GM перенёс двух врагов —
соло-бот тоже уходит в reactive). Осознанный выбор «world chaos»:
соло-боту нечем сузить выборку.

**gm-controlled маркировка:** `gm-intervention` в trace → executor
ставит `flags["only-war-ai"].gmControlled = {round, turn, reason}` на
один раунд; `buildTeamPlan` понижает меченного члена со сложных заданий
(flank/assault/advance → support) — команда деградирует, не ломаясь.

Решение L1 — `{decision: {steps, source}}`; план собирается стандартным
`_assemblePlan` с `breakdown.reason: "commitment"`, `candidatesCount:
0`. Отсутствие/повреждение записи — `commitment-miss {reason:
"no-commitment" | "invalid-commitment"}`, воронка продолжается.
Метаданные результата (`record`, `invalidated`, `reactive`,
`interventions`) идут в `diagnostics.commitment` плана — plumbing под
#27 и бухгалтерию executor'а.

### L2 — morale (pass-through, реализация — #26)

Троичная поза файртимы (defensive/neutral/aggressive) должна влиять на
task-assignment и posture-факторы. Сейчас слой *резолвит и репортит*
позу, но ничего не сужает: `applyMoraleLayer` читает зарезервированный
флаг `flags["only-war-ai"].morale` (`{state, pressured?, desperate?}`) /
`context.morale` и пишет `morale-posture` в trace +
`diagnostics.morale`. Когда слой выключен — нейтральная поза и запись
`morale-layer-disabled`.

Легаси-чтения флага `morale` батча #38 (`_syncDelay` — desperate не ждёт,
`orderBoost` — pressured усиливает приказ) остаются **безусловными** —
это контракт #38, а не эффект слоя; флаг `layersMorale` начнёт
управлять поведением с появлением posture-факторов в #26.

### L3 — personalities (скоба ±30%)

Существующий механизм #19 (аддитивные дельты черт + командный character
+ seeded jitter) встроен в воронку через
`boundedPersonalityOverlay(preset.weights, {traits, character})`:

- Каждая применённая дельта зажата в `± L3_DELTA_MAX_RATIO × |base|`
  (`L3_DELTA_MAX_RATIO = 0.3`); намеренное изменение поведения относительно
  исходного #19, где дельты были неограниченными.
- Для фактора с **нулевой базой** (вес 0 или отсутствует в пресете)
  скоба считается от опорной шкалы `L3_DELTA_BASE_FLOOR = 20` — ±6:
  личность может ввести предпочтение на игнорируемый пресетом фактор, но
  не превратить его в доктрину. Иначе «±30% от нуля» обнуляло бы все
  такие дельты.
- Отчёт о зажатых дельтах — `diagnostics.personality.clamped`
  (`factor → {raw, applied, bound}`) и ключ `clamped` в L3 reason-записи.
- Jitter (`personalityJitterFactor`, амплитуда ≤ 0.15) — часть слоя;
  seeded по `plan.seed` + candidate id, воспроизводимо.
- `resolvePersonality` source/генерация не менялись; при выключенном
  слое (флаг или `context.personality === false`) —
  `source: "disabled"`, нет черт, нет jitter, базовые веса.

### L4 — base utility + lookahead

Существующий детерминированный скоринг (`evaluateFactors` / кастомные
`preset.evaluate`, tie-break mulberry32 по `plan.seed`, easy-slip при
`easy`). Достигается только при планировании с нуля — мимо L1-hit.
Lookahead (`_applyLookahead`, hard или `context.lookahead`) — часть L4:
флаг `layersLookahead` — мастер-гейт поверх difficulty и
`context.lookahead === true` (off → только базовая полезность).

## Порядок вызова в `planTurn`

```
gate-вето L0: not-controller / combat-ended / config-disabled
  → diagnostics init + resolveLayerFlags (context.layers > world settings)
L0: gridless-unsupported
L0: statuses → stunned short-circuit
L1: applyCommitmentLayer      → hit: план из записи, return
L2: applyMoraleLayer          → поза в trace (пока без сужения)
L3: _runPersonalityLayer      → веса с дельтами в скобе + jitter
генерация кандидатов          → L0-вето при материализации (rejectL0)
L4: scoring → lookahead(гейт) → easy-slip → winner → steps → план
```

`stunned` осознанно стоит до L1: статусное вето абсолютно — оглушённый
бот не исполняет и commitment. L0-записи генерации идут в trace после
записей L1–L3 — слой L0 применяется в момент материализации кандидатов,
его абсолютность в том, что ни один верхний слой не может вернуть
отвергнутого.

## Reason-формат (#27 plumbing)

Каждый слой пишет причину решения унифицированной записью:

```js
{ layer: "L0"|"L1"|"L2"|"L3"|"L4", code: "<kebab-case>", detail?: <JSON> }
```

- Записи накапливаются в `plan.diagnostics.layers` **в хронологическом
  порядке** исполнения; `makeLayerReason`/`recordLayerReason` —
  единственные строители.
- `detail` обязан быть JSON-сериализуемым (план замораживается и
  сериализуется): строки-ключи кандидатов для L0-вето, маленькие объекты
  для L1/L2/L3/L4.
- Действующие коды: L0 — все коды `diagnostics.rejected` +
  `gridless-unsupported`, `stunned`; L1 — `commitment-layer-disabled`,
  `commitment-miss` (`no-commitment`|`invalid-commitment`),
  `commitment-hit` и прямые коды инвалидаторов `combat-ended`,
  `ttl-expired`, `gm-intervention`, `target-gone`, `morale-changed`,
  `threat-drift`, `l0-veto` (issue #25, набор —
  `COMMITMENT_REASONS`); L2 — `morale-layer-disabled`, `morale-posture`;
  L3 — `personality-layer-disabled`, `personality-overlay`
  (`detail.clamped` — список зажатых факторов); L4 — `scored`,
  `lookahead`, `lookahead-layer-disabled`, `easy-slip`, `winner`.
- `diagnostics.layerFlags` — эффективные тумблеры плана;
  `diagnostics.morale` — резолвленная поза L2.
- #27 строит на этом полный trace-инструмент (выбор черт, ветки
  сужения, per-layer timings); здесь — минимально необходимый plumbing:
  формат зафиксирован, слои обязаны писать.

## Флаги и деградация

World settings (`scope: world`, GM-only) + оверрайд `context.layers`
на план (тесты/интеграции):

| Настройка | Слой | Default | Выкл = деградация на |
|---|---|---|---|
| `layersCommitment` | L1 | `true` (#25 — слой реализован; выкл = откат одним тумблером) | нет короткого замыкания — всегда план с нуля |
| `layersMorale` | L2 | `false` | нейтральная поза; posture-факторов пока нет — видимой разницы нет |
| `layersPersonality` | L3 | `true` | `source:"disabled"` — нет черт/джиттера, чистый пресет |
| `layersLookahead` | L4-lookahead | `true` | только базовая полезность даже на `hard` |

Дефолты отражают rollout-порядок из issue (commitment → morale → черты →
lookahead): L1 реализован и включён (#25 — первый шаг rollout'а, откат
одним тумблером), L2 выключен до #26; L3/L4 уже работают — включены,
поведение по умолчанию идентично старому коду (кроме документированной
скобы ±30% на L3-дельты). Повреждённые значения
настройки → дефолт (`getLayerFlags`); неизвестные ключи
`context.layers` игнорируются (`resolveLayerFlags`).

## Принципы (из issue #24)

- **Bounded influence**: каждый модификатор в скобе — L3 дельты ±30% от
  базы (+флор ±6 для нулевой базы), jitter ≤ ±15% оценки; поверхность
  взаимодействия слоёв — только суженный набор и веса.
- **Seeded determinism**: tie-break, jitter, easy-slip, генерация черт —
  mulberry32/fnv1a от `plan.seed` и стабильных id документов; одинаковый
  ввод → байт-идентичный план и trace.
- **Нет глобального состояния**: слои — pure-функции, документов не
  пишут, память остаётся per-bot (`memory`-флаг combatant).
- **Флаги слоёв**: каждый слой вкл/выкл независимо; выкл = деградация на
  предыдущий уровень без ошибок и без потери плана.
