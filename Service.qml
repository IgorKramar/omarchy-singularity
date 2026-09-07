import QtQuick
import Quickshell
import Quickshell.Io
import "Api.mjs" as Api

// Headless owner of everything SingularityApp: the token, polling, the cache.
// Bar widget and overlay only read `tasks`, `projects`, `status` and listen to
// `changed()`; none of them talks to the API themselves.
Item {
  id: root

  property var shell: null
  property var manifest: null

  readonly property string pluginId: "io.github.igorkramar.singularity"
  readonly property string stateDir: Quickshell.env("HOME") + "/.local/state/omarchy/" + pluginId
  readonly property string settingsPath: stateDir + "/settings.json"
  readonly property int pollIntervalMs: 10 * 60 * 1000

  // "no-token" | "loading" | "ready" | "error"  (not `state`: Item.state is taken)
  property string status: "no-token"
  property string errorText: ""
  // The full window as the API sees it. Merging and the quiet gate work on this, never on
  // `tasks`: merging onto the filtered view would drop excluded tasks out of the cache for
  // good, and clearing the filter would not bring them back until the next poll.
  // Two windows, on purpose. `cachedTasks` is every unfinished task — the overlay's subject
  // matter, 188 of which carry no date at all. `allTasks` is the narrow "up to the end of
  // today" window carved out of it, and it is what every older surface reads: the pill's
  // number, the popup, the IPC payload. Widening the fetch without this split would have
  // told the popup that 188 tasks were hidden by the project filter (SNG-4, R10).
  property var cachedTasks: []
  property var allTasks: []
  // The filtered view every surface reads — the filter applies plugin-wide by construction.
  property var tasks: []
  property var projects: []
  // Set by the bar widget from its own settings; accepts an array or a comma-separated string.
  property var excludedProjects: []
  property int visibleCount: 0
  property int overdueCount: 0
  // False while an exclusion list is set but the projects cache is still empty: names cannot
  // be resolved yet, so the count is the unfiltered one and must not be passed off as filtered.
  property bool filterApplied: true
  property int excludedCount: 0
  property string lastSync: ""
  signal changed()

  property string apiToken: ""
  property bool inFlight: false
  property bool refreshPending: false
  // Projects, not tasks. Tasks are fetched whole on every poll (SNG-7); these two decide
  // only whether to also ask for the project list, which changes on the order of weeks.
  // The flag is the "on demand" half of that rule — a new token, a project filter set before
  // any project names have arrived, and the `refresh` IPC command each raise it.
  property bool projectsFetchPending: false
  property string lastProjectFetchDay: ""
  // The token the in-flight project request was issued under, for the same reason the write
  // path remembers its own: a list that comes back after the token changed describes another
  // account, and merging it would put foreign project names in this session's cache.
  property string issuedProjectToken: ""

  function dayKey(date) {
    return date.getFullYear() + "-" + (date.getMonth() + 1) + "-" + date.getDate()
  }

  // ---- settings ------------------------------------------------------

  function applySettings(text) {
    var token = ""
    try {
      var parsed = JSON.parse(text || "{}")
      if (parsed && typeof parsed.apiToken === "string") token = parsed.apiToken.trim()
    } catch (e) {
      // Never log the file contents or the parse message: both may carry the token.
      token = ""
    }
    // A newline or quote would be a curl config injection through `-K -`.
    if (/[\r\n"]/.test(token)) token = ""

    if (token === root.apiToken) return
    root.apiToken = token
    // Writes belong to the credential that issued them. A queue, a row still drawn as
    // "sent", and a stale write error all outlive the token that produced them otherwise —
    // and a 401 left in the footer after the token is fixed reports a failure that is over.
    root.abandonMutations()
    if (token === "") {
      root.status = "no-token"
      root.errorText = ""
      root.cachedTasks = []
      root.checklists = ({})
      root.checklistPending = []
      root.allTasks = []
      root.tasks = []
      root.projects = []
      root.visibleCount = 0
      root.overdueCount = 0
      root.filterApplied = true
      root.excludedCount = 0
      root.lastSync = ""
      root.changed()
      return
    }
    chmodProc.running = true
    root.projectsFetchPending = true
    root.refresh()
  }

  // ---- filtered view -------------------------------------------------

  // Rebuilds `tasks` and the counters from the full window. Returns true when anything
  // visible actually changed, so callers keep SNG-1's quiet gate instead of emitting
  // `changed()` on every silent poll. The view — including whether it counts as unchanged —
  // is computed by Api.computeView, where `node --test` can reach it; this function only
  // assigns. Deciding equality here was the bug: the filter hands back a fresh array
  // whenever it drops anything, so an identity check reported a change on every poll.
  function recompute() {
    var view = Api.computeView(root.tasks, root.allTasks, root.projects,
                               root.excludedProjects, new Date())
    var same = view.tasks === root.tasks
      && view.total === root.visibleCount
      && view.overdue === root.overdueCount
      && view.applied === root.filterApplied
      && view.excludedCount === root.excludedCount
    root.tasks = view.tasks
    root.visibleCount = view.total
    root.overdueCount = view.overdue
    root.filterApplied = view.applied
    root.excludedCount = view.excludedCount
    return !same
  }

  onExcludedProjectsChanged: {
    // A list set before projects have ever arrived would silently do nothing; ask for a
    // poll, whose tail is what fetches the project names.
    if (Api.normalizeExcluded(root.excludedProjects).size > 0
        && root.projects.length === 0 && root.apiToken !== "") {
      root.projectsFetchPending = true
      root.refresh()
    }
    if (root.recompute()) root.changed()
  }

  // ---- polling -------------------------------------------------------

  function refresh() {
    if (root.apiToken === "") return
    if (root.inFlight) { root.refreshPending = true; return }
    if (Api.shouldDeferPoll(root.mutationQueue.length, root.mutatingId)) {
      root.refreshPending = true
      return
    }
    var now = new Date()
    root.inFlight = true
    if (root.status !== "ready") root.status = "loading"   // a background poll keeps `ready`; the quiet gate below depends on it
    taskProc.startedAt = now.getTime()
    root.runAuthedCurl(taskProc, Api.buildUrl("/v2/task", Api.taskQuery()))
  }

  // The whole request — token, verb, headers, body — goes to curl as a `-K -` config on
  // stdin. Nothing reaches argv, where /proc/<pid>/cmdline would expose both the token and
  // whatever the user typed to every process on the machine. Both the command array and
  // the config text are built by pure functions in Api.mjs so that property is pinned by a
  // test rather than by one look at a process that lives half a second.
  function runAuthedRequest(proc, url, method, bodyOrNull) {
    proc.command = Api.buildRequestCommand(url)
    proc.stdinEnabled = true
    proc.running = true
    proc.write(Api.buildCurlConfig(root.apiToken, method, bodyOrNull))
    proc.stdinEnabled = false   // curl reads the config until EOF
  }

  function runAuthedCurl(proc, url) {
    root.runAuthedRequest(proc, url, "GET", null)
  }

  function finishWithError(text) {
    root.status = "error"
    root.errorText = text
    root.inFlight = false
    root.changed()
    root.drainPending()
  }


  // ---- mutations -----------------------------------------------------
  //
  // Writes get their own process, their own busy flag and their own error text. Routing
  // them through the poll's `finishWithError` would set `status: "error"` and clear
  // `inFlight` mid-poll — one checkbox that failed to save would repaint the whole popup
  // as a broken service and could start a second concurrent poll through drainPending.

  property var mutationQueue: []      // {id, op, title} entries, oldest first
  property string mutatingId: ""      // the entry currently in flight, "" when idle
  property var pendingIds: []         // ids the interface should draw as "sent"
  property string mutationError: ""   // raw text; the popup classifies it, never shows it
  property double lastMutationAt: 0   // guards the poll response that started before it
  signal mutated(string id, string op)

  function enqueueMutation(op, id, title) {
    if (root.apiToken === "") return false
    if (id !== "" && root.pendingIds.indexOf(id) !== -1) return false   // already sent
    // The guard lives here, not in the popup: the IPC handler reaches the same POST, and a
    // rule enforced in one caller is not a rule. Completing an instance of a recurring
    // series is what this refuses.
    if (!Api.mutationAllowed(op, root.taskById(id))) return false
    // Validate before queueing, not while draining: a blank title rejected downstream
    // still answered the caller "ok" for something that was never going to be sent.
    if (!Api.mutationBody(op, title, new Date()).ok) return false
    var q = root.mutationQueue.slice()
    q.push({ id: id, op: op, title: title || "" })
    root.mutationQueue = q
    if (id !== "") root.pendingIds = root.pendingIds.concat([id])
    root.mutationError = ""
    root.drainMutations()
    return true
  }

  function drainMutations() {
    if (root.mutatingId !== "" || root.mutationQueue.length === 0) return
    if (root.apiToken === "") { root.abandonMutations(); return }
    var q = root.mutationQueue.slice()
    var entry = q.shift()
    root.mutationQueue = q
    root.mutatingId = entry.id === "" ? "new" : entry.id
    mutationProc.entryId = entry.id
    mutationProc.op = entry.op

    var spec = Api.MUTATIONS[entry.op](entry.id)
    // Remembered, not re-read on return: a response that comes back after the token changed
    // describes another account's world, and merging it would put foreign tasks in this
    // session's cache.
    mutationProc.issuedToken = root.apiToken
    root.runAuthedRequest(mutationProc, Api.BASE_URL + spec.path, spec.method,
      Api.mutationBody(entry.op, entry.title, new Date()).body)
  }

  // Every exit funnels here — success, non-zero code, an empty token, a timeout. A path
  // that forgets to call it leaves the checkbox drawn as "sent" forever and stops the
  // queue silently, and the only cure would be restarting the shell.
  function finishMutation(id, ok) {
    if (id !== "") root.pendingIds = root.pendingIds.filter(function(x) { return x !== id })
    root.mutatingId = ""
    if (ok) root.lastMutationAt = Date.now()
    root.changed()
    Qt.callLater(root.drainMutations)
    // A poll deferred while writes were running still owes us fresh data.
    if (root.mutationQueue.length === 0) Qt.callLater(root.drainPending)
  }

  function abandonMutations() {
    root.mutationQueue = []
    root.pendingIds = []
    root.mutatingId = ""
    root.mutationError = ""
    // The undo belongs to the credential that made the completion; offering it after a
    // token change would aim it at another account's task id.
    root.undoableId = ""
    root.undoableTitle = ""
  }

  // The last completion, kept so it can be taken back. One deep, not a stack: the popup
  // offers one undo for the keystroke that just happened, and a history nobody can see
  // would only invite guessing about which task comes back.
  property string undoableId: ""
  property string undoableTitle: ""

  function undoComplete() {
    if (root.undoableId === "") return false
    var id = root.undoableId
    root.undoableId = ""
    root.undoableTitle = ""
    return root.enqueueMutation("uncomplete", id, "")
  }

  // Over the wide cache, not the narrow window: a task the overlay moves is usually one
  // with no date, and looking it up in the window would find nothing and refuse the write.
  function taskById(id) {
    for (var i = 0; i < root.cachedTasks.length; i++)
      if (root.cachedTasks[i].id === id) return root.cachedTasks[i]
    return undefined   // absent from the cache: unknown shape, and mutationAllowed refuses
  }

  // ---- checklists (SNG-4) ------------------------------------------------
  //
  // A path of its own, deliberately apart from the task queue. An answer from
  // /v2/checklist-item/{id}/check is an *item*, and the queue's handler feeds every answer
  // through parseTask into the task cache: an item has an id, so it would parse, become a
  // plausible task, and land in the window. The two also share no id space — pendingIds
  // would mix item ids with task ids.
  property var checklists: ({})        // task id -> items, filled on demand
  property var checklistPending: []    // item ids currently in flight
  property string checklistError: ""

  signal checklistChanged(string taskId)

  function checklistFor(taskId) {
    var box = root.checklists[taskId]
    return box ? box : []
  }

  function loadChecklist(taskId) {
    if (root.apiToken === "" || !taskId || checklistProc.running) return false
    checklistProc.taskId = taskId
    checklistProc.issuedToken = root.apiToken
    root.runAuthedCurl(checklistProc, Api.buildUrl("/v2/checklist-item", Api.checklistQuery(taskId)))
    return true
  }

  function toggleChecklistItem(taskId, itemId) {
    if (root.apiToken === "" || !itemId || checklistMutProc.running) return false
    if (root.checklistPending.indexOf(itemId) !== -1) return false
    var list = root.checklistFor(taskId)
    var current
    for (var i = 0; i < list.length; i++) if (list[i].id === itemId) current = list[i]
    if (!current) return false
    var op = Api.checklistToggleOp(current)
    var spec = Api.CHECKLIST_MUTATIONS[op](itemId)
    checklistMutProc.taskId = taskId
    checklistMutProc.itemId = itemId
    checklistMutProc.issuedToken = root.apiToken
    root.checklistPending = root.checklistPending.concat([itemId])
    root.checklistError = ""
    root.runAuthedRequest(checklistMutProc, Api.BASE_URL + spec.path, spec.method, null)
    return true
  }

  function finishChecklistItem(itemId) {
    root.checklistPending = root.checklistPending.filter(function(x) { return x !== itemId })
  }

  Process {
    id: checklistProc
    property string taskId: ""
    property string issuedToken: ""
    stdout: StdioCollector { id: checklistOut; waitForEnd: true }
    stderr: StdioCollector { id: checklistErr; waitForEnd: true }
    onExited: function(exitCode) {
      var taskId = checklistProc.taskId
      if (root.apiToken !== checklistProc.issuedToken) return
      if (exitCode !== 0) {
        var msg = String(checklistErr.text || "").trim()
        root.checklistError = msg !== "" ? msg : "curl exited with code " + exitCode
        root.checklistChanged(taskId)
        return
      }
      var parsed
      try {
        parsed = Api.parseChecklist(checklistOut.text)
      } catch (e) {
        root.checklistError = String(e.message || e)
        root.checklistChanged(taskId)
        return
      }
      var box = {}
      for (var key in root.checklists) box[key] = root.checklists[key]
      box[taskId] = Api.mergeChecklist(root.checklists[taskId], parsed)
      root.checklists = box
      root.checklistError = ""
      root.checklistChanged(taskId)
    }
  }

  Process {
    id: checklistMutProc
    property string taskId: ""
    property string itemId: ""
    property string issuedToken: ""
    stdout: StdioCollector { id: checklistMutOut; waitForEnd: true }
    stderr: StdioCollector { id: checklistMutErr; waitForEnd: true }
    onExited: function(exitCode) {
      var taskId = checklistMutProc.taskId
      var itemId = checklistMutProc.itemId
      root.finishChecklistItem(itemId)
      if (root.apiToken !== checklistMutProc.issuedToken) return
      if (exitCode !== 0) {
        var msg = String(checklistMutErr.text || "").trim()
        root.checklistError = msg !== "" ? msg : "curl exited with code " + exitCode
        root.checklistChanged(taskId)
        return
      }
      // The answer is the item, but re-reading the list is one request either way and keeps
      // one parser instead of two.
      root.checklistError = ""
      root.loadChecklist(taskId)
    }
  }

  function complete(id) { return root.enqueueMutation("complete", id, "") }
  function rename(id, title) { return root.enqueueMutation("rename", id, title) }
  function add(title) { return root.enqueueMutation("create", "", title) }
  // The overlay's write. The zone travels in the same payload field a title uses — the entry
  // has one, and the operation says how to read it (Api.mutationBody).
  function move(id, zone) { return root.enqueueMutation("move", id, zone) }

  Process {
    id: mutationProc
    property string entryId: ""
    property string op: ""
    property string issuedToken: ""
    stdout: StdioCollector { id: mutationOut; waitForEnd: true }
    stderr: StdioCollector { id: mutationErr; waitForEnd: true }
    onExited: function(exitCode) {
      var id = mutationProc.entryId
      // Not "is there a token now" but "is it still the one this write was issued under" —
      // an empty token and a different account's token are both reasons to drop the answer.
      if (root.apiToken !== mutationProc.issuedToken) {
        root.abandonMutations()
        return
      }
      if (exitCode !== 0) {
        var msg = String(mutationErr.text || "").trim()
        root.mutationError = msg !== "" ? msg : "curl exited with code " + exitCode
        root.finishMutation(id, false)
        return
      }
      var task
      try {
        task = Api.parseTask(mutationOut.text, new Date())
      } catch (e) {
        root.mutationError = String(e.message || e)
        root.finishMutation(id, false)
        return
      }
      // The response is the task itself, so it goes through the same merge as a poll:
      // isCached already drops a completed task, so the cache needs no new filter. What
      // the response does not carry — the recurrence rule — is carried across from the copy
      // we already hold, so a series cannot lose its protection by being renamed.
      var mutatedAt = new Date()
      root.cachedTasks = Api.merge(root.cachedTasks,
        [Api.carryRecurrence(root.taskById(task.id), task)], mutatedAt)
      root.allTasks = Api.narrowWindow(root.allTasks, root.cachedTasks, mutatedAt)
      root.mutationError = ""
      if (mutationProc.op === "complete") {
        root.undoableId = task.id
        root.undoableTitle = task.title
      } else if (mutationProc.op === "uncomplete") {
        root.undoableId = ""
        root.undoableTitle = ""
      }
      root.recompute()
      root.mutated(task.id, mutationProc.op)
      root.finishMutation(id, true)
    }
  }

  function drainPending() {
    if (root.refreshPending) {
      root.refreshPending = false
      root.refresh()
    }
  }

  Process {
    id: taskProc
    property double startedAt: 0
    stdout: StdioCollector { id: taskOut; waitForEnd: true }
    stderr: StdioCollector { id: taskErr; waitForEnd: true }
    onExited: function(exitCode) {
      if (root.apiToken === "") {   // token removed while the request was in flight: no-token stays the truth
        root.inFlight = false
        root.refreshPending = false
        return
      }
      if (exitCode !== 0) {
        var msg = String(taskErr.text || "").trim()
        root.finishWithError(msg !== "" ? msg : "curl exited with code " + exitCode)
        return
      }
      if (Api.isStalePollResponse(taskProc.startedAt, root.lastMutationAt)) {
        root.inFlight = false
        root.refreshPending = true
        root.drainPending()
        return
      }
      var now = new Date()
      var incoming
      try {
        incoming = Api.parseTasks(taskOut.text, now)
      } catch (e) {
        root.finishWithError(String(e.message || e))
        return
      }
      if (incoming.length >= Api.MAX_COUNT)
        console.warn(root.pluginId + ": task list hit maxCount=" + Api.MAX_COUNT + ", the window may be truncated")
      var next = Api.mergeFull(root.cachedTasks, incoming)
      var quiet = next === root.cachedTasks && root.status === "ready" && root.errorText === ""
      root.cachedTasks = next
      root.allTasks = Api.narrowWindow(root.allTasks, next, now)
      root.lastSync = now.toISOString()
      root.errorText = ""
      root.status = "ready"
      var visibleChanged = root.recompute()
      if (!quiet || visibleChanged) root.changed()
      // Projects are asked for once a local day, or whenever something raised the flag.
      // Tasks no longer decide this: they are fetched whole every time.
      //
      // One day value for both the question and the answer: the poll started at
      // `taskProc.startedAt`, and asking with one day while recording another would let a
      // request that straddles midnight claim the wrong day.
      var startDay = root.dayKey(new Date(taskProc.startedAt))
      if (Api.shouldFetchProjects(root.projectsFetchPending, root.lastProjectFetchDay, startDay)) {
        // The flag is not cleared here. It is the only carrier of "someone asked out of
        // turn", and a request that fails would take that request with it — the names would
        // then wait for tomorrow, which is the very thing this flag exists to prevent.
        projectProc.forDay = startDay
        root.issuedProjectToken = root.apiToken
        root.runAuthedCurl(projectProc, Api.buildUrl("/v2/project", Api.projectsQuery()))
      } else {
        root.inFlight = false
        root.drainPending()
      }
    }
  }

  // Projects ride on the tail of a successful task poll; a failure here is reported
  // but neither changes `status` nor clears the project cache.
  Process {
    id: projectProc
    // The day this request was built for. Written to the day key only on success, so a
    // failed project fetch does not claim "already fetched today" and cost a day of names.
    property string forDay: ""
    stdout: StdioCollector { id: projectOut; waitForEnd: true }
    stderr: StdioCollector { id: projectErr; waitForEnd: true }
    onExited: function(exitCode) {
      if (root.apiToken !== root.issuedProjectToken) {   // answer from another account
        root.inFlight = false
        root.refreshPending = false
        return
      }
      if (exitCode !== 0) {
        var msg = String(projectErr.text || "").trim()
        root.errorText = "projects: " + (msg !== "" ? msg : "curl exited with code " + exitCode)
      } else {
        try {
          root.projects = Api.parseProjects(projectOut.text)
          // Both marks of success, written together and only here: the day is claimed and
          // the out-of-turn request is answered. A failure leaves both as they were, so the
          // next poll asks again instead of waiting for tomorrow.
          root.lastProjectFetchDay = projectProc.forDay
          root.projectsFetchPending = false
        } catch (e) {
          root.errorText = "projects: " + String(e.message || e)
        }
      }
      root.inFlight = false
      root.recompute()   // names become resolvable only now, on the first project fetch
      root.changed()
      root.drainPending()
    }
  }

  Timer {
    interval: root.pollIntervalMs
    running: true
    repeat: true
    onTriggered: {
      settingsFile.reload()   // belt for the file watcher: a created, replaced or removed file lands within one tick
      if (root.apiToken !== "") root.refresh()
    }
  }

  // ---- state dir and settings file ----------------------------------

  // The watcher cannot attach to a missing directory, so the directory comes first and
  // the FileView path is set only once mkdir has finished.
  Process {
    id: mkdirProc
    command: ["mkdir", "-p", root.stateDir]
    onExited: settingsFile.path = root.settingsPath
  }

  Process {
    id: chmodProc
    command: ["chmod", "600", root.settingsPath]
  }

  FileView {
    id: settingsFile
    watchChanges: true
    printErrors: false
    onLoaded: root.applySettings(text())
    onLoadFailed: root.applySettings("")
    onFileChanged: reload()
  }

  Component.onCompleted: mkdirProc.running = true

  IpcHandler {
    target: "singularity"

    function status(): string {
      return JSON.stringify({
        status: root.status,
        errorText: root.errorText,
        // `tasks` is the filtered view every surface reads; `allTasks` is the full window,
        // published beside it because the meaning of `tasks` changed in SNG-2.
        tasks: root.tasks,
        allTasks: root.allTasks,
        projects: root.projects,
        visibleCount: root.visibleCount,
        overdueCount: root.overdueCount,
        // Always the effective list, never the raw setting: the raw value is an array or a
        // comma string depending on who wrote it, and consumers should not have to care.
        excludedProjects: Api.excludedList(root.excludedProjects),
        filterApplied: root.filterApplied,
        lastSync: root.lastSync,
        inFlight: root.inFlight,
        // The write side, published for the same reason as `inFlight`: a mutation lives
        // about half a second, and a screenshot race is not a verification method.
        mutatingId: root.mutatingId,
        pendingIds: root.pendingIds,
        mutationQueued: root.mutationQueue.length,
        mutationError: root.mutationError,
        undoableId: root.undoableId,
        undoableTitle: root.undoableTitle
      })
    }

    // Write side, deliberately transient: the bar widget re-pushes its shell.json value on
    // the next settings change, so this overrides the filter for the session and no longer.
    // It stays because it is the only way to exercise the filter without editing shell.json.
    function exclude(names: string): string {
      root.excludedProjects = names
      return JSON.stringify({
        excludedProjects: Api.excludedList(root.excludedProjects),
        visibleCount: root.visibleCount,
        overdueCount: root.overdueCount,
        filterApplied: root.filterApplied
      })
    }

    function complete(id: string): string {
      return root.complete(id) ? "ok" : "rejected"
    }

    function undo(): string {
      return root.undoComplete() ? "ok" : "nothing-to-undo"
    }

    function add(title: string): string {
      return root.add(title) ? "ok" : "rejected"
    }

    function rename(id: string, title: string): string {
      return root.rename(id, title) ? "ok" : "rejected"
    }

    function refresh(): string {
      settingsFile.reload()
      if (root.apiToken === "") return "no-token"
      root.projectsFetchPending = true
      root.refresh()
      return "ok"
    }
  }
}
