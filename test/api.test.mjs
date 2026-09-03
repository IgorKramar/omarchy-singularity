import { test } from "node:test"
import assert from "node:assert/strict"
import {
  BASE_URL, MAX_COUNT, TASK_FIELDS,
  endOfDay, startOfDay, todayQuery, incrementalQuery, projectsQuery,
  buildUrl, parseTasks, parseProjects, merge, isCurrent
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
