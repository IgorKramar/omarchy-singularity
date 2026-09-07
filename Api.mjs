// SingularityApp REST API helpers: query building, response parsing, cache merge.
// Pure ES module with no Qt inside — imported by Service.qml as
// `import "Api.mjs" as Api` and by `node --test` alike.

export const BASE_URL = "https://api.singularity-app.com"
// The spec bounds maxCount to 1..1000 and names no default; ask for the maximum.
export const MAX_COUNT = 1000
// Sparse field list. Deletion is not in here because the API offers no way to see it:
// `removed` is rejected as a field (HTTP 400), and a deleted task still answers with
// `deleteDate: null` — measured against the live API, 2026-09-07. A deleted task is
// recognised by one thing only: the window query stops returning it. That is why the poll
// asks for the whole window every time instead of a delta (SNG-7).
export const TASK_FIELDS = ["id", "title", "projectId", "start", "deadline", "priority",
  "checked", "deferred", "deleteDate", "modificatedDate", "note", "recurrence",
  "recurrenceGeneratorId"]
const pad = (n) => String(n).padStart(2, "0")

export function localOffset(date) {
  const minutes = -date.getTimezoneOffset()
  const abs = Math.abs(minutes)
  return (minutes >= 0 ? "+" : "-") + pad(Math.floor(abs / 60)) + ":" + pad(abs % 60)
}

export function startOfDay(now) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d
}

export function endOfDayDate(now) {
  const d = new Date(now)
  d.setHours(23, 59, 59, 999)
  return d
}

// ISO date-time of the local end of day, with the local offset; the API normalises offsets to UTC.
export function endOfDay(now) {
  const d = endOfDayDate(now)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T23:59:59${localOffset(d)}`
}

export function todayQuery(now) {
  return { "checked.eq": 0, "start.lte": endOfDay(now), maxCount: MAX_COUNT, fields: TASK_FIELDS.join(",") }
}

export function projectsQuery() {
  return { fields: "id,title", maxCount: MAX_COUNT }
}

export function buildUrl(path, params, base = BASE_URL) {
  const query = Object.entries(params)
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(String(v)))
    .join("&")
  return base + path + (query ? "?" + query : "")
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error("response is not JSON: " + e.message)
  }
}

// A task is overdue when its start is before the local start of today. Shared by
// normalizeTask (which freezes it at parse time) and countWindow (which recomputes it),
// so the two never drift apart.
export function isOverdue(task, now) {
  const start = task && task.start
  return !!start && new Date(start).getTime() < startOfDay(now).getTime()
}

function normalizeTask(t, now) {
  const start = t.start || null
  return {
    id: String(t.id),
    title: String(t.title || ""),
    projectId: t.projectId || null,
    start,
    deadline: t.deadline || null,
    priority: typeof t.priority === "number" ? t.priority : 1,
    checked: typeof t.checked === "number" ? t.checked : 0,
    deferred: t.deferred === true,
    deleteDate: t.deleteDate || null,
    modifiedAt: t.modificatedDate || null,
    // Both fields are carried explicitly, and both must be. normalizeTask builds a fresh
    // object from named keys and drops everything else, so adding a field to TASK_FIELDS
    // alone fetches it and then throws it away — an empty note on every task, and a
    // recurrence guard that never fires, with every test still green.
    //
    // `recurrenceGeneratorId` keeps `undefined` when absent rather than collapsing to a
    // default: recurrenceState reads the field's *presence* to tell "not recurring" from
    // "the shape we were told about is gone", and a default would erase that difference.
    note: typeof t.note === "string" ? t.note : "",
    recurrence: "recurrence" in t ? (t.recurrence || null) : undefined,
    recurrenceGeneratorId: t.recurrenceGeneratorId,
    overdue: isOverdue({ start }, now)
  }
}

export function parseTasks(text, now) {
  const data = parseJson(text)
  if (!data || !Array.isArray(data.tasks)) throw new Error("response has no tasks array")
  return data.tasks.map((t) => normalizeTask(t, now))
}

export function parseProjects(text) {
  const data = parseJson(text)
  if (!data || !Array.isArray(data.projects)) throw new Error("response has no projects array")
  return data.projects.map((p) => ({ id: String(p.id), title: String(p.title || "") }))
}

// The "today" predicate: unchecked, alive, not deferred, planned no later than the local end of day.
export function isCurrent(task, now) {
  if (task.checked !== 0 || task.deleteDate || task.deferred) return false
  if (!task.start) return false
  return new Date(task.start).getTime() <= endOfDayDate(now).getTime()
}

const byStartThenTitle = (a, b) =>
  a.start < b.start ? -1 : a.start > b.start ? 1 : a.title.localeCompare(b.title)

// Merges one answer into the cache by id. Used by the write path, where the response is a
// single task and the rest of the window must survive. The poll uses mergeFull instead.
export function merge(cache, incoming, now) {
  const byId = new Map(cache.map((t) => [t.id, t]))
  for (const t of incoming) byId.set(t.id, t)
  const next = [...byId.values()].filter((t) => isCurrent(t, now)).sort(byStartThenTitle)
  return sameTasks(cache, next) ? cache : next
}

// What a full window fetch does with its answer. The set is built from `incoming` alone —
// the cache does not contribute, which is exactly how a task deleted elsewhere leaves: it
// simply is not in the answer any more.
//
// `prev` is here for one reason: to return *the same reference* when nothing changed. Its
// absence is what the first draft of SNG-7 missed — calling `merge([], incoming)` would have
// compared the new set against an empty literal, never matched, and rebuilt the popup every
// ten minutes with a quiet-gate check in the code that could not fire.
export function mergeFull(prev, incoming, now) {
  const next = incoming.filter((t) => isCurrent(t, now)).sort(byStartThenTitle)
  return sameTasks(prev, next) ? prev : next
}

function sameTasks(a, b) {
  // Reference first: an entry no poll touched keeps its identity through merge's Map, and
  // that is the common case. Serialising it anyway grew costlier once tasks began carrying
  // their note — several hundred characters re-encoded per task per poll to prove what the
  // identity check proves for free.
  return a.length === b.length
    && a.every((t, i) => t === b[i] || JSON.stringify(t) === JSON.stringify(b[i]))
}

// --- Project filter and counters (SNG-2) ---

// The setting is written by hand in shell.json, so accept both an array and a
// comma-separated string. Comparison is trimmed and case-insensitive.
export function normalizeExcluded(value) {
  const items = Array.isArray(value) ? value
    : typeof value === "string" ? value.split(",")
    : []
  // Only strings: shell.json is hand-edited, and String(null) would otherwise become
  // the key "null" and exclude a project actually named that.
  return new Set(items
    .filter((s) => typeof s === "string")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== ""))
}

// Tasks carry only projectId, so names are resolved through the projects cache. An empty
// cache therefore means "no filtering possible" — the caller must treat that as not-applied
// rather than as a clean result. A task without a project is never excluded (R6).
// Matching by name excludes every project sharing that name; it does not descend into
// subprojects (KTD2). Returns the same array reference when nothing is dropped, so the
// service's quiet gate does not fire on an unchanged set.
export function applyProjectFilter(tasks, projects, excluded) {
  const names = normalizeExcluded(excluded)
  if (names.size === 0) return tasks
  const excludedIds = new Set(
    projects.filter((p) => names.has(String(p.title || "").trim().toLowerCase())).map((p) => String(p.id))
  )
  if (excludedIds.size === 0) return tasks
  const next = tasks.filter((t) => !t.projectId || !excludedIds.has(String(t.projectId)))
  return next.length === tasks.length ? tasks : next
}

// Recomputes overdue from start and now instead of reading the flag frozen at parse time:
// after midnight the frozen split is a day stale until the next full poll.
export function countWindow(tasks, now) {
  let overdue = 0
  for (const t of tasks) if (isOverdue(t, now)) overdue += 1
  return { total: tasks.length, overdue }
}

// Element identity, not deep equality: both arrays hold the very objects merge() put in the
// cache, and a quiet merge hands that same cache back untouched.
function sameOrder(a, b) {
  return a.length === b.length && a.every((t, i) => t === b[i])
}

// The whole visible view in one pure, testable place. Equality must NOT be decided by the
// caller: applyProjectFilter allocates a fresh array whenever it actually drops something,
// so an identity check on the caller's side would report a change on every poll and defeat
// the quiet gate — precisely for the users who configured a filter. `prev` is the previously
// published view; the result reuses that reference when the content is unchanged.
export function computeView(prev, allTasks, projects, excluded, now) {
  const names = normalizeExcluded(excluded)
  // Tasks carry only projectId, so resolving a name needs the projects cache. An empty cache
  // with a non-empty list is "not applied", not a clean result.
  const applied = names.size === 0 || projects.length > 0
  let tasks = applied ? applyProjectFilter(allTasks, projects, excluded) : allTasks
  if (tasks !== prev && sameOrder(prev, tasks)) tasks = prev
  const { total, overdue } = countWindow(tasks, now)
  return { tasks, total, overdue, applied, excludedCount: names.size }
}

// The effective list, type-stable whether the setting arrived as an array or a comma string,
// so IPC consumers see one shape instead of whatever the last writer happened to use.
export function excludedList(value) {
  return [...normalizeExcluded(value)]
}

// --- Popup view (SNG-3) ---
//
// Everything that decides what the popup shows lives here rather than in QML, for the
// reason KD8 spells out: the test runner does not reach QML, and each of these steps
// sometimes builds a fresh array — the same shape of defect that survived twenty-two green
// tests in SNG-2. QML is left with one assignment and scalar comparisons.

export const POPUP_TABS = ["today", "all", "overdue"]

// Two distinct buckets, never merged: "no project" is a property of the task, "unknown
// project" is a gap in our projects cache (R10). Collapsing them would hide the gap.
//
// The leading NUL is the collision guarantee, stated rather than left implicit: a project id
// from the API cannot contain one, so these keys can never be mistaken for a real project.
// Written as an escape, not as a raw byte — a literal NUL in the source makes grep treat the
// whole file as binary and print nothing, which reads as "no match" rather than "cannot read".
export const NO_PROJECT = "\u0000no-project"
export const UNKNOWN_PROJECT = "\u0000unknown-project"

const GROUP_TITLES = { [NO_PROJECT]: "Без проекта", [UNKNOWN_PROJECT]: "Неизвестный проект" }

// Overdue is recomputed from `now`, never read off the flag frozen at parse time — the same
// rule countWindow follows, so the tab split and the pill's number cannot drift apart (R5).
// Returns the input array when the slice drops nothing.
export function sliceByTab(tasks, tab, now) {
  if (tab === "all") return tasks
  const wantOverdue = tab === "overdue"
  const next = tasks.filter((t) => isOverdue(t, now) === wantOverdue)
  return next.length === tasks.length ? tasks : next
}

// The two fallback buckets sort last, in a fixed order, so they never land in the middle
// of the real projects.
function compareGroups(a, b) {
  const rank = (g) => (g.key === NO_PROJECT ? 1 : g.key === UNKNOWN_PROJECT ? 2 : 0)
  return rank(a) - rank(b) || a.title.localeCompare(b.title)
}

function buildGroups(tasks, projects, hidden) {
  const titles = new Map(projects.map((p) => [String(p.id), String(p.title || "")]))
  const byKey = new Map()
  for (const t of tasks) {
    const pid = t.projectId ? String(t.projectId) : ""
    const key = pid === "" ? NO_PROJECT : titles.has(pid) ? pid : UNKNOWN_PROJECT
    let group = byKey.get(key)
    if (!group) {
      group = {
        key,
        title: GROUP_TITLES[key] || titles.get(pid),
        kind: key === NO_PROJECT ? "none" : key === UNKNOWN_PROJECT ? "unknown" : "project",
        hidden,
        tasks: [],
        count: 0
      }
      byKey.set(key, group)
    }
    group.tasks.push(t)
  }
  const groups = [...byKey.values()]
  for (const g of groups) g.count = g.tasks.length
  return groups.sort(compareGroups)
}

// Element identity for the tasks, since both arrays hold the objects merge() put in the
// cache; a quiet poll hands the same objects back and must not read as a change.
function sameGroups(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false
  // `title` belongs in here: it is what the header draws, and a project renamed in the web
  // app changes nothing else — same key, same tasks, same count. Without it the gate says
  // "nothing moved" and the popup keeps the old name until some unrelated edit shakes it
  // loose. The task-array length is compared outright rather than left to the `count`
  // invariant, so the two cannot drift apart later.
  return a.every((g, i) => g.key === b[i].key && g.title === b[i].title
    && g.hidden === b[i].hidden && g.count === b[i].count
    && g.tasks.length === b[i].tasks.length
    && g.tasks.every((t, j) => t === b[i].tasks[j]))
}

// `prev` is the previously published grouping; the result reuses it when nothing changed.
export function groupByProject(prev, tasks, projects) {
  const groups = buildGroups(tasks, projects, false)
  return sameGroups(prev, groups) ? prev : groups
}

// What the SNG-2 project filter dropped, as sections of its own. Derived from the set
// difference rather than from the exclusion setting, so the count is tasks — which is what
// R13 promises — and not names in shell.json.
export function hiddenGroups(prev, allTasks, tasks, projects, tab, now) {
  const visible = new Set(tasks.map((t) => t.id))
  const dropped = allTasks.filter((t) => !visible.has(t.id))
  // Two different windows on purpose: the footer's number counts the whole window, because
  // that is what R13 promises, while the sections themselves follow the active tab like
  // every other section does (R6). Slicing only the grouping input keeps both true.
  const forTab = sliceByTab(dropped, tab, now)
  const groups = forTab.length === 0 ? [] : buildGroups(forTab, projects, true)
  const stable = sameGroups(prev, groups) ? prev : groups
  return { groups: stable, taskCount: dropped.length }
}

// A hidden section defaults to collapsed and a plain one to expanded, so the set the panel
// keeps holds only what the user actually toggled — one set, two defaults (R11, R12).
//
// The stored key carries the default it was written against. A bare project key read with
// two opposite polarities silently inverts the section when the project crosses into or out
// of the filter: expand the grey "Дни рождения", drop it from the exclusion list, and the
// same stored key now reads as "collapsed". Prefixing pins the entry to the default it was
// a departure from, so a section whose `hidden` flips falls back to its own default.
export function toggleKey(group) {
  return (group.hidden ? "h:" : "p:") + group.key
}

export function isCollapsed(group, toggled) {
  const has = (Array.isArray(toggled) ? toggled : []).includes(toggleKey(group))
  return group.hidden ? !has : has
}

// `group` belongs in here, and by reference. A row carries the section object an
// action later reads `hidden` off; comparing the section *key* would change nothing,
// because a header row already embeds its key in `id`. Without the object itself in
// the comparison the gate can hand back a row pointing at a section the rebuild
// evicted — harmless while Enter only folds, wrong the moment it edits a task.
function sameFlat(a, b) {
  return Array.isArray(a) && a.length === b.length
    && a.every((r, i) => r.id === b[i].id && r.task === b[i].task && r.group === b[i].group)
}

// The sequence the keyboard walks, in drawing order: a header, then its rows unless the
// section is collapsed. Rows carry their section key so the cursor can fall back within
// the same section when its anchor task disappears.
export function flattenGroups(prev, groups, toggled) {
  const flat = []
  for (const g of groups) {
    flat.push({ kind: "header", id: "header:" + g.key, key: g.key, group: g, task: null })
    if (isCollapsed(g, toggled)) continue
    for (const t of g.tasks)
      flat.push({ kind: "task", id: "task:" + t.id, key: g.key, group: g, task: t })
  }
  return sameFlat(prev, flat) ? prev : flat
}

export function moveCursor(index, delta, length) {
  if (length <= 0) return -1
  if (index < 0) return delta > 0 ? 0 : length - 1
  const next = (index + delta) % length
  return next < 0 ? next + length : next
}

// R22: the selection belongs to a task, not to a row number. When the anchor is gone the
// fallback walks its own section first — next row, then previous row, then the section
// header — because clamping the old index alone would land on a neighbouring section's
// header whenever the last row of a section disappeared.
export function cursorIndexForId(list, id, fallbackIndex, sectionKey) {
  const items = Array.isArray(list) ? list : []
  if (items.length === 0) return -1
  if (id) {
    for (let i = 0; i < items.length; i++) if (items[i].id === id) return i
  }
  if (sectionKey !== undefined && sectionKey !== null && fallbackIndex >= 0) {
    const from = Math.min(fallbackIndex, items.length - 1)
    for (let i = from; i < items.length; i++)
      if (items[i].key === sectionKey && items[i].kind === "task") return i
    for (let i = from - 1; i >= 0; i--)
      if (items[i].key === sectionKey && items[i].kind === "task") return i
    for (let i = 0; i < items.length; i++) if (items[i].key === sectionKey) return i
    // Nothing of the anchor's section survived. Clamping to the old index would put
    // the cursor on another project's row — a header or a task, both equally wrong —
    // and the next keystroke would act on it. No cursor is the honest answer.
    return -1
  }
  if (fallbackIndex === undefined || fallbackIndex < 0) return -1
  return Math.max(0, Math.min(items.length - 1, fallbackIndex))
}

// The one entry point QML calls. It holds the three previous references inside the object
// it returns, so the panel keeps a single property and a single assignment instead of
// threading three caches through QML — which is where a wrong `prev` would go unnoticed.
export function popupView(prev, args) {
  const { allTasks, tasks, projects, tab, collapsed, now } = args
  const previous = prev || {}
  const sliced = sliceByTab(tasks, tab, now)
  const groups = groupByProject(previous.groups, sliced, projects)
  const dropped = hiddenGroups(previous.hidden, allTasks, tasks, projects, tab, now)
  let sections = groups
  if (dropped.groups.length > 0) {
    const merged = [...groups, ...dropped.groups].sort(compareGroups)
    sections = sameGroups(previous.sections, merged) ? previous.sections : merged
  }
  const flat = flattenGroups(previous.flat, sections, collapsed)
  // Hand back the very same object when nothing moved, so QML's onViewChanged fires on a
  // real change and not on every poll. The day is part of that comparison: an unchanged
  // task set still changes which rows are overdue once midnight passes, and returning a
  // stale `now` would freeze the marks until the next edit.
  if (prev && prev.tab === tab && prev.groups === groups && prev.hidden === dropped.groups
      && prev.sections === sections && prev.flat === flat
      && prev.hiddenTaskCount === dropped.taskCount && prev.count === sliced.length
      && startOfDay(prev.now).getTime() === startOfDay(now).getTime()) return prev
  return {
    tab,
    // The `now` the slice used, so a row's overdue mark and its tab agree by construction
    // rather than by two independent clock reads either side of midnight (R5).
    now,
    groups,
    hidden: dropped.groups,
    sections,
    flat,
    hiddenTaskCount: dropped.taskCount,
    count: sliced.length
  }
}

// --- Popup states (SNG-3) ---

// The service stores whatever curl wrote to stderr, or the exception it caught. R23 keeps
// that out of the interface: the popup names the class and supplies its own wording. The
// classification lives here rather than in QML because getting it wrong is silent — the
// user sees a plausible sentence about the wrong thing.
export function errorClass(errorText) {
  const text = String(errorText || "").toLowerCase()
  if (text === "") return "none"
  if (/\b40[13]\b|unauthorized|forbidden/.test(text)) return "auth"
  if (/could not resolve|connection refused|connection timed out|timed out|timeout|network is unreachable|\(6\)|\(7\)|\(28\)/.test(text))
    return "network"
  if (/not json|no tasks array|no projects array|unexpected token/.test(text)) return "response"
  return "unknown"
}

// Names in the exclusion setting that match no project in the cache (R14). Silent when
// unnamed: a typo in shell.json otherwise looks exactly like a filter that works.
export function unmatchedExcluded(projects, excluded) {
  const names = normalizeExcluded(excluded)
  if (names.size === 0) return []
  const known = new Set(projects.map((p) => String(p.title || "").trim().toLowerCase()))
  return [...names].filter((n) => !known.has(n))
}

// Why the list is empty — and emptiness has several causes that must not wear each other's
// words. In particular "all clear" and "hidden by the filter" are opposite facts (R26), so
// the choice between them is decided here once instead of by a chain of conditions in QML.
// `windowCount` is the full window before the filter; `tabCount` is what the tab shows.
export function emptyReason(status, windowCount, hiddenTaskCount, tabCount) {
  if (tabCount > 0) return ""
  if (status === "no-token") return "no-token"
  if (status === "error") return "error"
  if (status === "loading" && windowCount === 0) return "loading"
  if (windowCount === 0) return "all-clear"
  if (hiddenTaskCount >= windowCount) return "all-hidden"
  return "tab-empty"
}

// --- Decisions moved out of QML (SNG-3 review) ---
//
// Each of these lived in a QML property binding, where the test runner cannot reach it —
// the boundary AGENTS.md draws. None of them is complicated; all three are the shape whose
// error is silent, which is exactly the criterion.

export const FRESHNESS_MS = 60 * 1000

// Below the threshold the cache is fresh enough to show as-is; above it, opening the popup
// is a reason to poll. An absent or unparseable timestamp counts as stale: nothing has come
// back yet, or what came back cannot be trusted to say when.
export function isStale(lastSync, now, thresholdMs = FRESHNESS_MS) {
  const last = lastSync ? new Date(lastSync).getTime() : 0
  if (!Number.isFinite(last)) return true
  return now.getTime() - last >= thresholdMs
}

// 0 = HIGH, 1 = NORMAL, 2 = LOW — the API's own scale, and it runs the opposite way round
// from the guess, which is why it is pinned by a test rather than by a reader's memory.
// Only the two ends are marked; normal is the silent default.
//
// One table, two spellings: the row has no width for a whole word, the expansion has no
// reason to abbreviate. A second table would be a second place to fix if the scale ever
// turns out wrong — and this is precisely the fact that was already guessed wrong once.
const PRIORITY = { 0: { short: "выс", full: "высокий" }, 2: { short: "низ", full: "низкий" } }

export function priorityLabel(priority) {
  return PRIORITY[priority] ? PRIORITY[priority].short : ""
}

export function isHighPriority(priority) {
  return priority === 0
}

// Which of the two mutually exclusive filter lines the footer carries. They must never
// appear together: "the filter has not been applied" and "N tasks are hidden by it" are
// contradictory claims about the same moment.
//
// `unmatched` is only meaningful once the projects cache has arrived. While it is empty
// every configured name is trivially unmatched, so naming them there tells the user their
// settings are wrong when they are not — and does it in the same breath as saying the
// filter has not run yet.
export function footerState(filterApplied, excludedCount, hiddenTaskCount, projects, excluded) {
  if (!filterApplied) return { kind: "not-applied", hiddenTaskCount: 0, unmatched: [] }
  if (excludedCount > 0)
    return { kind: "hidden", hiddenTaskCount, unmatched: unmatchedExcluded(projects, excluded) }
  return { kind: "none", hiddenTaskCount: 0, unmatched: [] }
}

// --- Task detail (SNG-3.1) ---

export const WEB_BASE = "https://web.singularity-app.com"

// The note arrives as a string holding an array of insert operations. Three outcomes,
// deliberately distinct: nothing to read, read it, and could-not-read. Returning empty
// text for the third would make an unreadable note look exactly like a task that has
// none — a confident wrong answer instead of a visible failure.
export function parseNote(value) {
  if (typeof value !== "string" || value.trim() === "") return { text: "", state: "empty" }
  // The field is a union of two shapes, established by running this over all 192 tasks
  // in the account: 131 arrive as the marked-up array, 17 as plain text. Plain text is a
  // perfectly readable note, not a parse failure — labelling it "unparsed" would put a
  // could-not-read mark on notes that read fine. Only a value that *looks* like the
  // marked-up shape and then fails is genuinely unreadable.
  const trimmed = value.trim()
  if (trimmed[0] !== "[" && trimmed[0] !== "{") return { text: value, state: "ok" }
  let ops
  try {
    ops = JSON.parse(value)
  } catch (e) {
    return { text: value, state: "unparsed" }
  }
  if (!Array.isArray(ops)) return { text: value, state: "unparsed" }
  const text = ops.map((o) => (o && typeof o.insert === "string" ? o.insert : "")).join("")
  // Parsed fine and yields no text — an empty note, not an unreadable one. Marking it
  // unreadable would warn about a note the user simply never filled in. A note holding
  // only non-text operations lands here too: this surface renders text, and showing
  // pictures or formatting is out of scope by decision, so there is nothing to display.
  if (text.trim() === "") return { text: "", state: "empty" }
  return { text, state: "ok" }
}

// Only fields that carry a value. 29 of the API's 39 are empty on every task in this
// account, so rendering them all would be a screen of blank rows. The project is the
// section header already and is not repeated here.
export function taskFields(task) {
  if (!task) return []
  const out = []
  // Dates leave here as their raw value with `kind: "date"`, not as formatted text: the
  // QML engine's toLocaleDateString ignores the Intl options Node honours, so formatting
  // here prints "04.09.2026" on screen while the test reads "4 сентября" and passes. The
  // caller formats through Qt.locale, the way the row already formats its deadline.
  if (task.start) out.push({ label: "начало", value: task.start, kind: "date" })
  if (task.deadline) out.push({ label: "дедлайн", value: task.deadline, kind: "date" })
  const p = PRIORITY[task.priority]
  if (p) out.push({ label: "приоритет", value: p.full, kind: "text" })
  if (recurrenceState(task) === "recurring") out.push({ label: "повтор", value: "да", kind: "text" })
  return out
}

// A recurring task is two objects, not one — established against live data, not guessed.
// The generator carries `recurrence` as an object with an empty `recurrenceGeneratorId`;
// each generated instance carries the reverse. Only the instance lands in the day's
// window, so a predicate that checked `recurrence` alone would pass every task the user
// can actually click — failing silently, in the dangerous direction.
//
// "unknown" is not a shrug: when neither field is present in the parsed task the shape
// we were told about is gone, and the caller must decline rather than assume "ordinary".
export function recurrenceState(task) {
  if (!task) return "unknown"
  // `in` is the wrong test here: normalizeTask writes both keys unconditionally, so an
  // absent field arrives as a present key holding `undefined`. Absence is the value, not
  // the key — the same distinction this function exists to preserve.
  const hasRule = task.recurrence !== undefined
  const hasLink = task.recurrenceGeneratorId !== undefined
  if (!hasRule && !hasLink) return "unknown"
  if (task.recurrence && typeof task.recurrence === "object") return "recurring"
  if (typeof task.recurrenceGeneratorId === "string" && task.recurrenceGeneratorId !== "")
    return "recurring"
  return "none"
}

// The web app routes by hash. A per-task route was not established, so the honest
// fallback is the task's project — and the caller is told which it got, because "opened
// the project" and "opened the task" must not be indistinguishable to a verifier.
export function taskWebUrl(task) {
  if (!task) return { url: WEB_BASE, kind: "app" }
  if (task.projectId)
    return { url: WEB_BASE + "/#/project/" + encodeURIComponent(String(task.projectId)), kind: "project" }
  return { url: WEB_BASE, kind: "app" }
}

// --- Write surface (SNG-3.1) ---

// Every mutation the popup can issue. The verb and path live here so QML names an
// operation, never a URL and never an HTTP method.
export const MUTATIONS = {
  complete: (id) => ({ method: "POST", path: "/v2/task/" + encodeURIComponent(id) + "/complete" }),
  // The way back. A completed task leaves the window immediately and the next poll is up
  // to ten minutes away, so without this a mis-aimed keystroke is unrecoverable from the
  // popup — which is exactly how it was found.
  uncomplete: (id) => ({ method: "POST", path: "/v2/task/" + encodeURIComponent(id) + "/uncomplete" }),
  rename: (id) => ({ method: "PATCH", path: "/v2/task/" + encodeURIComponent(id) }),
  create: () => ({ method: "POST", path: "/v2/task" })
}

// curl reads its whole request from a config on stdin, so nothing — not the token, not
// the title the user typed — reaches `argv`, where `/proc/<pid>/cmdline` would expose it
// to every process on the machine.
//
// A config value is double-quoted, so the value must escape `\` and `"`; an unescaped
// quote ends the value and the rest of the line becomes curl options on the same channel
// that carries the token. `applySettings` already rejects a token containing `["\r\n]`
// for exactly this reason — but a task title is user content, so it gets escaped rather
// than rejected. Raw CR/LF cannot survive `JSON.stringify`, which encodes them as the
// two-character `\n`; the guard below is a tripwire for a caller that hand-built a body.
export function escapeCurlConfigValue(value) {
  const s = String(value)
  if (/[\r\n]/.test(s)) throw new Error("curl config value must not contain CR or LF")
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

export function buildCurlConfig(token, method, body) {
  const lines = ['header = "Authorization: Bearer ' + escapeCurlConfigValue(token) + '"']
  if (method && method !== "GET") lines.push('request = "' + escapeCurlConfigValue(method) + '"')
  if (body !== undefined && body !== null) {
    lines.push('header = "Content-Type: application/json"')
    lines.push('data = "' + escapeCurlConfigValue(JSON.stringify(body)) + '"')
  }
  return lines.join("\n") + "\n"
}

// The command carries only flags and the URL. Kept pure so the "no secret in argv"
// property is pinned by a test instead of by one look at a process that lives 550 ms.
export function buildRequestCommand(url) {
  return ["curl", "-fsS", "--max-time", "15", "-K", "-", url]
}

// A task created from the popup lands in Входящие — which in SingularityApp is the
// absence of a project, not a project of that name (verified: none of the 33 projects
// carries it). Sending no `projectId` is therefore the whole of it.
const cleanTitle = (v) => String(v == null ? "" : v).trim()

export function buildCreateBody(title, now) {
  const clean = cleanTitle(title)
  if (clean === "") return null
  // Morning of the local day, written the way endOfDay writes its own timestamp: the API
  // normalises the offset to UTC, so the offset must be the local one, not a hardcoded Z.
  const d = startOfDay(now)
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00:00${localOffset(d)}`
  return { title: clean, start: stamp }
}

export function buildRenameBody(title) {
  const clean = cleanTitle(title)
  if (clean === "") return null
  return { title: clean }
}

// A mutation answers with the task itself, so the response goes through the same
// normalisation as a poll — but `parseTasks` wants an array. One task, one entry point.
export function parseTask(text, now) {
  const data = parseJson(text)
  if (!data || typeof data !== "object" || !data.id) throw new Error("response has no task")
  return normalizeTask(data, now)
}

// --- Decisions the popup used to make in QML (SNG-3.1 review) ---
//
// Everything below decided something inside Panel.qml or Service.qml, where `node --test`
// cannot reach it. Each one fails silently when wrong — a command that does nothing, a
// series quietly extinguished, a completed task walking back into the window — which is
// exactly the boundary AGENTS.md draws: if the error is silent, the decision lives here.

// Physical key position, not letter identity. The tasks in this popup are Russian, so the
// layout is Russian while reading them, and a command bound to the Latin letter alone goes
// silent precisely when it is wanted (caught live: `n` typed a «п» into the field). Both
// cases, because Shift and CapsLock are not a different intent.
const ACTION_KEYS = {
  e: "rename", E: "rename", у: "rename", У: "rename",
  n: "add", N: "add", т: "add", Т: "add",
  o: "web", O: "web", щ: "web", Щ: "web",
  u: "undo", U: "undo", г: "undo", Г: "undo"
}

export function resolveActionKey(text) {
  return ACTION_KEYS[text] || ""
}

// May this write be sent at all? Asked at the service boundary rather than in the panel,
// because the panel is not the only caller: the IPC handler reaches the same POST, and a
// guard that lives in one caller is not a guard.
//
// A recurring task is two objects — a generator and the instances it produces — and
// completing an instance is not something this API offers. A task that is not in the cache
// resolves to "unknown" and is refused by construction: declining costs a keystroke,
// guessing costs a series.
export function mutationAllowed(op, task) {
  if (op !== "complete") return true
  return recurrenceState(task) === "none"
}

// A poll started now would race a write already in flight. `merge` is last-writer-wins by
// id with no modified-time comparison, so a poll that began before the checkbox and lands
// after its response puts the pre-completion task straight back in the window.
export function shouldDeferPoll(queueLength, mutatingId) {
  return queueLength > 0 || mutatingId !== ""
}

// This response left the server before the last write landed, so it describes a world
// where that write had not happened. Strictly older, not older-or-equal: a response that
// started in the same millisecond as the mutation finished is not evidence of a stale
// world, and discarding it would cost a round trip for nothing.
export function isStalePollResponse(startedAt, lastMutationAt) {
  return startedAt < lastMutationAt
}

// What body an operation sends, and whether it may be sent at all — one answer instead of
// the same three-way branch written twice in Service.qml (once to validate at queue time,
// once to build at send time). Those two copies could disagree, and the disagreement would
// show up as a request answered "ok" that was never sent.
//
// `complete` has no body and is still valid; a blank title is invalid and has none. Those
// are different facts, so they do not share the `null` return that once carried both.
export function mutationBody(op, title, now) {
  if (op === "complete" || op === "uncomplete") return { ok: true, body: null }
  const body = op === "create" ? buildCreateBody(title, now)
    : op === "rename" ? buildRenameBody(title) : undefined
  if (body === undefined) throw new Error("unknown mutation: " + op)
  return body === null ? { ok: false, body: null } : { ok: true, body: body }
}

// A write answers with the whole task — but not quite the whole one. Measured against the
// live API: the response carries `recurrenceGeneratorId` and omits `recurrence` entirely.
// For an instance of a series that is harmless (the link field still says "recurring"),
// but a generator carries the rule and an *empty* link, so a renamed generator would come
// back looking like an ordinary task, grow a live checkbox, and one click would put out
// the series. Carry the rule across rather than trust a field that did not travel.
export function carryRecurrence(prev, next) {
  if (!prev || !next) return next
  if (next.recurrence !== undefined || prev.recurrence === undefined) return next
  const out = Object.assign({}, next)
  out.recurrence = prev.recurrence
  return out
}
