---
title: Инкрементальная синхронизация не наследует серверные фильтры окна — окно применяется на клиенте
date: 2026-09-03
category: design-patterns
module: Service.qml / Api.mjs — опрос SingularityApp
problem_type: design_pattern
component: service_object
severity: high
applies_when:
  - "клиент держит кэш «окна» (сегодняшние, открытые, назначенные мне) и обновляет его инкрементом по modifiedSince или аналогу"
  - "полная выборка строится с серверными фильтрами по полям, которые меняются при выходе сущности из окна (checked, start, status, assignee)"
  - "API без вебхуков — только опрос"
tags: [incremental-sync, modified-since, cache-invalidation, polling, singularity-api, rest]
---

# Инкрементальная синхронизация не наследует серверные фильтры окна — окно применяется на клиенте

## Context

Сервис плагина держит кэш «сегодняшних» задач SingularityApp и обновляет его каждые десять минут. Полная выборка идёт с серверными фильтрами `checked.eq=0` и `start.lte=<конец дня>`. Первая версия плана строила инкремент как «те же параметры плюс `modifiedSince`». Ревью плана (feasibility и adversarial, независимо) показало: задача, которую пользователь завершил или перенёс на завтра, под этими фильтрами сервер **не вернёт никогда** — она больше не удовлетворяет `checked.eq=0` или `start.lte`. Инкремент видит только вход в окно, но не выход из него, и кэш чистится только полной выборкой, то есть раз в сутки.

## Guidance

Фильтры окна принадлежат ровно одному месту — клиентскому предикату, который применяется к результату слияния.

- **Полная выборка** может нести серверные фильтры окна: она заменяет кэш целиком, выход из окна ей не важен.
- **Инкремент** несёт только `modifiedSince` (с запасом назад на рассинхрон часов) и `includeRemoved`, без фильтров окна: сервер должен отдать всё изменённое, включая то, что окно покинуло.
- **Слияние**: заменить по id, затем отбросить всё, что не проходит предикат окна, — один и тот же предикат для полной выборки и инкремента (`Api.mjs`, функции `isCurrent` и `merge`).
- **Полная выборка принудительно** — на старте, при смене локальной даты (сущности входят в окно «сегодня» не изменяясь, инкремент их не увидит) и по ручному обновлению.
- **Возврат прежней ссылки из `merge` — контракт уровня слияния, и только его.** Если между слиянием и потребителем появляется ещё один шаг (отсев, проекция, сортировка), тождество для публикуемого набора обязан обеспечивать **этот** шаг: `merge` о нём ничего не знает и его ссылку не сохраняет. Разбор случая, где это правило нарушили, — [`quiet-gate-identity-check-outside-pure-function.md`](../logic-errors/quiet-gate-identity-check-outside-pure-function.md).

```js
// Api.mjs — инкремент без фильтров окна
export function incrementalQuery(since) {
  const from = new Date(new Date(since).getTime() - INCREMENTAL_OVERLAP_MS)
  return { modifiedSince: from.toISOString(), includeRemoved: true, maxCount: MAX_COUNT, fields: TASK_FIELDS.join(",") }
}

// окно — на клиенте, один владелец
export function isCurrent(task, now) {
  if (task.checked !== 0 || task.removed || task.deleteDate || task.deferred) return false
  if (!task.start) return false
  return new Date(task.start).getTime() <= endOfDayDate(now).getTime()
}

export function merge(cache, incoming, now) {
  const byId = new Map(cache.map((t) => [t.id, t]))
  for (const t of incoming) byId.set(t.id, t)
  const next = [...byId.values()].filter((t) => isCurrent(t, now)).sort(byStartThenTitle)
  return sameTasks(cache, next) ? cache : next
}
```

Смежная ловушка того же класса: ключ «полная выборка за день сделана» надо брать от момента **старта** запроса, а не от ответа, — запрос, стартовавший до полуночи и завершившийся после, иначе помечает новый день выбранным, хотя его окно строилось для старого.

## Why This Matters

Ошибка не проявляется ни в тестах на фикстурах, ни в первый час работы: кэш заполняется правильно и растёт. Она видна только как «завершённая задача висит в счётчике до завтра» — то есть на живых данных и с задержкой. Ревью плана поймало её до кода, потому что смотрело на то, что сервер **не** пришлёт, а не на то, что пришлёт.

## When to Apply

- Любой кэш, определённый предикатом от изменяемых полей, который обновляется дельтой «что изменилось с момента X».
- Особенно когда у API нет вебхуков и есть `includeRemoved`/`deleted` в выдаче — признак, что дельта задумана как «все изменения», а не «изменения внутри окна».

## Examples

До: `incrementalQuery = { ...todayQuery(now), modifiedSince }` — завершённая задача A остаётся в кэше до следующего дня.

После: инкремент без `checked.eq`/`start.lte`; `merge([A, B], [A(checked: 1), C], now)` даёт `[B, C]`; входящая A со `start` завтра убирает A из кэша; тест `test/api.test.mjs`, сценарии «merge: today predicate on the client».

`merge` владеет **кэшем**, а не тем, что видят поверхности: с SNG-2 его результат кладётся в полное окно, а публикуемый вид собирается шагом выше. Слить дельту поверх публикуемого вида нельзя — задачи, отсеянные фильтром, ушли бы из кэша насовсем.

## Related

- `docs/plans/2026-09-03-001-feat-sng-1-karkas-plan.md` — KTD4 и U1, где решение зафиксировано после ревью плана.
- `docs/residual-review-findings/feat-sng-1-karkas.md` — что из той же области проверяется только живым токеном (`deleteDate` при `includeRemoved`, формат `start`).
- [`quiet-gate-identity-check-outside-pure-function.md`](../logic-errors/quiet-gate-identity-check-outside-pure-function.md) — соседняя запись SNG-2: тот же принцип единственного владельца, применённый к решению о равенстве, и что бывает, когда это решение остаётся у вызывающего.
