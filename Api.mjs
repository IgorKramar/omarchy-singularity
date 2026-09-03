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
