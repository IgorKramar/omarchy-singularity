import { test } from "node:test"
import assert from "node:assert/strict"
import {
  BASE_URL, MAX_COUNT, TASK_FIELDS,
  endOfDay, startOfDay, todayQuery, incrementalQuery, projectsQuery,
  buildUrl, parseTasks, parseProjects, merge, isCurrent,
  isOverdue, normalizeExcluded, applyProjectFilter, countWindow,
  computeView, excludedList,
  sliceByTab, groupByProject, hiddenGroups, isCollapsed, flattenGroups,
  moveCursor, cursorIndexForId, popupView,
  errorClass, unmatchedExcluded, emptyReason,
  toggleKey, isStale, priorityLabel, footerState,
  parseNote, taskFields, recurrenceState, taskWebUrl, WEB_BASE,
  MUTATIONS, escapeCurlConfigValue, buildCurlConfig, buildRequestCommand,
  buildCreateBody, buildRenameBody, parseTask
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
  // Форма кэшируемой задачи закреплена целиком: поле, добавленное в запрашиваемые и
  // забытое здесь, приходило бы из API и молча пропадало.
  assert.deepEqual(Object.keys(out[0]).sort(),
    ["checked", "deadline", "deferred", "deleteDate", "id", "modifiedAt", "note", "overdue",
     "priority", "projectId", "recurrence", "recurrenceGeneratorId", "removed", "start", "title"])
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

// --- Вид и тихий гейт (SNG-2, находки ревью кода) ---
// Пять ревьюеров независимо нашли одно: отсев отдаёт новый массив каждый раз, когда что-то
// выбрасывает, поэтому сравнение по ссылке на стороне сервиса объявляло изменение на каждом
// опросе — ровно у тех, кто фильтр настроил. Ниже тесты на само это свойство.

test("отсев на пути отбрасывания строит новый массив каждый вызов — сравнивать по ссылке нельзя", () => {
  const first = applyProjectFilter(window8, projects, ["Дни рождения"])
  const second = applyProjectFilter(window8, projects, ["Дни рождения"])
  assert.notEqual(first, second, "это и есть контракт, под который обязан подстраиваться вызывающий")
  assert.deepEqual(first.map((t) => t.id), second.map((t) => t.id))
})

test("название совпало с проектом, у которого нет задач в окне — исходный массив той же ссылкой", () => {
  // Единственная форма входа, попадающая во вторую половину тернарника в applyProjectFilter.
  assert.equal(applyProjectFilter(window8, projects, ["Работа"]), window8)
})

test("computeView: повторный вызов на неизменном окне возвращает прежнюю ссылку — гейт держится", () => {
  let view = computeView([], window8, projects, ["Дни рождения"], now)
  assert.equal(view.tasks.length, 3)
  const settled = view.tasks
  for (let i = 0; i < 3; i++) {
    view = computeView(view.tasks, window8, projects, ["Дни рождения"], now)
    assert.equal(view.tasks, settled, "тихий опрос не должен подменять ссылку")
  }
})

test("computeView: изменение окна ссылку меняет", () => {
  const view = computeView([], window8, projects, ["Дни рождения"], now)
  const shorter = computeView(view.tasks, window8.slice(0, 6), projects, ["Дни рождения"], now)
  assert.notEqual(shorter.tasks, view.tasks)
  assert.equal(shorter.total, 1)
})

test("computeView: пустой кэш проектов при непустом списке — отсев не применён", () => {
  const view = computeView([], window8, [], ["Дни рождения"], now)
  assert.equal(view.applied, false, "сопоставлять название не с чем")
  assert.equal(view.tasks, window8, "окно отдаётся как есть, а не как отфильтрованное")
  assert.equal(view.total, 8)
  assert.equal(view.excludedCount, 1)
})

test("computeView: пустой список исключаемых считается применённым", () => {
  const view = computeView([], window8, [], [], now)
  assert.equal(view.applied, true)
  assert.equal(view.excludedCount, 0)
})

test("computeView: счётчики берутся из отсеянного набора, а не из полного окна", () => {
  const mixed = parseTasks(body([
    task({ id: "O-1", projectId: "P-1", start: yesterday }),
    task({ id: "O-2", projectId: "P-3", start: yesterday }),
    task({ id: "T-1", projectId: "P-3", start: today })
  ]), now)
  const view = computeView([], mixed, projects, ["Дни рождения"], now)
  assert.deepEqual({ total: view.total, overdue: view.overdue }, { total: 2, overdue: 1 })
})

test("excludedList: массив и строка дают один и тот же список одной формы", () => {
  assert.deepEqual(excludedList("Дни рождения, Работа"), ["дни рождения", "работа"])
  assert.deepEqual(excludedList([" Дни рождения ", "РАБОТА"]), ["дни рождения", "работа"])
  assert.deepEqual(excludedList(undefined), [])
})

test("normalizeExcluded сверяется с ожидаемым набором, а не сам с собой", () => {
  assert.deepEqual(normalizeExcluded(" Дни Рождения , работа "), new Set(["дни рождения", "работа"]))
})

test("isOverdue: задача без start и пустой аргумент не роняют функцию", () => {
  assert.equal(isOverdue({ start: null }, now), false)
  assert.equal(isOverdue(null, now), false)
  assert.equal(isOverdue(undefined, now), false)
})

// ---- SNG-3: вид попапа и курсор -----------------------------------------

// Три проекта и четыре задачи: две в «Даче», по одной в «Работе» и без проекта.
const projectsFixture = [
  { id: "P-1", title: "Работа" },
  { id: "P-2", title: "Дача" }
]
const t = (id, over) => task({ id, ...over })

test("sliceByTab: «сегодня» и «просрочено» — дополняющие разрезы, «все» — окно целиком", () => {
  const tasks = [t("A", { start: yesterday }), t("B", { start: today })]
  assert.deepEqual(sliceByTab(tasks, "overdue", now).map((x) => x.id), ["A"])
  assert.deepEqual(sliceByTab(tasks, "today", now).map((x) => x.id), ["B"])
  assert.equal(sliceByTab(tasks, "all", now), tasks)
  assert.equal(sliceByTab(tasks, "today", now).length + sliceByTab(tasks, "overdue", now).length,
    tasks.length)
})

test("sliceByTab считает просрочку от now, а не от признака, замороженного при разборе", () => {
  // Задача со стартом сегодня: до полуночи она в «сегодня», после — в «просрочено».
  const [task3] = parseTasks(body([{ ...task({ start: today }) }]), now)
  const nextDay = new Date(2026, 8, 4, 12, 0, 0)
  assert.equal(sliceByTab([task3], "today", now).length, 1)
  assert.equal(sliceByTab([task3], "overdue", now).length, 0)
  assert.equal(sliceByTab([task3], "overdue", nextDay).length, 1)
  assert.equal(sliceByTab([task3], "today", nextDay).length, 0)
  assert.equal(task3.overdue, false, "сам признак задачи при этом не менялся")
})

test("sliceByTab возвращает прежнюю ссылку, когда разрез ничего не отбросил", () => {
  const tasks = [t("A", { start: yesterday })]
  assert.equal(sliceByTab(tasks, "overdue", now), tasks)
  assert.notEqual(sliceByTab(tasks, "today", now), tasks)
})

test("groupByProject: секция на проект, отдельная — для задач без проекта", () => {
  const tasks = [
    t("A", { projectId: "P-2" }), t("B", { projectId: "P-1" }),
    t("C", { projectId: "P-2" }), t("D", { projectId: null })
  ]
  const groups = groupByProject(null, tasks, projectsFixture)
  assert.deepEqual(groups.map((g) => [g.title, g.count]),
    [["Дача", 2], ["Работа", 1], ["Без проекта", 1]])
  assert.deepEqual(groups.map((g) => g.kind), ["project", "project", "none"])
})

test("groupByProject: неразрешимый projectId идёт в свою секцию, а не к задачам без проекта", () => {
  const tasks = [t("A", { projectId: null }), t("B", { projectId: "P-404" })]
  const groups = groupByProject(null, tasks, projectsFixture)
  assert.deepEqual(groups.map((g) => g.kind), ["none", "unknown"])
  assert.deepEqual(groups.map((g) => g.count), [1, 1])
  assert.notEqual(groups[0].key, groups[1].key)
})

test("groupByProject возвращает прежнюю ссылку на неизменном входе", () => {
  const tasks = [t("A", { projectId: "P-1" })]
  const first = groupByProject(null, tasks, projectsFixture)
  assert.equal(groupByProject(first, tasks, projectsFixture), first)
  assert.notEqual(groupByProject(first, [...tasks, t("B", { projectId: "P-2" })], projectsFixture), first)
})

test("hiddenGroups: разность окна и отсеянного вида даёт секции и число скрытых ЗАДАЧ", () => {
  const all = [
    t("A", { projectId: "P-1" }), t("B", { projectId: "P-2" }), t("C", { projectId: "P-2" })
  ]
  const visible = all.filter((x) => x.projectId !== "P-2")
  const hidden = hiddenGroups(null, all, visible, projectsFixture, "all", now)
  assert.equal(hidden.taskCount, 2, "две задачи, а не одно название в настройке")
  assert.deepEqual(hidden.groups.map((g) => [g.title, g.count, g.hidden]), [["Дача", 2, true]])
})

test("hiddenGroups: при пустом отсеве секций нет и число скрытых равно нулю", () => {
  const all = [t("A", { projectId: "P-1" })]
  const hidden = hiddenGroups(null, all, all, projectsFixture, "all", now)
  assert.deepEqual(hidden.groups, [])
  assert.equal(hidden.taskCount, 0)
})

test("hiddenGroups возвращает прежнюю ссылку на неизменном входе", () => {
  const all = [t("A", { projectId: "P-1" }), t("B", { projectId: "P-2" })]
  const visible = [all[0]]
  const first = hiddenGroups(null, all, visible, projectsFixture, "all", now).groups
  assert.equal(hiddenGroups(first, all, visible, projectsFixture, "all", now).groups, first)
  assert.notEqual(hiddenGroups(first, all, all, projectsFixture, "all", now).groups, first)
})

test("isCollapsed: обычная секция по умолчанию развёрнута, скрытая — свёрнута", () => {
  const plain = { key: "P-1", hidden: false }
  const secret = { key: "P-2", hidden: true }
  assert.equal(isCollapsed(plain, []), false)
  assert.equal(isCollapsed(plain, [toggleKey(plain)]), true)
  assert.equal(isCollapsed(secret, []), true)
  assert.equal(isCollapsed(secret, [toggleKey(secret)]), false)
})

test("flattenGroups: заголовки и строки в порядке отрисовки; свёрнутая секция даёт только заголовок", () => {
  const groups = groupByProject(null, [
    t("A", { projectId: "P-1" }), t("B", { projectId: "P-2" }), t("C", { projectId: "P-2" })
  ], projectsFixture)
  assert.deepEqual(flattenGroups(null, groups, []).map((r) => r.kind),
    ["header", "task", "task", "header", "task"])
  // Секции идут по алфавиту: groups[0] — «Дача» с двумя задачами.
  const collapsed = flattenGroups(null, groups, [toggleKey(groups[0])])
  assert.deepEqual(collapsed.map((r) => r.kind), ["header", "header", "task"])
})

test("flattenGroups возвращает прежнюю ссылку на неизменном входе", () => {
  const groups = groupByProject(null, [t("A", { projectId: "P-1" })], projectsFixture)
  const first = flattenGroups(null, groups, [])
  assert.equal(flattenGroups(first, groups, []), first)
  assert.notEqual(flattenGroups(first, groups, [toggleKey(groups[0])]), first)
})

test("moveCursor заворачивается по кругу на обоих концах", () => {
  assert.equal(moveCursor(-1, 1, 3), 0, "с не выставленного курсора вниз — на первую строку")
  assert.equal(moveCursor(-1, -1, 3), 2, "и вверх — на последнюю")
  assert.equal(moveCursor(2, 1, 3), 0)
  assert.equal(moveCursor(0, -1, 3), 2)
  assert.equal(moveCursor(0, 1, 0), -1, "в пустом списке курсора нет")
})

test("cursorIndexForId держится за задачу при вставке строки выше неё", () => {
  const before = [{ kind: "header", id: "h:P-1", key: "P-1" }, { kind: "task", id: "task:B", key: "P-1" }]
  const after = [{ kind: "header", id: "h:P-1", key: "P-1" }, { kind: "task", id: "task:A", key: "P-1" }, { kind: "task", id: "task:B", key: "P-1" }]
  assert.equal(cursorIndexForId(after, "task:B", 1, "P-1"), 2)
  assert.equal(cursorIndexForId(before, "task:B", 1, "P-1"), 1)
})

test("cursorIndexForId: ушедшая задача уводит курсор на следующую в своей секции", () => {
  // Было: заголовок, A, B, C. Ушла B — курсор идёт на C, а не на соседнюю секцию.
  const after = [
    { kind: "header", id: "h:P-1", key: "P-1" }, { kind: "task", id: "task:A", key: "P-1" }, { kind: "task", id: "task:C", key: "P-1" },
    { kind: "header", id: "h:P-2", key: "P-2" }, { kind: "task", id: "task:D", key: "P-2" }
  ]
  assert.equal(cursorIndexForId(after, "task:B", 2, "P-1"), 2)
})

test("cursorIndexForId: ушла последняя в секции — курсор на предыдущую, опустела — на заголовок", () => {
  const tailGone = [
    { kind: "header", id: "h:P-1", key: "P-1" }, { kind: "task", id: "task:A", key: "P-1" },
    { kind: "header", id: "h:P-2", key: "P-2" }, { kind: "task", id: "task:D", key: "P-2" }
  ]
  assert.equal(cursorIndexForId(tailGone, "task:B", 2, "P-1"), 1, "не уводит на заголовок соседа")

  const emptied = [{ kind: "header", id: "h:P-1", key: "P-1" }, { kind: "header", id: "h:P-2", key: "P-2" }, { kind: "task", id: "task:D", key: "P-2" }]
  assert.equal(cursorIndexForId(emptied, "task:A", 1, "P-1"), 0)
})

test("cursorIndexForId: пустой список и исчезнувшая секция одинаково снимают курсор", () => {
  assert.equal(cursorIndexForId([], "task:A", 1, "P-1"), -1)
  const noSection = [{ kind: "header", id: "h:P-9", key: "P-9" }, { kind: "task", id: "task:Z", key: "P-9" }]
  // Переписано в SNG-3.1: прежде здесь ожидался откат на индекс, то есть посадка
  // курсора на строку чужого проекта. С появлением действий над задачей это стало бы
  // правкой не той задачи.
  assert.equal(cursorIndexForId(noSection, "task:A", 1, "P-1"), -1)
  assert.equal(cursorIndexForId(noSection, "task:A", -1, "P-1"), -1)
})

test("popupView: одна ссылка наружу, стабильная на неизменном входе", () => {
  const all = [t("A", { projectId: "P-1" }), t("B", { projectId: "P-2" })]
  const visible = [all[0]]
  const args = { allTasks: all, tasks: visible, projects: projectsFixture, tab: "all", collapsed: [], now }
  const first = popupView(null, args)
  const second = popupView(first, args)
  assert.equal(second.groups, first.groups)
  assert.equal(second.hidden, first.hidden)
  assert.equal(second.flat, first.flat)
  assert.equal(first.hiddenTaskCount, 1)
  assert.equal(first.count, 1, "число вкладки не учитывает скрытые задачи")
})

test("popupView: скрытые секции стоят в списке вместе с обычными и свёрнуты по умолчанию", () => {
  const all = [t("A", { projectId: "P-1" }), t("B", { projectId: "P-2" })]
  const view = popupView(null, {
    allTasks: all, tasks: [all[0]], projects: projectsFixture, tab: "all", collapsed: [], now
  })
  assert.deepEqual(view.sections.map((g) => [g.title, g.hidden]), [["Дача", true], ["Работа", false]])
  assert.deepEqual(view.flat.map((r) => r.kind), ["header", "header", "task"])
})

test("popupView отдаёт тот же объект, пока ничего не двигалось, и новый после полуночи", () => {
  const all = [t("A", { projectId: "P-1" })]
  const args = { allTasks: all, tasks: all, projects: projectsFixture, tab: "all", collapsed: [], now }
  const first = popupView(null, args)
  assert.equal(popupView(first, args), first, "тихий опрос не должен перестраивать список")
  const nextDay = popupView(first, { ...args, now: new Date(2026, 8, 4, 12, 0, 0) })
  assert.notEqual(nextDay, first, "новые сутки меняют разметку просрочки при тех же задачах")
})

test("errorClass разбирает сырой stderr по классам, а не пересказывает его", () => {
  assert.equal(errorClass("curl: (22) The requested URL returned error: 401"), "auth")
  assert.equal(errorClass("curl: (6) Could not resolve host: api.singularity-app.com"), "network")
  assert.equal(errorClass("curl: (28) Operation timed out after 15000 milliseconds"), "network")
  assert.equal(errorClass("response is not JSON: Unexpected token <"), "response")
  assert.equal(errorClass("response has no tasks array"), "response")
  assert.equal(errorClass("что-то пошло не так"), "unknown")
  assert.equal(errorClass(""), "none")
  assert.equal(errorClass(null), "none")
})

test("unmatchedExcluded называет то, что в настройке есть, а среди проектов нет", () => {
  assert.deepEqual(unmatchedExcluded(projectsFixture, ["Дача", "Даччя"]), ["даччя"])
  assert.deepEqual(unmatchedExcluded(projectsFixture, ["Дача"]), [])
  assert.deepEqual(unmatchedExcluded([], ["Дача"]), ["дача"], "пустой кэш проектов — не совпало ничего")
  assert.deepEqual(unmatchedExcluded(projectsFixture, []), [])
})

test("emptyReason: пять видов пустоты не подменяют друг друга", () => {
  assert.equal(emptyReason("ready", 3, 0, 2), "", "непустая вкладка причины не требует")
  assert.equal(emptyReason("no-token", 0, 0, 0), "no-token")
  assert.equal(emptyReason("error", 0, 0, 0), "error")
  assert.equal(emptyReason("loading", 0, 0, 0), "loading")
  assert.equal(emptyReason("ready", 0, 0, 0), "all-clear")
  assert.equal(emptyReason("ready", 3, 3, 0), "all-hidden", "«всё чисто» и «скрыто N» вместе не идут")
  assert.equal(emptyReason("ready", 3, 1, 0), "tab-empty", "окно не пусто, пуст разрез вкладки")
})

test("emptyReason: пришедший кэш важнее состояния загрузки", () => {
  assert.equal(emptyReason("loading", 3, 3, 0), "all-hidden")
  assert.equal(emptyReason("loading", 3, 0, 0), "tab-empty")
})

// ---- Находки ревью SNG-3 -------------------------------------------------

test("groupByProject замечает переименование проекта при неизменном наборе задач", () => {
  // Тот самый пробел, через который дефект прошёл 56 зелёных тестов: набор задач тот же,
  // счётчик тот же, ключ тот же — меняется только имя, и гейт говорил «ничего не двигалось».
  const tasks = [t("A", { projectId: "P-2" })]
  const first = groupByProject(null, tasks, projectsFixture)
  assert.equal(first[0].title, "Дача")
  const renamed = [{ id: "P-1", title: "Работа" }, { id: "P-2", title: "Огород" }]
  const second = groupByProject(first, tasks, renamed)
  assert.notEqual(second, first, "переименование обязано перестроить секции")
  assert.equal(second[0].title, "Огород")
})

test("hiddenGroups тоже замечает переименование скрытого проекта", () => {
  const all = [t("A", { projectId: "P-1" }), t("B", { projectId: "P-2" })]
  const visible = [all[0]]
  const first = hiddenGroups(null, all, visible, projectsFixture, "all", now).groups
  const renamed = [{ id: "P-1", title: "Работа" }, { id: "P-2", title: "Огород" }]
  const second = hiddenGroups(first, all, visible, renamed, "all", now).groups
  assert.notEqual(second, first)
  assert.equal(second[0].title, "Огород")
})

test("toggleKey: запись помнит умолчание, от которого отступили", () => {
  const plain = { key: "P-1", hidden: false }
  const secret = { key: "P-1", hidden: true }
  assert.notEqual(toggleKey(plain), toggleKey(secret),
    "один ключ на два умолчания переворачивал бы секцию при выходе проекта из отсева")
})

test("isCollapsed: проект, вышедший из отсева, не переворачивает свою секцию", () => {
  const secret = { key: "P-2", hidden: true }
  // Пользователь развернул скрытую секцию: её ключ уходит в набор.
  const toggled = [toggleKey(secret)]
  assert.equal(isCollapsed(secret, toggled), false, "развёрнута, как и просили")
  // Проект убрали из списка исключаемых — секция стала обычной.
  const plain = { key: "P-2", hidden: false }
  assert.equal(isCollapsed(plain, toggled), false,
    "обычная секция по умолчанию развёрнута; прежняя запись не должна её сворачивать")
})

test("hiddenGroups следует активной вкладке, а число скрытых остаётся по всему окну", () => {
  const all = [
    t("A", { projectId: "P-2", start: yesterday }),
    t("B", { projectId: "P-2", start: today }),
    t("C", { projectId: "P-1", start: today })
  ]
  const visible = [all[2]]
  const over = hiddenGroups(null, all, visible, projectsFixture, "overdue", now)
  assert.equal(over.groups[0].count, 1, "на «Просрочено» в секции только просроченная")
  assert.equal(over.taskCount, 2, "а скрыто по-прежнему две задачи окна (R13)")
  const todayTab = hiddenGroups(null, all, visible, projectsFixture, "today", now)
  assert.equal(todayTab.groups[0].count, 1)
  assert.equal(todayTab.taskCount, 2)
})

test("isStale: пустая и непарсимая отметка считаются устаревшими", () => {
  const nowMs = new Date(2026, 8, 4, 12, 0, 0)
  assert.equal(isStale("", nowMs), true, "ничего ещё не приходило — надо опросить")
  assert.equal(isStale("не-дата", nowMs), true, "отметке, которую не разобрать, доверять нечему")
  assert.equal(isStale(new Date(2026, 8, 4, 11, 59, 30).toISOString(), nowMs), false)
  assert.equal(isStale(new Date(2026, 8, 4, 11, 58, 0).toISOString(), nowMs), true)
  assert.equal(isStale(new Date(2026, 8, 4, 11, 59, 0).toISOString(), nowMs), true, "ровно порог — устарело")
})

test("priorityLabel закрепляет шкалу API, а не догадку о ней", () => {
  assert.equal(priorityLabel(0), "выс", "0 — высокий, шкала перевёрнута")
  assert.equal(priorityLabel(1), "")
  assert.equal(priorityLabel(2), "низ")
  assert.equal(priorityLabel(undefined), "")
})

test("footerState: «отсев не применён» и «скрыто N» не показываются вместе", () => {
  const notApplied = footerState(false, 2, 7, [], ["дача", "по"])
  assert.equal(notApplied.kind, "not-applied")
  assert.deepEqual(notApplied.unmatched, [],
    "пока кэша проектов нет, не совпало вообще ничто — называть эти имена значит врать")
  assert.equal(notApplied.hiddenTaskCount, 0)

  const hidden = footerState(true, 1, 3, projectsFixture, ["дача", "нетакого"])
  assert.equal(hidden.kind, "hidden")
  assert.equal(hidden.hiddenTaskCount, 3)
  assert.deepEqual(hidden.unmatched, ["нетакого"])

  assert.equal(footerState(true, 0, 0, projectsFixture, []).kind, "none")
})

test("emptyReason молчит при ошибке с непустым кэшем — подвал обязан сказать это сам", () => {
  // Закрепляем разделение обязанностей: сообщение о пустоте отвечает только за пустоту,
  // а провалившийся опрос поверх живого списка показывает подвал.
  assert.equal(emptyReason("error", 3, 0, 2), "",
    "список есть — место сообщению об ошибке в подвале, а не поверх списка")
  assert.equal(emptyReason("error", 0, 0, 0), "error")
})

// ---- U1: закрытие резидуалов SNG-3 ---------------------------------------

test("flattenGroups замечает подмену объекта секции при тех же ключе и задачах", () => {
  // Резидуал 4. Строка несёт ссылку на секцию; действие пойдёт по ней.
  // Ключ у заголовка вшит в идентификатор, поэтому сравнивать надо объект.
  const tasks = [t("A", { projectId: "P-1" })]
  const first = groupByProject(null, tasks, projectsFixture)
  const flatFirst = flattenGroups(null, first, [])
  // Меняем только название: состав плоского списка тот же, поэтому сравнение
  // обязано дойти до самого объекта секции. Смена hidden не годится — она меняет
  // число строк, и тест позеленел бы, не проверив ничего.
  const moved = [{ ...first[0], title: "Огород" }]
  const flatMoved = flattenGroups(flatFirst, moved, [])
  assert.notEqual(flatMoved, flatFirst,
    "строка не должна нести ссылку на вытесненную секцию")
  assert.equal(flatMoved[0].group, moved[0])
})

test("cursorIndexForId снимает курсор, когда от его секции не осталось строк", () => {
  // Резидуал 5. Клампинг сажал курсор на строку чужого проекта; после мутации
  // это стало бы правкой не той задачи.
  const gone = [
    { kind: "header", id: "h:P-9", key: "P-9" },
    { kind: "task", id: "task:Z", key: "P-9" }
  ]
  assert.equal(cursorIndexForId(gone, "task:A", 1, "P-1"), -1,
    "ни заголовок, ни задача чужой секции курсору не годятся")
  assert.equal(cursorIndexForId(gone, "task:A", 0, "P-1"), -1)
})

test("cursorIndexForId сохраняет прежнее поведение там, где секция уцелела", () => {
  const alive = [
    { kind: "header", id: "h:P-1", key: "P-1" },
    { kind: "task", id: "task:A", key: "P-1" },
    { kind: "task", id: "task:C", key: "P-1" }
  ]
  assert.equal(cursorIndexForId(alive, "task:C", 1, "P-1"), 2, "находит по идентификатору")
  assert.equal(cursorIndexForId(alive, "task:B", 2, "P-1"), 2, "откат вперёд внутри секции")
  assert.equal(cursorIndexForId(alive, "task:B", 3, "P-1"), 2, "откат назад внутри секции")
  assert.equal(cursorIndexForId(alive, "task:A", 1, "P-1"), 1)
})

// ---- U2: подробности задачи ----------------------------------------------

test("parseNote различает три исхода, а не два", () => {
  // Перевод строки внутри значения приходит экранированным — так его шлёт API.
  assert.deepEqual(parseNote('[{"insert":"Оцинкованные, 4×40.\\n"}]'),
    { text: "Оцинкованные, 4×40.\n", state: "ok" })
  assert.deepEqual(parseNote('[{"insert":"строка один\\n"},{"insert":"строка два"}]'),
    { text: "строка один\nстрока два", state: "ok" })
  assert.deepEqual(parseNote(""), { text: "", state: "empty" })
  assert.deepEqual(parseNote("   "), { text: "", state: "empty" })
  assert.deepEqual(parseNote(undefined), { text: "", state: "empty" })
  assert.deepEqual(parseNote(null), { text: "", state: "empty" })
})

test("parseNote: непустая неразбираемая заметка возвращает исходный текст с признаком", () => {
  // Пустой текст здесь был бы уверенным неверным ответом: пользователь решил бы,
  // что заметки нет, тогда как её просто не прочитали.
  // Простой текст — не отказ разбора: так приходят 17 заметок из 192 в живом аккаунте.
  const plain = "Создать 30-Resources/dacha.md. Контекст: апрель–сентябрь на даче."
  assert.deepEqual(parseNote(plain), { text: plain, state: "ok" })
  // А вот это выглядит размеченным и не разбирается — тут пометка уместна.
  const broken = '[{"insert": "обрыв'
  assert.deepEqual(parseNote(broken), { text: broken, state: "unparsed" })
  assert.deepEqual(parseNote('{"insert":"объект вместо массива"}'),
    { text: '{"insert":"объект вместо массива"}', state: "unparsed" })
  // Заметка из одной картинки разбирается верно, но текста не даёт. Показ картинок
  // и разметки план исключает, поэтому для текстовой поверхности она пуста.
  assert.equal(parseNote('[{"image":"нет текстовых вставок"}]').state, "empty")
})

test("recurrenceState ловит и генератор, и порождённую задачу", () => {
  // Форма снята с живой задачи 04.09, а не угадана: у генератора recurrence —
  // объект при пустом recurrenceGeneratorId, у экземпляра ровно наоборот.
  const generator = { recurrence: { repeat: { everyday: { interval: 1 } } }, recurrenceGeneratorId: "" }
  const instance = { recurrence: null, recurrenceGeneratorId: "T-0d647151-dc56-4b3c-89ec-420263827572" }
  const plain = { recurrence: null, recurrenceGeneratorId: "" }
  assert.equal(recurrenceState(generator), "recurring")
  assert.equal(recurrenceState(instance), "recurring",
    "в окне дня видна именно порождённая задача — предикат по одному recurrence пропустил бы её")
  assert.equal(recurrenceState(plain), "none")
})

test("recurrenceState: отсутствие полей даёт «не знаю», а не «обычная»", () => {
  // Если форма поля изменится и оно перестанет доезжать, отказ обязан быть громким:
  // «обычная задача» здесь означало бы отправку complete и гашение серии.
  assert.equal(recurrenceState({ id: "T-1", title: "без полей повтора" }), "unknown")
  assert.equal(recurrenceState(null), "unknown")
  assert.equal(recurrenceState({ recurrence: null }), "none", "поле есть и пусто — это ответ")
})

test("taskFields показывает только заполненное и в постоянном порядке", () => {
  const full = { start: iso(2026, 8, 3), deadline: iso(2026, 8, 5), priority: 0,
                 recurrence: null, recurrenceGeneratorId: "" }
  assert.deepEqual(full.deadline && taskFields(full, now).map((f) => f.label),
    ["начало", "дедлайн", "приоритет"])
  const bare = { start: iso(2026, 8, 3), deadline: null, priority: 1,
                 recurrence: null, recurrenceGeneratorId: "" }
  assert.deepEqual(taskFields(bare, now).map((f) => f.label), ["начало"],
    "ни дедлайна, ни обычного приоритета в списке быть не должно")
  assert.deepEqual(taskFields(null, now), [])
})

test("taskFields называет повтор отдельной строкой", () => {
  const rec = { start: iso(2026, 8, 3), deadline: null, priority: 1,
                recurrence: null, recurrenceGeneratorId: "T-gen" }
  assert.deepEqual(rec && taskFields(rec, now).map((f) => f.label), ["начало", "повтор"])
})

test("taskWebUrl различает исходы и кодирует идентификатор", () => {
  const withProject = taskWebUrl({ id: "T-1", projectId: "P-1341d38e" })
  assert.equal(withProject.kind, "project")
  assert.ok(withProject.url.startsWith(WEB_BASE + "/#/project/"))
  assert.ok(withProject.url.startsWith("https://"), "наружу уходит только https")

  const noProject = taskWebUrl({ id: "T-2", projectId: null })
  assert.equal(noProject.kind, "app", "исход отличим: это не адрес задачи")
  assert.equal(taskWebUrl(null).url, WEB_BASE)

  const odd = taskWebUrl({ id: "T-3", projectId: "P /?#&" })
  assert.ok(!odd.url.includes(" "), "идентификатор процент-кодирован")
  assert.ok(!odd.url.slice(WEB_BASE.length + 1).includes("#/project/P /"), "пробел не доехал сырым")
})

test("parseNote: разобранная пустышка — это пустая заметка, а не испорченная", () => {
  // Живой случай: заметка из одного перевода строки. Разбирается верно и пуста;
  // пометка «не удалось прочитать» здесь была бы ложной тревогой.
  assert.deepEqual(parseNote('[{"insert":"\\n"}]'), { text: "", state: "empty" })
  assert.deepEqual(parseNote('[{"insert":"   "}]'), { text: "", state: "empty" })
})

// ---- U3: поверхность записи ----------------------------------------------

test("buildRequestCommand не несёт ни токена, ни содержимого", () => {
  // Главное защитное свойство: /proc/<pid>/cmdline читает всякий процесс в системе.
  const cmd = buildRequestCommand("https://api.singularity-app.com/v2/task")
  const joined = cmd.join(" ")
  assert.ok(!joined.includes("Bearer"), "заголовка авторизации в argv быть не должно")
  assert.ok(cmd.includes("-K") && cmd.includes("-"), "запрос читается из конфигурации на stdin")
  assert.deepEqual(cmd.filter((a) => a.startsWith("http")), ["https://api.singularity-app.com/v2/task"])
})

test("escapeCurlConfigValue закрывает инъекцию через кавычку", () => {
  assert.equal(escapeCurlConfigValue('с "кавычкой"'), 'с \\"кавычкой\\"')
  assert.equal(escapeCurlConfigValue("с \\ косой"), "с \\\\ косой")
  assert.equal(escapeCurlConfigValue('обе \\ и "'), 'обе \\\\ и \\"')
  // Сырой перевод строки создал бы в конфигурации вторую директиву — на том же
  // канале, которым едет токен. JSON.stringify его сюда не пропустит, но проволока стоит.
  assert.throws(() => escapeCurlConfigValue("две\nстроки"), /CR or LF/)
  assert.throws(() => escapeCurlConfigValue("возврат\rкаретки"), /CR or LF/)
})

test("buildCurlConfig: название с кавычкой не порождает лишней директивы", () => {
  const cfg = buildCurlConfig("TOK", "POST", { title: 'а "б" \\ в' })
  const lines = cfg.trimEnd().split("\n")
  assert.equal(lines.length, 4, "ровно четыре строки: токен, глагол, тип, тело")
  assert.ok(lines[0].startsWith('header = "Authorization: Bearer TOK"'))
  assert.equal(lines[1], 'request = "POST"')
  assert.ok(lines[3].startsWith('data = "'))
  // Тело внутри значения — валидный JSON после снятия экранирования конфигурации.
  const raw = lines[3].slice('data = "'.length, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  assert.deepEqual(JSON.parse(raw), { title: 'а "б" \\ в' })
})

test("buildCurlConfig: читающий запрос остаётся частным случаем без тела", () => {
  const cfg = buildCurlConfig("TOK", "GET", null)
  assert.equal(cfg.trimEnd().split("\n").length, 1, "только заголовок авторизации")
  assert.ok(!cfg.includes("Content-Type"))
})

test("buildCreateBody кладёт задачу во Входящие на сегодня", () => {
  const b = buildCreateBody("  купить саморезы  ", now)
  assert.equal(b.title, "купить саморезы", "название обрезано по краям")
  assert.match(b.start, /^2026-09-03T09:00:00[+-]\d\d:\d\d$/)
  assert.ok(!("projectId" in b), "Входящие — это отсутствие проекта, а не проект")
  assert.equal(buildCreateBody("", now), null)
  assert.equal(buildCreateBody("   ", now), null)
  assert.equal(buildCreateBody(null, now), null)
})

test("buildRenameBody несёт только название", () => {
  assert.deepEqual(buildRenameBody("  новое имя "), { title: "новое имя" })
  assert.equal(buildRenameBody("  "), null)
})

test("MUTATIONS кодирует идентификатор в пути", () => {
  assert.equal(MUTATIONS.complete("T-1").method, "POST")
  assert.ok(MUTATIONS.complete("T-1").path.endsWith("/T-1/complete"))
  assert.equal(MUTATIONS.rename("T-1").method, "PATCH")
  assert.equal(MUTATIONS.create().path, "/v2/task")
  assert.ok(!MUTATIONS.complete("T /?#").path.includes(" "), "идентификатор кодируется")
})

test("parseTask разбирает отклик мутации той же нормализацией, что и опрос", () => {
  const one = JSON.stringify({ ...task({ checked: 1 }), note: '[{"insert":"текст"}]',
                               recurrence: null, recurrenceGeneratorId: "" })
  const t = parseTask(one, now)
  assert.equal(t.id, "T-1")
  assert.equal(t.checked, 1)
  assert.equal(isCurrent(t, now), false, "завершённая выпадает из окна существующим предикатом")
  assert.throws(() => parseTask("{}", now), /no task/)
  assert.throws(() => parseTask("не JSON", now), /not JSON/)
})

test("parseTasks доносит note и recurrence до нормализованной задачи", () => {
  // Без этого поля пришли бы из API и молча пропали в normalizeTask: заметка пустая
  // у всех, защита от гашения серии выключена, тесты зелёные.
  const [t1] = parseTasks(body([{ ...task(), note: '[{"insert":"есть"}]',
    recurrence: null, recurrenceGeneratorId: "T-gen" }]), now)
  assert.equal(parseNote(t1.note).text, "есть")
  assert.equal(recurrenceState(t1), "recurring")

  const [t2] = parseTasks(body([{ ...task(), note: null,
    recurrence: null, recurrenceGeneratorId: "" }]), now)
  assert.equal(t2.note, "")
  assert.equal(recurrenceState(t2), "none")
})

test("нормализация не выдаёт «не знаю» за «обычную задачу»", () => {
  // Ответ без поля повтора вовсе — форма изменилась. Отказ обязан быть громким.
  const [t] = parseTasks(body([{ id: "T-9", title: "без поля", start: today, checked: 0 }]), now)
  assert.equal(recurrenceState(t), "unknown",
    "отсутствие поля должно доезжать до предиката, а не подменяться пустой строкой")
})

test("taskFields отдаёт дату сырой, а не отформатированной", () => {
  // Формат даты нельзя проверить здесь: движок QML и node расходятся в toLocaleDateString,
  // и тест бы зеленел на «4 сентября», пока на экране стоит «04.09.2026». Значит здесь
  // проверяется ровно то, что сюда относится, — что значение уехало наружу нетронутым.
  const task = { start: iso(2026, 8, 3), deadline: iso(2026, 8, 5), priority: 0,
                 recurrence: null, recurrenceGeneratorId: "" }
  const fields = taskFields(task, now)
  const start = fields.find((f) => f.label === "начало")
  assert.equal(start.kind, "date")
  assert.equal(start.value, task.start, "значение уехало нетронутым")
  assert.equal(fields.find((f) => f.label === "приоритет").kind, "text")
})
