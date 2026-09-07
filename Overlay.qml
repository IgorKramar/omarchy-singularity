import QtQuick
import Quickshell
import Quickshell.Wayland
import Quickshell.Hyprland
import qs.Commons
import qs.Ui
import "Api.mjs" as Api

// The full-screen surface: the store on the left, three days on the right, and cards moved
// between them by mouse or keyboard.
//
// The shell has no ready-made full-screen primitive — mirador and the stock SpeedTestOverlay
// each declare PanelWindow + WlrLayershell themselves, and this does the same. It is a
// separate entry point from Panel.qml, which is the bar pill's popup: different surface,
// different job, and the manifest declares them apart.
Item {
  id: root

  property var shell: null
  property var manifest: null
  property var service: null
  property bool opened: false

  // Which screen to open on: the one with focus, not the first in the list. The layout is
  // the same everywhere (KD3), but "everywhere" still has to mean the monitor being used.
  property var targetScreen: null
  property string tab: "tasks"
  property string cursorId: ""

  implicitWidth: 0
  implicitHeight: 0

  readonly property var tasks: service ? service.cachedTasks : []
  readonly property var projects: service ? service.projects : []

  property var view: null
  property var columns: []

  function rebuild() {
    var previous = root.columns
    root.view = Api.overlayView(root.view, {
      tasks: root.tasks,
      projects: root.projects,
      now: new Date()
    })
    root.columns = Api.overlayColumns(root.view)
    // The cursor survives the rebuild by task id; when its card left the screen entirely it
    // falls back to the nearest one in the column it was in.
    root.cursorId = Api.overlayCursorAfter(root.columns, root.cursorId, previous)
  }

  function focusedScreen() {
    var monitor = Hyprland.focusedMonitor
    var screens = Quickshell.screens || []
    if (monitor)
      for (var i = 0; i < screens.length; i++)
        if (screens[i] && screens[i].name === monitor.name) return screens[i]
    return screens.length > 0 ? screens[0] : null
  }

  function open(payloadJson) {
    Hyprland.refreshMonitors()
    root.targetScreen = root.focusedScreen()
    root.rebuild()
    if (root.cursorId === "" && root.columns.length > 0)
      root.cursorId = Api.moveOverlayCursor(root.columns, "", 0, 1)
    root.opened = true
    if (root.service && typeof root.service.refresh === "function") root.service.refresh()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  // Called by the shell when *it* closes us. `dismiss` is the other direction — see below.
  function close() {
    root.opened = false
  }

  // Closing on our own initiative (Esc, a click outside) has to tell the shell, or the shell
  // goes on believing the overlay is open and the next summon toggles it shut instead of
  // opening it. Two states under one appearance, and nothing in the log to say so.
  function dismiss() {
    root.opened = false
    if (root.shell && typeof root.shell.hide === "function")
      root.shell.hide((root.manifest && root.manifest.id) || "io.github.igorkramar.singularity")
  }

  function toggle() {
    if (root.opened) root.dismiss()
    else root.open("{}")
  }

  function moveCursor(dx, dy) {
    root.cursorId = Api.moveOverlayCursor(root.columns, root.cursorId, dx, dy)
  }

  function stepTab(direction) {
    // One tab today. Habits and time arrive with SNG-5 and step in here; until then the
    // walk has nowhere to go, and saying so beats pretending the key is broken.
    root.tab = "tasks"
  }

  // Moving the card under the cursor into a zone. The write goes through the service's
  // queue — the same one the popup uses — so the overlay has no write path of its own.
  function moveCursorTask(zone) {
    if (root.cursorId === "" || !root.service) return
    if (typeof root.service.move !== "function") return
    root.service.move(root.cursorId, zone)
  }

  function taskDropped(taskId, zone) {
    if (!taskId || !root.service || typeof root.service.move !== "function") return
    root.cursorId = taskId
    root.service.move(taskId, zone)
  }

  Connections {
    target: root.service
    function onChanged() { if (root.opened) root.rebuild() }
  }

  PanelWindow {
    id: panel
    screen: root.targetScreen
    visible: root.opened && root.targetScreen !== null
    color: "transparent"
    anchors { top: true; bottom: true; left: true; right: true }
    WlrLayershell.namespace: "omarchy-singularity-overlay"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
    exclusionMode: ExclusionMode.Ignore

    Rectangle {
      anchors.fill: parent
      color: Color.menu.scrim
    }

    // A click outside the content closes. Below the content in z-order, so it never eats a
    // click meant for a card.
    MouseArea {
      anchors.fill: parent
      onClicked: root.dismiss()
    }

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent

      onMoveRequested: function(dx, dy) { root.moveCursor(dx, dy) }
      onTabRequested: function(direction) { root.stepTab(direction) }
      onCloseRequested: root.dismiss()
      onTextKey: function(text) {
        var zone = Api.resolveZoneKey(text)
        if (zone !== "") root.moveCursorTask(zone)
      }

      Rectangle {
        anchors.fill: parent
        anchors.margins: Style.space(24)
        radius: Style.cornerRadius
        color: Color.menu.background
        border.width: Style.normalBorderWidth
        border.color: Color.menu.border

        Column {
          anchors.fill: parent
          anchors.margins: Style.space(16)
          spacing: Style.space(12)

          ButtonGroup {
            id: tabs
            anchors.horizontalCenter: parent.horizontalCenter
            focusable: false
            cursorIndex: -1
            options: [{ value: "tasks", label: "Задачи" }]
            value: root.tab
            foreground: Color.menu.text
            background: Color.menu.background
            onChanged: function(v) { root.tab = v }
          }

          Row {
            width: parent.width
            height: parent.height - tabs.height - Style.space(12)
            spacing: Style.space(16)

            // The store: project stacks side by side, scrolling horizontally rather than
            // wrapping into rows. That is what keeps the on-screen order identical to the
            // column list the cursor walks (Api.overlayColumns).
            Flickable {
              id: store
              width: (parent.width - Style.space(16)) * 0.62
              height: parent.height
              contentWidth: storeRow.width
              flickableDirection: Flickable.HorizontalFlick
              clip: true

              Row {
                id: storeRow
                height: store.height
                spacing: Style.space(12)

                Repeater {
                  model: root.view ? root.view.store : []
                  delegate: ZoneColumn {
                    required property var modelData
                    width: Style.space(215)
                    height: storeRow.height
                    title: modelData.title
                    count: modelData.count
                    tasks: modelData.tasks
                    zone: "store"
                    cursorId: root.cursorId
                    service: root.service
                    onCardActivated: function(id) { root.cursorId = id }
                    onTaskDropped: function(id) { root.taskDropped(id, "store") }
                  }
                }
              }
            }

            // The three days.
            Row {
              width: (parent.width - Style.space(16)) * 0.38
              height: parent.height
              spacing: Style.space(12)

              Repeater {
                model: [
                  { zone: "overdue", title: "Просрочено" },
                  { zone: "today", title: "Сегодня" },
                  { zone: "tomorrow", title: "Завтра" }
                ]
                delegate: ZoneColumn {
                  required property var modelData
                  width: (parent.width - Style.space(24)) / 3
                  height: parent.height
                  title: modelData.title
                  zone: modelData.zone
                  tasks: root.view ? root.view[modelData.zone] : []
                  count: tasks.length
                  cursorId: root.cursorId
                  service: root.service
                  // Nothing is moved into the past.
                  acceptsDrop: modelData.zone !== "overdue"
                  onCardActivated: function(id) { root.cursorId = id }
                  onTaskDropped: function(id) { root.taskDropped(id, modelData.zone) }
                }
              }
            }
          }
        }
      }
    }
  }
}
