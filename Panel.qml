import QtQuick
import qs.Commons
import qs.Ui
import "Api.mjs" as Api

// The popup behind the bar pill: what the pill's number is made of.
//
// A nested panel of BarWidget.qml, not a second loadable view of the plugin — the manifest
// already declares an overlay, and a second entry point would collide with it. The widget
// owns the Loader and injects `bar`, `settings`, the anchor and itself; everything the bar
// identifies a panel by has to be that widget rather than this panel (see barIdentity).
Panel {
  id: root
  moduleName: "io.github.igorkramar.singularity"

  property var anchorItem: null
  property var svc: null

  // The bar tracks the widget mounted in its slot, not this nested panel: switchPanelFrom
  // matches on slot.activeItem, so handing it this panel makes Tab silently do nothing.
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  // The threshold itself and the comparison both live in Api.mjs: an unparseable timestamp
  // has to count as stale, and that is a decision whose error is silent.
  readonly property int freshnessMs: Api.FRESHNESS_MS

  readonly property string svcStatus: svc ? svc.status : "loading"
  readonly property bool updating: svc ? svc.inFlight === true : false

  // Guarded so the panel renders before the bar is injected — the bar-widget contract
  // instantiates it bare.
  readonly property color contentForeground: bar ? bar.foreground : Color.foreground
  readonly property string contentFontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color dim: Qt.darker(contentForeground, 1.6)

  // ---- The view ------------------------------------------------------------
  //
  // One property, one assignment. Api.popupView holds the previous section, group and row
  // references inside the object it returns, so a quiet poll hands back the very same
  // arrays and the Repeaters below do not rebuild. Threading those three caches through
  // QML instead is exactly where a wrong `prev` would go unnoticed (KD8).

  property string tab: "today"
  // Only what the user toggled away from the default: a plain section is expanded unless
  // listed, a hidden one is collapsed unless listed. Api.isCollapsed owns that inversion.
  property var toggledSections: []
  property var view: Api.popupView(null, root.viewArgs())

  // A function, not a property: a property binding is not guaranteed to be resolved when
  // `view`'s own initializer runs, and popupView then destructures undefined and throws.
  // The engine reports that as a warning, keeps the old value and carries on — the panel
  // still drew correctly, which is precisely why the fault had to be read out of the log
  // rather than seen. Functions exist before any binding evaluates.
  function viewArgs() {
    return {
      allTasks: root.svc ? root.svc.allTasks : [],
      tasks: root.svc ? root.svc.tasks : [],
      projects: root.svc ? root.svc.projects : [],
      tab: root.tab,
      collapsed: root.toggledSections,
      now: new Date()
    }
  }

  function rebuild() {
    root.view = Api.popupView(root.view, root.viewArgs())
  }

  onTabChanged: { resetCursor(); rebuild() }
  onToggledSectionsChanged: rebuild()
  onSvcChanged: rebuild()

  Connections {
    target: root.svc
    function onChanged() { root.rebuild() }
  }

  // ---- States and footer ---------------------------------------------------

  readonly property int windowCount: svc ? svc.allTasks.length : 0
  readonly property string emptyReason: Api.emptyReason(root.svcStatus, root.windowCount,
    root.view.hiddenTaskCount, root.view.count)

  // Our own words for the class of failure. The service stores curl's stderr and the raw
  // exception; neither reaches the screen (R23).
  readonly property string emptyText: {
    if (root.emptyReason === "no-token")
      return "Нет токена. Положите его в " + (root.svc ? root.svc.settingsPath : "settings.json")
    if (root.emptyReason === "error") return root.errorPhrase
    if (root.emptyReason === "loading") return "Загрузка"
    if (root.emptyReason === "all-clear") return "Всё чисто"
    if (root.emptyReason === "all-hidden")
      return "Всё, что есть в окне, скрыто отсевом: задач " + root.view.hiddenTaskCount
    if (root.emptyReason === "tab-empty") return "На этой вкладке пусто"
    return ""
  }

  // One phrase, two surfaces: the empty state uses it when there is nothing to show, the
  // footer when a failed poll sits on top of a list that is still worth reading. Written
  // once so the two cannot drift into saying different things about the same failure.
  readonly property string errorPhrase: {
    var cls = Api.errorClass(root.svc ? root.svc.errorText : "")
    if (cls === "auth") return "Токен не принят. Проверьте его в настройках SingularityApp"
    if (cls === "network") return "Сервис не отвечает. Похоже на сеть"
    if (cls === "response") return "Ответ пришёл в неожиданном виде"
    return "Запрос не прошёл"
  }

  // Four states, decided here so the row draws and never judges. "unknown" is not a
  // shrug: the recurrence field did not arrive, and completing on a guess could
  // extinguish a repeating series — declining is the only safe answer.
  function checkStateFor(task) {
    if (!root.svc) return "unknown"
    if (root.svc.pendingIds.indexOf(task.id) !== -1) return "pending"
    var r = Api.recurrenceState(task)
    return r === "none" ? "none" : r
  }

  function completeTask(task) {
    if (!root.svc || !task) return
    if (Api.recurrenceState(task) !== "none") return
    root.svc.complete(task.id)
  }

  // The write path carries its own error text, kept apart from the poll's: one checkbox
  // that failed to save must not repaint the popup as a broken service.
  readonly property string mutationPhrase: {
    if (!root.svc || !root.svc.mutationError) return ""
    var cls = Api.errorClass(root.svc.mutationError)
    if (cls === "auth") return "Не сохранено: токен не принят"
    if (cls === "network") return "Не сохранено: сервис не отвечает"
    if (cls === "response") return "Не сохранено: ответ в неожиданном виде"
    return "Не сохранено"
  }

  readonly property var unmatched: Api.unmatchedExcluded(
    root.svc ? root.svc.projects : [], root.svc ? root.svc.excludedProjects : [])

  readonly property string footerText: {
    var parts = []
    // Both directions have to be visible: without the first line an unfiltered list passes
    // for a filtered one, without the second a day emptied by the filter looks like a day
    // that was genuinely empty. Which of the two applies is decided in Api.mjs — they are
    // contradictory claims about the same moment, and choosing between them wrongly is the
    // kind of mistake that reads as a perfectly sensible sentence.
    var f = Api.footerState(root.svc ? root.svc.filterApplied : true,
                            root.svc ? root.svc.excludedCount : 0,
                            root.view.hiddenTaskCount,
                            root.svc ? root.svc.projects : [],
                            root.svc ? root.svc.excludedProjects : [])
    if (f.kind === "not-applied") parts.push("Отсев не применён: список проектов ещё не загружен")
    else if (f.kind === "hidden") {
      parts.push("Скрыто задач: " + f.hiddenTaskCount)
      if (f.unmatched.length > 0)
        parts.push("в отсеве нет таких проектов: " + f.unmatched.join(", "))
    }
    // Named whether or not the list is empty. A failed poll on top of a cache that still
    // has rows is the likeliest failure there is, and without this line the popup shows the
    // stale list beside the time of the last *successful* sync — a screen that looks right.
    if (root.mutationPhrase !== "") parts.push(root.mutationPhrase)
    if (root.svcStatus === "error") parts.push(root.errorPhrase)
    if (root.updating) parts.push("обновляется")
    else if (root.svc && root.svc.lastSync)
      parts.push("обновлено в " + Qt.formatTime(new Date(root.svc.lastSync), "HH:mm"))
    return parts.join(" · ")
  }

  // ---- Cursor --------------------------------------------------------------
  //
  // Three properties, per KTD4: where it sits, what it sits on, and whether the keyboard
  // is driving. The id is what survives a rebuild — a row number does not, because a poll
  // can insert a task above the selection.

  property int cursorIndex: -1
  property string cursorId: ""
  property string cursorSection: ""
  property bool cursorActive: false
  // Last input wins. Without this a pointer resting over the list drags the selection back
  // on every stray hover the moving rows generate under it.
  property bool keyboardDrivingCursor: false

  readonly property var cursorRow: cursorActive && cursorIndex >= 0
    && cursorIndex < root.view.flat.length ? root.view.flat[cursorIndex] : null

  function noteCursor() {
    var row = root.cursorRow
    root.cursorId = row ? row.id : ""
    root.cursorSection = row ? row.key : ""
    if (root.cursorIndex < 0) root.cursorActive = false
  }

  onViewChanged: {
    if (!root.cursorActive) return
    root.cursorIndex = Api.cursorIndexForId(root.view.flat, root.cursorId,
                                            root.cursorIndex, root.cursorSection)
    root.noteCursor()
  }

  function moveCursorBy(delta) {
    if (root.view.flat.length === 0) return
    root.keyboardDrivingCursor = true
    root.cursorActive = true
    root.cursorIndex = Api.moveCursor(root.cursorIndex, delta, root.view.flat.length)
    root.noteCursor()
  }

  // Enter raises returnRequested and activateRequested back to back; Space raises only the
  // second. The flag lets the pair act once (KTD8).
  property bool suppressNextActivate: false

  // A header folds; a task row does nothing. Reading a task is what the popup is for, and
  // acting on one waits for SNG-3.1.
  function activateCursor() {
    var row = root.cursorRow
    if (row && row.kind === "header") root.toggleSection(row.group)
  }

  function selectByHover(id) {
    if (root.keyboardDrivingCursor) return
    var index = Api.cursorIndexForId(root.view.flat, id, -1, null)
    if (index < 0) return
    root.cursorActive = true
    root.cursorIndex = index
    root.noteCursor()
  }

  function notePointerMoved(item, mouse, id) {
    if (!pointerGate.moved(item, mouse)) return
    root.keyboardDrivingCursor = false
    root.selectByHover(id)
  }

  // Keeps the row under the cursor on screen as the arrows walk past the fold.
  function ensureVisible(item) {
    if (!item) return
    var top = item.mapToItem(listColumn, 0, 0).y
    var bottom = top + item.height
    var pad = Style.space(8)
    if (top - pad < listFlick.contentY)
      listFlick.contentY = Math.max(0, top - pad)
    else if (bottom + pad > listFlick.contentY + listFlick.height)
      listFlick.contentY = Math.min(Math.max(0, listFlick.contentHeight - listFlick.height),
                                    bottom + pad - listFlick.height)
  }

  PointerMoveGate {
    id: pointerGate
    referenceItem: listColumn
  }

  // Takes the group, not a bare key: the stored entry has to carry the default it was
  // written against, or a project crossing into or out of the filter inverts its section.
  function toggleSection(group) {
    var key = Api.toggleKey(group)
    var next = root.toggledSections.slice()
    var at = next.indexOf(key)
    if (at === -1) next.push(key)
    else next.splice(at, 1)
    root.toggledSections = next
  }

  function open() {
    root.resetCursor()
    root.controller.show()
    root.rebuild()
    root.refreshIfStale()
  }

  // Switching tabs rebuilds the list under the cursor; keeping an index there would land it
  // on an unrelated row. Section folding does not reset — that is what R7 protects.
  function resetCursor() {
    root.cursorIndex = -1
    root.cursorId = ""
    root.cursorSection = ""
    root.cursorActive = false
    root.keyboardDrivingCursor = false
    pointerGate.reset()
    listFlick.contentY = 0
  }

  // close() and toggle() are not overridden: the base Ui/Panel provides both verbatim, and
  // the open() call inside the base toggle() resolves to the override below — verified.

  function stepTab(delta) {
    var at = Api.POPUP_TABS.indexOf(root.tab)
    root.tab = Api.POPUP_TABS[Api.moveCursor(at, delta, Api.POPUP_TABS.length)]
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  // Opening asks for fresh data, and the footer says so — a silent refresh reads as the
  // list moving on its own. An empty lastSync means nothing has ever come back, which is
  // exactly the case that must poll.
  function refreshIfStale() {
    if (!svc || typeof svc.refresh !== "function") return
    if (Api.isStale(svc.lastSync, new Date(), root.freshnessMs)) svc.refresh()
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(420))
    // The tab strip stays put; only the list scrolls.
    contentHeight: panel.fittedContentHeight(tabs.height + Style.space(18)
      + Math.min(listColumn.implicitHeight, Style.space(460)) + footer.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent

      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      // The catcher folds h/l and the horizontal arrows into one signal, so horizontal
      // carries exactly one meaning — the tabs. Folding sections lives on Enter (KD6).
      onMoveRequested: function(dx, dy) {
        if (dx !== 0) { root.stepTab(dx); return }
        if (dy !== 0) root.moveCursorBy(dy)
      }
      onReturnRequested: {
        root.suppressNextActivate = true
        root.activateCursor()
      }
      onActivateRequested: {
        // Enter raised returnRequested first and set the flag; Space raises only this one.
        // The existing flag therefore already separates the two — no new mechanism needed.
        if (root.suppressNextActivate) { root.suppressNextActivate = false; return }
        var row = root.cursorRow
        if (row && row.kind === "task") root.completeTask(row.task)
        else root.activateCursor()
      }

      // ---- Tabs. Three slices of one cache, so switching costs no request.
      ButtonGroup {
        id: tabs
        anchors.top: parent.top
        anchors.horizontalCenter: parent.horizontalCenter
        // Tab belongs to the panel walk, not to this group; the key catcher takes h/l
        // before the group ever sees them.
        focusable: false
        cursorIndex: -1
        options: [
          { value: "today", label: "Сегодня" },
          { value: "all", label: "Все" },
          { value: "overdue", label: "Просрочено" }
        ]
        value: root.tab
        foreground: root.contentForeground
        background: Color.popups.background
        fontFamily: root.contentFontFamily
        onChanged: function(v) { root.tab = v }
      }

      Flickable {
        id: listFlick
        anchors.top: tabs.bottom
        anchors.topMargin: Style.space(12)
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: footer.top
        anchors.bottomMargin: Style.space(6)
        contentWidth: width
        contentHeight: listColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height

        Column {
          id: listColumn
          width: listFlick.width
          spacing: Style.space(4)

          // No ready-made empty state exists in Ui/, so it is a Text with a computed cause —
          // and the cause is computed in Api.mjs, not by a chain of conditions here (KTD7).
          // It sits inside the list rather than over it: when the whole window is hidden by
          // the filter, the message and the collapsed hidden sections have to coexist, or
          // R12 has nothing left to expand.
          Text {
            id: emptyState
            width: listColumn.width
            topPadding: Style.space(14)
            bottomPadding: Style.space(10)
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
            visible: root.emptyText !== ""
            text: root.emptyText
            color: root.emptyReason === "error" || root.emptyReason === "no-token"
              ? Color.urgent : root.dim
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.body
            textFormat: Text.PlainText
          }

          Repeater {
            model: root.view.sections

            // A section: header, then its rows unless collapsed. A hidden section — one the
            // SNG-2 project filter dropped — sits in its place in the list, greyed and
            // collapsed, and opens the same way any other does (R11, R12).
            Column {
              id: section
              required property var modelData
              readonly property bool collapsed: Api.isCollapsed(modelData, root.toggledSections)

              width: listColumn.width
              spacing: Style.space(2)

              Item {
                id: headerItem
                width: parent.width
                height: header.implicitHeight + Style.space(8)

                // Identity, not an index: the delegate never has to know its place in the
                // flat sequence, so no arithmetic can put the highlight on the wrong row.
                readonly property bool hasCursor: root.cursorRow
                  && root.cursorRow.kind === "header"
                  && root.cursorRow.key === section.modelData.key

                onHasCursorChanged: {
                  if (hasCursor && root.keyboardDrivingCursor) root.ensureVisible(headerItem)
                }

                Rectangle {
                  anchors.fill: parent
                  radius: Style.cornerRadius
                  color: headerItem.hasCursor || headerMouse.containsMouse
                    ? Style.hoverFillFor(root.contentForeground, Color.accent) : "transparent"
                }

                Row {
                  id: header
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  anchors.leftMargin: Style.space(10)
                  anchors.rightMargin: Style.space(10)
                  spacing: Style.space(8)

                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    // Chevron: right when collapsed, down when open.
                    text: section.collapsed ? "\uf054" : "\uf078"
                    color: root.dim
                    font.family: root.contentFontFamily
                    font.pixelSize: Style.font.caption
                    textFormat: Text.PlainText
                  }

                  PanelSectionHeader {
                    anchors.verticalCenter: parent.verticalCenter
                    // A hidden section is dimmer than a plain one, so "excluded by the
                    // filter" is visible without opening it.
                    foreground: section.modelData.hidden ? root.dim : root.contentForeground
                    fontFamily: root.contentFontFamily
                    text: section.modelData.title
                    textFormat: Text.PlainText
                  }

                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: section.modelData.count
                    color: root.dim
                    font.family: root.contentFontFamily
                    font.pixelSize: Style.font.caption
                    textFormat: Text.PlainText
                  }
                }

                MouseArea {
                  id: headerMouse
                  anchors.fill: parent
                  hoverEnabled: true
                  onPositionChanged: function(mouse) {
                    root.notePointerMoved(headerItem, mouse, "header:" + section.modelData.key)
                  }
                  onClicked: root.toggleSection(section.modelData)
                }
              }

              Repeater {
                model: section.collapsed ? [] : section.modelData.tasks

                TaskRow {
                  id: taskRow
                  required property var modelData
                  width: section.width
                  task: modelData
                  overdue: Api.isOverdue(modelData, root.view.now)
                  foreground: root.contentForeground
                  fontFamily: root.contentFontFamily
                  // By id, not by object identity: the task object reaches this delegate
                  // through two nested `var` properties, and QML does not promise the same
                  // reference comes out the far end. The section header above compares keys
                  // and highlighted correctly while this row, comparing references, stayed
                  // dark — the cursor was moving all along.
                  hasCursor: root.cursorRow && root.cursorRow.kind === "task"
                    && root.cursorRow.id === "task:" + modelData.id

                  onHasCursorChanged: {
                    if (hasCursor && root.keyboardDrivingCursor) root.ensureVisible(taskRow)
                  }
                  checkState: root.checkStateFor(modelData)
                  onCompleteRequested: root.completeTask(modelData)
                  onPointerMoved: function(mouse) {
                    root.notePointerMoved(taskRow, mouse, "task:" + modelData.id)
                  }
                }
              }
            }
          }
        }
      }

      Column {
        id: footer
        anchors.bottom: parent.bottom
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: Style.space(6)

        PanelSeparator {
          width: parent.width
          visible: root.footerText !== ""
          foreground: root.contentForeground
        }

        Text {
          width: parent.width
          visible: root.footerText !== ""
          text: root.footerText
          color: root.dim
          wrapMode: Text.WordWrap
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
          textFormat: Text.PlainText
        }
      }
    }
  }
}
