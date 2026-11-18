# Foundry E2E tests (Only War AI)

Playwright end-to-end тесты, требующие запущенный Foundry VTT с установленной
системой `only-war-local` и модулем `only-war-ai`, а также браузер с открытым
CDP-портом.

## Prerequsites

```powershell
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

Foundry должен быть доступен по `FOUNDRY_URL` (по умолчанию
`http://localhost:30000`).

## Запуск

```text
cd tests/foundry-e2e
npm install
npm test
```

## Переменные окружения

- `CDP_URL` — endpoint Chrome DevTools Protocol (по умолчанию `http://localhost:9222`).
- `FOUNDRY_URL` — адрес Foundry (по умолчанию `http://localhost:30000`).
- `SCREENSHOT_DIR` — папка для скриншотов (по умолчанию `./screenshots`).
- `FOUNDRY_RELOAD` — `1` для полной перезагрузки страницы перед тестом.

## Тесты

| Тест | Что проверяет |
|---|---|
| `module-foundation.test.mjs` | Модуль активен, `api` опубликован (version/capabilities/services/resolver), world settings зарегистрированы, флаги `flags["only-war-ai"]` пишутся и читаются на Actor/Token/Combatant, resolver даёт ожидаемый приоритет, секция на листе NPC (при включённом модуле). |
