// SingularityApp REST API helpers: query building, response parsing, cache merge.
// Pure ES module with no Qt inside — imported by Service.qml as
// `import "Api.mjs" as Api` and by `node --test` alike.

export const BASE_URL = "https://api.singularity-app.com"
// The spec bounds maxCount to 1..1000 and names no default; ask for the maximum.
export const MAX_COUNT = 1000
// Sparse field list. `removed` is not an allowed field, deletion shows as `deleteDate`.
export const TASK_FIELDS = ["id", "title", "projectId", "start", "deadline", "priority",
  "checked", "deferred", "deleteDate", "modificatedDate"]
// Overlap for modifiedSince: client and server clocks drift, merge is idempotent by id.
export const INCREMENTAL_OVERLAP_MS = 60_000

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

// No server-side "today" filters here: a task that left the window (checked, moved) must still
// arrive so merge() can drop it. The window is applied on the client in isCurrent().
export function incrementalQuery(since) {
  const from = new Date(new Date(since).getTime() - INCREMENTAL_OVERLAP_MS)
  return { modifiedSince: from.toISOString(), includeRemoved: true, maxCount: MAX_COUNT, fields: TASK_FIELDS.join(",") }
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
    removed: t.removed === true,
    modifiedAt: t.modificatedDate || null,
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
  if (task.checked !== 0 || task.removed || task.deleteDate || task.deferred) return false
  if (!task.start) return false
  return new Date(task.start).getTime() <= endOfDayDate(now).getTime()
}

// Replace by id, then keep only what still belongs to today. Used for full fetches (cache = [])
// and increments alike, so the window has exactly one owner.
// Returns the same `cache` reference when nothing changed, so a QML `var` property
// assignment does not fire a notify on every quiet poll.
export function merge(cache, incoming, now) {
  const byId = new Map(cache.map((t) => [t.id, t]))
  for (const t of incoming) byId.set(t.id, t)
  const next = [...byId.values()]
    .filter((t) => isCurrent(t, now))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.title.localeCompare(b.title)))
  return sameTasks(cache, next) ? cache : next
}

function sameTasks(a, b) {
  return a.length === b.length && a.every((t, i) => JSON.stringify(t) === JSON.stringify(b[i]))
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
export const NO_PROJECT = " no-project"
export const UNKNOWN_PROJECT = " unknown-project"

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
  return a.every((g, i) => g.key === b[i].key && g.hidden === b[i].hidden
    && g.count === b[i].count && g.tasks.every((t, j) => t === b[i].tasks[j]))
}

// `prev` is the previously published grouping; the result reuses it when nothing changed.
export function groupByProject(prev, tasks, projects) {
  const groups = buildGroups(tasks, projects, false)
  return sameGroups(prev, groups) ? prev : groups
}

// What the SNG-2 project filter dropped, as sections of its own. Derived from the set
// difference rather than from the exclusion setting, so the count is tasks — which is what
// R13 promises — and not names in shell.json.
export function hiddenGroups(prev, allTasks, tasks, projects) {
  const visible = new Set(tasks.map((t) => t.id))
  const dropped = allTasks.filter((t) => !visible.has(t.id))
  const groups = dropped.length === 0 ? [] : buildGroups(dropped, projects, true)
  const stable = sameGroups(prev, groups) ? prev : groups
  return { groups: stable, taskCount: dropped.length }
}

// A hidden section defaults to collapsed and a plain one to expanded, so the set the panel
// keeps holds only what the user actually toggled — one set, two defaults (R11, R12).
export function isCollapsed(group, toggled) {
  const has = (Array.isArray(toggled) ? toggled : []).indexOf(group.key) !== -1
  return group.hidden ? !has : has
}

function sameFlat(a, b) {
  return Array.isArray(a) && a.length === b.length
    && a.every((r, i) => r.id === b[i].id && r.task === b[i].task)
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
  const dropped = hiddenGroups(previous.hidden, allTasks, tasks, projects)
  let sections = groups
  if (dropped.groups.length > 0) {
    const merged = [...groups, ...dropped.groups].sort(compareGroups)
    sections = sameGroups(previous.sections, merged) ? previous.sections : merged
  }
  const flat = flattenGroups(previous.flat, sections, collapsed)
  return {
    tab,
    groups,
    hidden: dropped.groups,
    sections,
    flat,
    hiddenTaskCount: dropped.taskCount,
    count: sliced.length
  }
}
