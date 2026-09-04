import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Ui

// The bar face: one glyph, and the number of tasks in the "today and overdue" window.
// All state belongs to Service.qml — this file reads it back and decides what to draw.
// It also hosts the popup: a click opens Panel.qml, which the Loader below owns.
BarWidget {
  id: root
  moduleName: "io.github.igorkramar.singularity"

  readonly property string pluginId: "io.github.igorkramar.singularity"

  // `bar` is injected after construction, so this resolves to null on the first pass and
  // fills in later — which is why the settings push below hangs off onSvcChanged too.
  readonly property var svc: bar && bar.shell && typeof bar.shell.serviceFor === "function"
    ? bar.shell.serviceFor(root.pluginId) : null

  // An unresolved service is still starting up, not broken: "error" is reserved for the
  // service's own error state, and flashing it on every shell start would drain its meaning.
  readonly property string svcStatus: svc ? svc.status : "loading"
  readonly property int visibleCount: svc ? svc.visibleCount : 0
  readonly property int overdueCount: svc ? svc.overdueCount : 0
  readonly property bool filterApplied: svc ? svc.filterApplied : true
  readonly property int excludedCount: svc ? svc.excludedCount : 0

  // The exclusion list lives in this widget's shell.json entry and is handed to the service,
  // which applies it to its own cache — so every surface of the plugin sees the same set.
  function pushExcluded() {
    if (svc) svc.excludedProjects = root.setting("excludedProjects", [])
  }

  onSvcChanged: { pushExcluded(); injectPanel() }
  onSettingsChanged: { pushExcluded(); injectPanel() }
  onBarChanged: injectPanel()
  Component.onCompleted: pushExcluded()

  // ---- Popup. The shape Bar.findPanelWidget duck-types a panel by: open, close and
  //      opened have to live on the bar-widget root, not on the nested panel.
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function togglePanel() { if (panelLoader.item) panelLoader.item.toggle() }

  // Forwarded so this widget can stand in for the panel as the bar's popout identity:
  // Bar.requestPopout prefers closeForPopoutSwitch over close, and KeyboardPanel reads
  // popoutSwitchClosing back off its owner.
  readonly property bool popoutSwitchClosing: panelLoader.item
    ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
    if ("svc" in target) target.svc = root.svc
  }

  // A fixed IPC target is claimed by exactly one of the per-monitor instances, so the
  // handler must not open the popup at itself — it asks the bar to pick the slot on the
  // focused output, the same way the shell routes its own panel hotkeys.
  function routePopup(action) {
    if (!root.bar) return
    if (action === "toggle")
      return root.bar.isBarWidgetOpen(root.moduleName)
        ? root.bar.hideBarWidget(root.moduleName)
        : root.bar.summonBarWidget(root.moduleName)
    if (action === "open") return root.bar.summonBarWidget(root.moduleName)
    return root.bar.hideBarWidget(root.moduleName)
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      // `bar` and `settings` arrive after construction, so once is not enough.
      Qt.callLater(root.injectPanel)
    }
  }

  // `singularity` already belongs to the service's handler, and the shell allows one
  // handler per target — hence a name of its own. Only window commands pass through it:
  // no task titles, no project names, no cache.
  IpcHandler {
    target: "singularity.popup"

    function open(): void { root.routePopup("open") }
    function close(): void { root.routePopup("close") }
    function show(): void { root.routePopup("open") }
    function hide(): void { root.routePopup("close") }
    function toggle(): void { root.routePopup("toggle") }
  }

  readonly property string glyph: {
    if (!svc || root.svcStatus === "loading") return "\uf252"   // песочные часы
    if (root.svcStatus === "no-token") return "\uf023"          // замок
    if (root.svcStatus === "error") return "\uf071"             // треугольник
    return "\uf0ae"                                             // список задач
  }

  // A vertical bar gives the glyph a square canvas; a number beside it would be squeezed,
  // so there it moves into the tooltip instead.
  readonly property bool showsCount: root.svcStatus === "ready" && root.visibleCount > 0 && !root.vertical

  readonly property string tooltipText: {
    if (!svc) return "SingularityApp — сервис ещё не поднялся"
    if (root.svcStatus === "no-token")
      return "SingularityApp — нет токена. Положите его в " + svc.settingsPath
    if (root.svcStatus === "error")
      return "SingularityApp — ошибка: " + (svc.errorText || "неизвестная")
    if (root.svcStatus === "loading") return "SingularityApp — загрузка"

    var text = root.visibleCount === 0
      ? "SingularityApp — всё чисто"
      : "SingularityApp — просрочено " + root.overdueCount
        + ", сегодня " + (root.visibleCount - root.overdueCount)
    // Both directions have to be visible. Without the first line an unfiltered count would
    // pass for a filtered one; without the second, a day emptied by the filter would look
    // exactly like a day that was genuinely empty.
    if (!root.filterApplied) text += ". Отсев не применён: список проектов ещё не загружен"
    else if (root.excludedCount > 0) text += ". Отсев: проектов " + root.excludedCount
    // A failed project fetch keeps status at "ready" by design, so it is invisible unless
    // named here.
    if (svc.errorText) text += ". " + svc.errorText
    return text
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.showsCount ? root.glyph + " " + root.visibleCount : root.glyph
    slotSize: Style.bar.iconSlot * (root.showsCount ? 2 : 1)
    active: root.svcStatus === "ready" && root.overdueCount > 0
    useActiveColor: true
    // The bar's own role colour, which it animates on a theme change; the global
    // Color.urgent would bypass a theme's bar.active override.
    activeColor: root.bar ? root.bar.urgent : Color.urgent
    tooltipText: root.tooltipText
    onPressed: function(b) {
      if (b === Qt.MiddleButton) { if (root.svc) root.svc.refresh() }
      else root.togglePanel()
    }
  }
}
