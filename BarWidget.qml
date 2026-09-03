import QtQuick
import qs.Commons
import qs.Ui

// The bar face: one glyph, and the number of tasks in the "today and overdue" window.
// All state belongs to Service.qml — this file reads it back and decides what to draw.
// The popup is SNG-3; here a click only has to keep the widget interactive.
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

  // The exclusion list lives in this widget's shell.json entry and is handed to the service,
  // which applies it to its own cache — so every surface of the plugin sees the same set.
  function pushExcluded() {
    if (svc) svc.excludedProjects = root.setting("excludedProjects", [])
  }

  onSvcChanged: pushExcluded()
  onSettingsChanged: pushExcluded()
  Component.onCompleted: pushExcluded()

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
    // Without this the unfiltered count would silently pass for a filtered one.
    if (!root.filterApplied) text += ". Отсев не применён: список проектов ещё не загружен"
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
      // The popup arrives with SNG-3. Until then the middle button is the one useful action.
      if (b === Qt.MiddleButton && root.svc) root.svc.refresh()
    }
  }
}
