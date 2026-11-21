# Тест-сценарии поведения ботов (ручная проверка GM)

Каталог минимальных воспроизводимых кейсов. Формат: сетап → ожидание → где
смотреть. Цель — 2–5 минут на кейс на Smoke Arena (или любой сцене с сеткой).

Статус маркировки: **✓** — работает в текущем коде, **#NN** — после мерджа
соответствующего issue.

Общая подготовка: `masterEnabled` on; бой с ботами включён в Combat Tracker;
для деталей — `diagnosticsEnabled` on (GM-шёпот с причинами) и preview-режим
`executionMode: "preview"` (каждый ход показывает план до исполнения).

## Базовое поведение (✓ текущий код)

### T01. Атака на месте
- **Сетап:** assault-бот, враг в LOS и в дальности лазгана.
- **Ожидание:** план `attack-in-place`, без движения; карточка броска попадания.
- **Проверить:** превью → шаги `attack + end-turn`; score breakdown — `attackNow` главный вклад.

### T02. Сближение и очередь
- **Сетап:** враг за пределами дальности, лазган S/2/-.
- **Ожидание:** `move-attack`/`charge`, если дистанция позволяет в бюджет; `semi_auto` при cost=full не едет после move (`full-after-move` вето).
- **Проверить:** rejected-кандидаты в диагностике (`full-after-move`, `out-of-range`).

### T03. Удержание позиции
- **Сетап:** hold-бот в зоне, враг вне дальности.
- **Ожидание:** `hold`/`overwatch`/`aim`, не рвётся вперёд (`holdPosition` вес 10).
- **Проверить:** `insideZone`/`returnToZone` факторы в breakdown.

### T04. Граната без своих под взрывом
- **Сетап:** бот с Frag Grenade, 2+ врага кучно, союзник внутри радиуса.
- **Ожидание:** aim-точка смещается с союзника; если ни одной безопасной — `blast-no-safe-aim` в шёпоте + другой план.
- **Проверить:** `targetPoint` в attack-вводе; rejected `blast-no-safe-aim`.

### T05. Удар по памяти (зачистка угла)
- **Сетап:** враг уходит за стену (потеря LOS), у бота blast-оружие.
- **Ожидание:** бросок по last-known позиции без LOS (memory-strike, TTL памяти 3 раунда).
- **Проверить:** цель `source: "last-known"`/`"team-contact"`, `canAttack:false`, бросок по точке.

### T06. Нейтральная цель
- **Сетап:** нейтральный (disposition 0) токен-«заложник»; бот без `includeNeutral`.
- **Ожидание:** нейтрал никогда не цель. Затем включить `includeNeutral` — появляется как цель/казнь.
- **Проверить:** конфиг актёра/токена; цель в visibleTargets только при флаге.

### T07. Рука GM — перенос токена
- **Сетап:** preview или automatic; GM сдвигает токен бота до/во время хода.
- **Ожидание:** `token-moved` при валидации → replan (1 раз) или hold-and-report; никакого «добегания до старой точки».
- **Проверить:** шёпот причины; ход не продвигается дважды.

### T08. Пропуск хода GM'ом
- **Сетап:** GM кликает next, минуя бота.
- **Ожидание:** ход не «должник» — при следующем цикле нет двойного хода; claim-key round:turn сгорел.
- **Проверить:** отсутствие operation для пропущенного turn.

### T09. Master switch
- **Сетап:** `masterEnabled` off посреди боя.
- **Ожидание:** нет claims/исполнения/preview; on — возобновление со следующего релевантного события.
- **Проверить:** UI-секции скрыты; executor отвечает `module-disabled`.

### T10. Preview-решения
- **Сетап:** `executionMode: "preview"`.
- **Ожидание:** Confirm → исполнение; Cancel → `cancelled`, ход остаётся ручным (не продвигается); Replan → новый план (≤ maxReplans); таймаут `previewTimeoutSeconds` → авто-cancel; закрытие окна = cancel.
- **Проверить:** `stale`-баннер при изменении сцены; Confirm disabled при non-fatal stale.

### T11. Pacing
- **Сетап:** `turnPacingMs` 0 vs 1500.
- **Ожидание:** заметная пауза между шагами и перед nextTurn.
- **Проверить:** отсутствие гонок — ход продвигается один раз.

### T12. Overwatch-заявка
- **Сетап:** rangedCover-бот, враг приближается по открытой зоне.
- **Ожидание:** кандидат `overwatch` → шаг declare → GM-only конус 45° на токене; снимается при ходе бота/движении токена/конце боя.
- **Проверить:** конус НЕ виден игрокам; выстрел — решение GM (declare-only).

### T13. Очереди по RoF
- **Сетап:** лазган S/2/- vs автопушка S/-/6.
- **Ожидание:** лазган предлагает `standard`/`semi_auto`; автопушка — `full_auto`; `attackType`-фактор и `full-after-move` вето видны в breakdown.

### T14. Статусы
- **Сетап:** бот `pinned` → нет charge, ходы только не к цели; `stunned` → только `end-turn`; `prone` → бюджет движения пополам.
- **Проверить:** rejected `pinned`/`prone`-вето; `statuses` в snapshot/fingerprint.

## Файртим (✓ текущий код)

### T15. Назначение задач
- **Сетап:** тима 3+ члена с fireteam-флагом (leader отмечен).
- **Ожидание:** leader→assault, второй→flank (группа `flank-1`, ≥2 члена), остальные→support; в превью видна задача.
- **Проверить:** `team.task` в memberContext, `memberEntries` в диагностике.

### T16. Связность
- **Сетап:** flanker далеко от центра (> preferredCohesion).
- **Ожидание:** `detached-maneuver` допустимо до `maxDetachedPhases` со штрафом; support-член получает `beyond-cohesion` штраф.
- **Проверить:** reason-коды cohesion в диагностике.

### T17. Конвергенция (фокус-файр)
- **Сетап:** тима против одной цели, у которой wounds ≤ Σ EV членов.
- **Ожидание:** общий `objective.targetId` — все способные бьют одну цель.
- **Проверить:** `convergentObjective` в диагностике; `context.convergence:false` выключает.

## Личности и сложность (✓ текущий код)

### T18. Черты видны
- **Сетап:** бот с seeded-чертами (или флаг `personality`).
- **Ожидание:** черты в превью (`npc.traits`) и NPC-sheet; `дуэлянт` тянет melee, `трусливый` — отход, `снайпер` — дальний rangeBand.
- **Проверить:** `plan.personality`, `breakdown.jitter` ≠ 1 у jitter-черт.

### T19. Характер тимы
- **Сетап:** `fireteam.character: "elite"` vs `"rabble"`.
- **Ожидание:** elite — ровное поведение (малый jitter), rabble — разброс решений, мало связности.
- **Проверить:** `teamPlan.character`, jitter-амплитуда в breakdown.

### T20. Difficulty
- **Сетап:** `aiDifficulty: "easy"` vs `"hard"`.
- **Ожидание:** easy — ~30% выборов не top-1 (trace покажет slip); hard — lookahead включён, низкий jitter.
- **Проверить:** `adjusted score` в trace у hard (lookahead −λ·EV).

## По новым issues

| Кейс | Когда |
|---|---|
| T21. Delay-синхронка: флангер в пути → main ждёт `await-sync`, удар в один раунд | #38 |
| T22. Orders: лидер с order-итемом → Command-тест раз в 3 раунда, benefit на карточке | #38 |
| T23. Shared contacts: цель видна только флангеру — main получает `team-contact` | #38 |
| T24. alliedEngagement: цель в melee союзника → ranged-атака проигрывает | #39 |
| T25. leaveMeleeEngage: бот не провоцирует free-attack выходом из ближнего | #39 |
| T26. unpin: pinned-бот тратит full на WP-тест | #39 |
| T27. grudge: бот бьёт того, кто его ранил | #39 |
| T28. ready-weapon: бот с пустым стволом достаёт запасной | #37 |
| T29. GM-gate: `attackAdjudication:"gm-confirm"` → карточка перед броском | #37 |
| T30. Commitment: бот дожимает 2–3 хода один план; срыв только по инвалидаторам | #25 |
| T31. Morale: потери → desperate → regroup-задачи; гистерезис не дёргается | #26 |
| T32. Trace: превью показывает «Как думал» — L0–L4 с вкладами; replay-JSON | #27 |

## Типовые сигнатуры проблем

| Симптом | Куда смотреть |
|---|---|
| «Бот стоит» | rejected-кандидаты в шёпоте → вето-код (`out-of-range`, `pinned`, `full-after-move`, `blast-no-safe-aim`) |
| «Ход продвинулся дважды» | `operationCompleted` vs `_advanceForOperation` — двойной advance |
| «Бот скачет между решениями» | jitter-амплитуда в breakdown; commitment ещё не смержен (#25) |
| «Стреляет мимо своих» | alliedEngagement (#39) — пока нет штрафа |
| «Игнорирует гранату» | blastRadius на item есть? `blast-no-safe-aim` в rejected? |
| «Нет preview» | `executionMode`, `isController`, `masterEnabled` |
| «Нет уклона/урона у цели» | by design — урон/уворот ручные у GM (capabilities.md §границы) |
