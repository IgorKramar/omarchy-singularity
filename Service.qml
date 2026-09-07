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
  // good, and clearing the filter would not bring them back until the next full poll.
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
  property bool fullFetchPending: false
  property string lastFullFetchDay: ""
  property double lastRequestStartedAt: 0

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
    root.fullFetchPending = true
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
    // A list set before projects have ever arrived would silently do nothing; ask for the
    // full fetch whose tail carries them.
    if (Api.normalizeExcluded(root.excludedProjects).size > 0
        && root.projects.length === 0 && root.apiToken !== "") {
      root.fullFetchPending = true
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
    var today = root.dayKey(now)
    var full = root.fullFetchPending || root.lastSync === "" || root.lastFullFetchDay !== today
    var params = full ? Api.todayQuery(now) : Api.incrementalQuery(root.lastRequestStartedAt)
    root.fullFetchPending = false
    root.inFlight = true
    if (root.status !== "ready") root.status = "loading"   // a background poll keeps `ready`; the quiet gate below depends on it
    taskProc.full = full
    taskProc.startedAt = now.getTime()
    root.runAuthedCurl(taskProc, Api.buildUrl("/v2/task", params))
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

  function taskById(id) {
    for (var i = 0; i < root.allTasks.length; i++)
      if (root.allTasks[i].id === id) return root.allTasks[i]
    return undefined   // absent from the window: unknown shape, and mutationAllowed refuses
  }

  function complete(id) { return root.enqueueMutation("complete", id, "") }
  function rename(id, title) { return root.enqueueMutation("rename", id, title) }
  function add(title) { return root.enqueueMutation("create", "", title) }

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
      // isCurrent already drops a completed task, so the window needs no new filter. What
      // the response does not carry — the recurrence rule — is carried across from the copy
      // we already hold, so a series cannot lose its protection by being renamed.
      root.allTasks = Api.merge(root.allTasks,
        [Api.carryRecurrence(root.taskById(task.id), task)], new Date())
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
    property bool full: false
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
        // The retry must ask for the same thing the discarded request asked for: a full
        // fetch thrown away here would come back as an increment, and the day's rebuild
        // would silently not happen until tomorrow.
        root.fullFetchPending = root.fullFetchPending || taskProc.full
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
      var next = Api.merge(taskProc.full ? [] : root.allTasks, incoming, now)
      var quiet = next === root.allTasks && root.status === "ready" && root.errorText === ""
      root.allTasks = next
      root.lastRequestStartedAt = taskProc.startedAt
      root.lastSync = now.toISOString()
      if (taskProc.full) root.lastFullFetchDay = root.dayKey(new Date(taskProc.startedAt))   // the query window was built at request start
      root.errorText = ""
      root.status = "ready"
      var visibleChanged = root.recompute()
      if (!quiet || visibleChanged) root.changed()
      if (taskProc.full) {
        root.runAuthedCurl(projectProc, Api.buildUrl("/v2/project", Api.projectsQuery()))
      } else {
        root.inFlight = false
        root.drainPending()
      }
    }
  }

  // Projects ride on the tail of a successful full fetch; a failure here is reported
  // but neither changes `status` nor clears the project cache.
  Process {
    id: projectProc
    stdout: StdioCollector { id: projectOut; waitForEnd: true }
    stderr: StdioCollector { id: projectErr; waitForEnd: true }
    onExited: function(exitCode) {
      if (root.apiToken === "") {
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
        } catch (e) {
          root.errorText = "projects: " + String(e.message || e)
        }
      }
      root.inFlight = false
      root.recompute()   // names become resolvable only now, on the first full poll
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
      root.fullFetchPending = true
      root.refresh()
      return "ok"
    }
  }
}
