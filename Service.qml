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
  property var tasks: []
  property var projects: []
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
    if (token === "") {
      root.status = "no-token"
      root.errorText = ""
      root.tasks = []
      root.projects = []
      root.lastSync = ""
      root.changed()
      return
    }
    chmodProc.running = true
    root.fullFetchPending = true
    root.refresh()
  }

  // ---- polling -------------------------------------------------------

  function refresh() {
    if (root.apiToken === "") return
    if (root.inFlight) { root.refreshPending = true; return }
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

  // The token goes to curl over stdin as a `-K -` config line, never as an argument.
  function runAuthedCurl(proc, url) {
    proc.command = ["curl", "-fsS", "--max-time", "15", "-K", "-", url]
    proc.stdinEnabled = true
    proc.running = true
    proc.write("header = \"Authorization: Bearer " + root.apiToken + "\"\n")
    proc.stdinEnabled = false   // curl reads the config until EOF
  }

  function finishWithError(text) {
    root.status = "error"
    root.errorText = text
    root.inFlight = false
    root.changed()
    root.drainPending()
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
      var next = Api.merge(taskProc.full ? [] : root.tasks, incoming, now)
      var quiet = next === root.tasks && root.status === "ready" && root.errorText === ""
      root.tasks = next
      root.lastRequestStartedAt = taskProc.startedAt
      root.lastSync = now.toISOString()
      if (taskProc.full) root.lastFullFetchDay = root.dayKey(new Date(taskProc.startedAt))   // the query window was built at request start
      root.errorText = ""
      root.status = "ready"
      if (!quiet) root.changed()
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
        tasks: root.tasks,
        projects: root.projects,
        lastSync: root.lastSync,
        inFlight: root.inFlight
      })
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
