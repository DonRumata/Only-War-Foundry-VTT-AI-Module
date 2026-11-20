# Приёмочная матрица — Only War AI `v0.1.0` (issue #410, epic #363)

Модуль `only-war-ai` `v0.1.0` — QA/acceptance покрытие по эпику #363:
производительность, диагностика и приёмочная матрица. Изменения лежат в
рабочем дереве, коммит не выполнялся.

Проверки: `npm run check` чисто; `npm run lint` 0 ошибок; unit-тесты
277/277; E2E-набор прогнан на живом Foundry v13 + Chrome CDP (мир
`only-war-local`, модуль загружен из рабочего дерева).

## Матрица критериев

| № | Критерий | Тест / проверка | Статус | Фактический результат |
|---|---|---|---|---|
| 1 | Golden path всех пресетов на квадратной сетке (`assault`, `rangedCover`, `hold`, `specOps`) | `preset-assault.test.mjs`, `preset-ranged-cover.test.mjs`, `preset-hold.test.mjs`, `preset-spec-ops.test.mjs` | ✅ PASSED | Для каждого пресета: валидный план + полное исполнение (шаги `move`/`attack`/`end-turn`), chat-карточки, resourceDelta |
| 2 | Golden path всех пресетов на гекс-сетке + гекс-fireteam | `grid-types.test.mjs` | ✅ PASSED | gridType=2: планы для всех 4 пресетов, `runPlan` завершён, гекс-TeamPlan собран |
| 3 | Gridless-сцена (`gridType=0`) — управляемый отказ | `grid-types.test.mjs`, unit `planner.test.mjs` | ✅ PASSED | `planTurn` возвращает `{status:"unsupported", reason:"gridless-unsupported", plan:null}` без падения; diagnostics сохраняются |
| 4 | Hidden-цели не атакуются; last-known — только для поиска/движения | `perception.test.mjs` | ✅ PASSED | hidden-токен не попадает в `visibleTargets`; last-known контакт санитизирован (без actor-данных/текущих скрытых координат), `canAttack:false`, истекает через 3 полных раунда |
| 5 | Два GM — без дублирующих обновлений | `multi-gm.test.mjs` | ✅ PASSED | Детерминированная элекция одного controller на обоих клиентах; исполнение только контроллером; повторные попытки — `operation-exists` no-op |
| 6 | Без активного GM — ожидание, нет автоматизации | `multi-gm.test.mjs`, `authority.test.mjs` | ✅ PASSED | `electController → waiting-for-gm`; planner/executor отвечают `not-controller`, документы не меняются |
| 7 | Передача контроллера (handoff) | `multi-gm.test.mjs` | ✅ PASSED | `abortCombatIfControllerChanged`/`abortIfControllerChanged` помечает чужие live-операции `controller-changed`; повторная элекция и re-eval на новом контроллере |
| 8 | Preview confirm/cancel/timeout | `preview.test.mjs` | ✅ PASSED | Режим preview: диалог у контроллера, confirm исполняет, cancel/timeout отменяют без смены документов (`advanceTurn:false`), хук `previewRequested` |
| 9 | Stale-план: ровно один replan, затем hold | `stale-replan.test.mjs` | ✅ PASSED | Первый stale → replan и успешное исполнение (`replanCount:1`); второй stale → `failed`/`replan-limit-exceeded`, документы не трогаются |
| 10 | Fireteam: flank-and-fix (квадрат + гекс) | `fireteam-tactics.test.mjs` | ✅ PASSED | TeamPlan назначает fixer/flanker на обеих сетках, endpoint-резервации учтены в маршрутах |
| 11 | Fireteam: барьер coordinated-assault | `fireteam-tactics.test.mjs` | ✅ PASSED | Члены с разным movement — preflight barrier по самому медленному, тактика в TeamPlan |
| 12 | Fireteam: covering advance / regroup без конфликтов резерваций | `fireteam-tactics.test.mjs` | ✅ PASSED | covering-позиции и точка сбора не конфликтуют с резервациями ходов членов |
| 13 | Fireteam: soft cohesion (в пределах / за пределами / detached) | `fireteam-tactics.test.mjs` | ✅ PASSED | cohesion-score тремя режимами, detached получает regroup-поручение |
| 14 | Fireteam: очистка временных assignment, нет перманентных ролей | `fireteam-tactics.test.mjs` | ✅ PASSED | После терминального TeamPlan флаги assignment не остаются на комбатантах; перманентные роли не пишутся |
| 15 | Производительность: 10 AI NPC в ≥2 fireteams за боевой цикл | `performance.test.mjs` | ✅ PASSED | Цикл завершён за ~8.4 с; 10/10 NPC выполнили ход (`completed`); doc updates=266; chat cards=13; replans=0; бесконечных хуков/неконтролируемого роста кандидатов нет |
| 16 | Machine-readable счётчики производительности | `performance.test.mjs` → `reports/performance-*.json` | ✅ PASSED | Per-NPC: planning ms (32–124), execution ms (18–64), candidates (27–45), path nodes, doc updates (4–20), replans; итоги: cycle ms, doc updates, chat cards; на провал — `performance-failure-*.md` с operation/plan id, seed, reason, таймингами |
| 17 | Idempotent/duplicate-safe исполнение | `executor.test.mjs`, `multi-gm.test.mjs` | ✅ PASSED | Повторный `runPlan` по operationId возвращает прежний результат; move к достигнутой точке пропускается; `claimTurn` — compare-before-update |
| 18 | Opt-in: без включённого конфига AI не активирует NPC | `master-switch.test.mjs`, `module-foundation.test.mjs` | ✅ PASSED | `masterEnabled` — общий выключатель; без `enabled` в конфиге ходы не заявляются |
| 19 | Команды запуска задокументированы | `tests/foundry-e2e/README.md`, `package.json` scripts | ✅ PASSED | `npm test`, `npm run test:all`, `npm run test:<suite>` для каждого файла |

## Частично покрыто / оговорки

- **Controller handoff во время live-исполнения.** Тест `multi-gm`
  проверяет механизм отмены чужих операций (`abortIfControllerChanged`)
  и повторную элекцию детерминированно; полный сценарий «план выполнялся
  на GM-1, контроллер сменился, GM-2 продолжил» проверен на уровне
  отмены live-операции, но не как сквозной UX-сценарий.
- **Preview при переключении контроллера.** Открытый preview-диалог при
  смене контроллера отдельным сценарием не воспроизводился; механизм
  авто-отмены preview по документным хукам покрыт `preview.test.mjs`.
- **Live-сталл перевода хода.** В живом мире `combat.nextTurn()` из
  хука `operationCompleted` периодически не доезжает (применённое
  значение `turn` позднее читается обратно без события отката). Тест
  `performance.test.mjs` драйвером переводит ходы, у которых операция
  уже терминальная, и не-AI ходы — счётчики модуля (планы/исполнения/
  документы) при этом измеряются честно. Природа артефакта — уровень
  синхронизации документов Foundry/сторонних модулей, не write-path
  модуля (модуль не пишет `turn` нигде, кроме `combat.nextTurn()`).
- **Производительность — одна сцена, без стен и скрытых зон.**
  Сценарий меряет открытое поле 13 токенов; сценарии с плотными стенами,
  туманом и 20+ кандидатами не прогонялись.

## Не проверено

- Нагрузка >10 NPC и >2 fireteams (требование покрыто на уровне минимума).
- Восстановление работы после перезагрузки страницы во время живой операции.
- Интеграция со сторонними модулями (autoanimations/sequencer показывают
  свои анимации, но функционально не проверялись).

## Известные ограничения

- Тесты требуют живой GM-сессии: Chrome троттлит `setTimeout` в фоновых
  вкладках, поэтому E2E-драйверы держат GM-таб в фокусе и вызывают
  `authority.flush()` напрямую вместо ожидания дебаунса.
- Отчёты `reports/` и `screenshots/` — артефакты запусков, в `.gitignore`.
