import { test } from "node:test"
import assert from "node:assert/strict"
import {
  BASE_URL, MAX_COUNT, TASK_FIELDS,
  endOfDay, startOfDay, todayQuery, incrementalQuery, projectsQuery,
  buildUrl, parseTasks, parseProjects, merge, isCurrent,
  isOverdue, normalizeExcluded, applyProjectFilter, countWindow
} from "../Api.mjs"

// Фиксированный «сейчас»: 3 сентября 2026, полдень, локальная зона машины.
const now = new Date(2026, 8, 3, 12, 0, 0)
const iso = (y, m, d, h = 9) => new Date(y, m, d, h).toISOString()
const yesterday = iso(2026, 8, 2)
const today = iso(2026, 8, 3)
const tomorrow = iso(2026, 8, 4)

const task = (over) => ({
  id: "T-1", title: "task", note: "", priority: 1, projectId: "P-1",
  start: today, deadline: null, checked: 0, deferred: false,
  deleteDate: null, removed: false, modificatedDate: today, ...over
})
const body = (tasks) => JSON.stringify({ tasks })

test("todayQuery: unchecked, start.lte end of local day, no deadline filter, explicit maxCount", () => {
  const q = todayQuery(now)
  assert.equal(q["checked.eq"], 0)
  assert.match(q["start.lte"], /^2026-09-03T23:59:59[+-]\d\d:\d\d$/)
  assert.equal(q.maxCount, MAX_COUNT)
  assert.equal(MAX_COUNT, 1000)
  assert.ok(!("deadline.lte" in q) && !("deadline.eq" in q))
  assert.equal(q.fields, TASK_FIELDS.join(","))
  assert.ok(!TASK_FIELDS.includes("removed"))
})

test("incrementalQuery: modifiedSince shifted 60s back, includeRemoved, no server-side today filters", () => {
  const since = new Date(2026, 8, 3, 11, 50, 0)
  const q = incrementalQuery(since)
  assert.equal(q.modifiedSince, new Date(since.getTime() - 60_000).toISOString())
  assert.equal(q.includeRemoved, true)
  assert.equal(q.maxCount, MAX_COUNT)
  assert.ok(!("checked.eq" in q) && !("start.lte" in q))
})

test("projectsQuery asks only id and title", () => {
  assert.equal(projectsQuery().fields, "id,title")
})

test("buildUrl encodes offsets and round-trips through URL", () => {
  const url = buildUrl("/v2/task", todayQuery(now))
  assert.ok(url.startsWith(BASE_URL + "/v2/task?"))
  const parsed = new URL(url)
  assert.equal(parsed.searchParams.get("start.lte"), todayQuery(now)["start.lte"])
  assert.equal(parsed.searchParams.get("checked.eq"), "0")
})

test("endOfDay/startOfDay stay on the same local day", () => {
  const late = new Date(2026, 8, 3, 23, 59, 59)
  assert.match(endOfDay(late), /^2026-09-03T/)
  assert.equal(startOfDay(late).getDate(), 3)
  assert.equal(startOfDay(late).getHours(), 0)
})

test("parseTasks: flat list with overdue flag", () => {
  const out = parseTasks(body([
    task({ id: "A", start: yesterday }),
    task({ id: "B", start: today }),
    task({ id: "C", start: null })
  ]), now)
  assert.deepEqual(out.map(t => [t.id, t.overdue]), [["A", true], ["B", false], ["C", false]])
  assert.deepEqual(Object.keys(out[0]).sort(),
    ["checked", "deadline", "deferred", "deleteDate", "id", "modifiedAt", "overdue", "priority", "projectId", "removed", "start", "title"])
})

test("parseTasks throws on non-JSON and on unexpected shape", () => {
  assert.throws(() => parseTasks("<html>", now), /JSON/)
  assert.throws(() => parseTasks(JSON.stringify({ nope: [] }), now), /tasks/)
})

test("parseProjects: id and title", () => {
  assert.deepEqual(parseProjects(JSON.stringify({ projects: [{ id: "P-1", title: "Work", note: "x" }] })),
    [{ id: "P-1", title: "Work" }])
})

test("merge: replace by id, drop checked/deleted/removed", () => {
  const cache = parseTasks(body([task({ id: "A" }), task({ id: "B" })]), now)
  const incoming = parseTasks(body([task({ id: "A", checked: 1 }), task({ id: "C" })]), now)
  assert.deepEqual(merge(cache, incoming, now).map(t => t.id).sort(), ["B", "C"])
  assert.deepEqual(merge(cache, parseTasks(body([task({ id: "A", deleteDate: today })]), now), now).map(t => t.id), ["B"])
  assert.deepEqual(merge(cache, parseTasks(body([task({ id: "A", removed: true })]), now), now).map(t => t.id), ["B"])
  const renamed = merge(cache, parseTasks(body([task({ id: "A", title: "renamed" })]), now), now)
  assert.equal(renamed.find(t => t.id === "A").title, "renamed")
})

test("merge: today predicate on the client — tomorrow, deferred, no start leave the cache", () => {
  const cache = parseTasks(body([task({ id: "A" })]), now)
  assert.deepEqual(merge(cache, parseTasks(body([task({ id: "A", start: tomorrow })]), now), now), [])
  assert.deepEqual(merge([], parseTasks(body([task({ id: "D", deferred: true })]), now), now), [])
  assert.deepEqual(merge([], parseTasks(body([task({ id: "E", start: null })]), now), now), [])
  assert.equal(isCurrent(parseTasks(body([task({ id: "F", start: yesterday })]), now)[0], now), true)
})

test("merge returns the same reference when nothing changed", () => {
  const cache = merge([], parseTasks(body([task({ id: "A" }), task({ id: "B" })]), now), now)
  assert.equal(merge(cache, [], now), cache)
  assert.equal(merge(cache, parseTasks(body([task({ id: "A" })]), now), now), cache)
  assert.notEqual(merge(cache, parseTasks(body([task({ id: "A", title: "renamed" })]), now), now), cache)
})

// --- Регрессия на локальную зону (AE7) ---
// Прогон обязан идти в зоне UTC+6 без перехода на летнее время: `TZ=Asia/Omsk node --test`.
// Именно так закреплено в CI. Без этого утверждение про 21 сентября бессмысленно, поэтому
// зона проверяется явно — иначе тест молча проверял бы не то.

test("AE7: полночь по местному времени приходит как 18:00 UTC предыдущих суток", () => {
  const probe = new Date(2026, 8, 21, 12)
  assert.equal(-probe.getTimezoneOffset() / 60, 6,
    "тест требует зоны UTC+6 без DST — запускать как `TZ=Asia/Omsk node --test`")

  // 20 сентября 18:00 UTC — это полночь 21 сентября в +06:00.
  const t = { start: "2026-09-20T18:00:00.000Z" }
  const onThe21st = new Date(2026, 8, 21, 12)
  const onThe22nd = new Date(2026, 8, 22, 12)

  assert.equal(isOverdue(t, onThe21st), false, "21 сентября задача этого дня не просрочена")
  assert.equal(isOverdue(t, onThe22nd), true, "22 сентября она уже просрочена")

  // Тот же вывод через разбор ответа: признак ставится тем же сравнением.
  const [parsed] = parseTasks(body([task({ start: "2026-09-20T18:00:00.000Z" })]), onThe21st)
  assert.equal(parsed.overdue, false)
  assert.equal(isCurrent(parsed, onThe21st), true, "задача 21 сентября попадает в окно этого дня")
})

// --- Отсев проектов и счётчики (SNG-2) ---

const projects = [
  { id: "P-1", title: "Дни рождения" },
  { id: "P-2", title: "Праздники и поздравления" },
  { id: "P-3", title: "Работа" }
]
// Разбор даёт те же объекты, что приходят в сервис, — фильтр проверяется на реальной форме.
const window8 = parseTasks(body([
  ...Array.from({ length: 5 }, (_, i) => task({ id: `B-${i}`, projectId: "P-1" })),
  ...Array.from({ length: 3 }, (_, i) => task({ id: `H-${i}`, projectId: "P-2" }))
]), now)

test("normalizeExcluded: массив и строка с запятыми дают один набор", () => {
  const fromArray = normalizeExcluded(["Дни рождения", " Работа "])
  const fromString = normalizeExcluded("Дни рождения, Работа")
  assert.deepEqual([...fromArray].sort(), [...fromString].sort())
  assert.deepEqual(normalizeExcluded(["", "  ", null]), new Set())
  assert.deepEqual(normalizeExcluded(undefined), new Set())
})

test("AE1: оба исключённых проекта уходят, счёт становится нулевым", () => {
  const kept = applyProjectFilter(window8, projects, ["Дни рождения", "Праздники и поздравления"])
  assert.equal(kept.length, 0)
  assert.deepEqual(countWindow(kept, now), { total: 0, overdue: 0 })
})

test("AE3: задача без проекта остаётся при непустом списке исключаемых", () => {
  const mixed = parseTasks(body([
    task({ id: "T-loose", projectId: null }),
    task({ id: "T-birthday", projectId: "P-1" })
  ]), now)
  const kept = applyProjectFilter(mixed, projects, ["Дни рождения"])
  assert.deepEqual(kept.map((t) => t.id), ["T-loose"])
})

test("исключение срабатывает при другом регистре и лишних пробелах", () => {
  const kept = applyProjectFilter(window8, projects, ["  дНи РоЖдЕнИя  "])
  assert.equal(kept.length, 3, "остаются только праздники")
})

test("название, которого нет ни у одного проекта, ничего не отсеивает и не роняет функцию", () => {
  const kept = applyProjectFilter(window8, projects, ["Проект-которого-нет"])
  assert.equal(kept, window8, "тот же массив: тихий гейт сервиса не должен сработать")
})

test("пустой список исключаемых возвращает исходный набор той же ссылкой", () => {
  assert.equal(applyProjectFilter(window8, projects, []), window8)
  assert.equal(applyProjectFilter(window8, projects, ""), window8)
})

test("KTD2: правило по названию исключает все одноимённые проекты разом", () => {
  const twins = [{ id: "P-1", title: "Дни рождения" }, { id: "P-9", title: "дни рождения" }]
  const tasks = parseTasks(body([
    task({ id: "A", projectId: "P-1" }),
    task({ id: "B", projectId: "P-9" }),
    task({ id: "C", projectId: "P-3" })
  ]), now)
  const kept = applyProjectFilter(tasks, twins, ["Дни рождения"])
  assert.deepEqual(kept.map((t) => t.id), ["C"])
})

test("пустой кэш проектов не отсеивает ничего — состояние «отсев не применён»", () => {
  assert.equal(applyProjectFilter(window8, [], ["Дни рождения"]), window8)
})

test("countWindow: верные total и overdue на смеси просроченных и сегодняшних", () => {
  const mixed = parseTasks(body([
    task({ id: "O-1", start: yesterday }),
    task({ id: "O-2", start: yesterday }),
    task({ id: "T-1", start: today })
  ]), now)
  assert.deepEqual(countWindow(mixed, now), { total: 3, overdue: 2 })
})

test("countWindow считает просрочку заново: тот же набор при другом now даёт другой overdue", () => {
  const tasks = parseTasks(body([task({ id: "T-1", start: today })]), now)
  assert.equal(tasks[0].overdue, false, "признак заморожен на момент разбора")
  assert.deepEqual(countWindow(tasks, now), { total: 1, overdue: 0 })
  const nextDay = new Date(2026, 8, 4, 12)
  assert.deepEqual(countWindow(tasks, nextDay), { total: 1, overdue: 1 },
    "на следующие сутки та же задача просрочена, хотя признак в объекте не менялся")
})
