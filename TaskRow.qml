import QtQuick
import qs.Commons
import qs.Ui
import "Api.mjs" as Api

// One task in the popup list: title, and the marks that change what you do about it —
// overdue, deadline, priority.
//
// Everything the API sent is drawn as plain text (R28): a title carrying markup or a link
// is a title, not markup. Text defaults to AutoText, which would parse it.
Item {
  id: root

  required property var task
  property bool overdue: false
  property bool hasCursor: false
  property color foreground: Color.foreground
  property string fontFamily: Style.font.family

  signal pointerMoved(var mouse)

  readonly property color dim: Qt.darker(foreground, 1.6)

  // The scale itself lives in Api.mjs, where a test pins it: the API runs 0 = HIGH,
  // 1 = NORMAL, 2 = LOW — the opposite way round from the guess, and getting it backwards
  // would paint the calmest task red without anything failing.
  readonly property string priorityLabel: task ? Api.priorityLabel(task.priority) : ""
  // Named in text as well as coloured, so the mark still reads without colour vision (R9).
  readonly property color priorityColor: task && Api.isHighPriority(task.priority)
    ? Color.urgent : root.dim

  readonly property string deadlineLabel: {
    if (!task || !task.deadline) return ""
    var d = new Date(task.deadline)
    // toLocaleDateString, not Qt.formatDate: the latter takes no locale, and the system
    // locale here is English — it would print "2 Sep" beside a Russian interface.
    return isNaN(d.getTime()) ? "" : d.toLocaleDateString(Qt.locale("ru_RU"), "d MMM")
  }

  implicitHeight: line.implicitHeight + Style.space(8)

  Rectangle {
    anchors.fill: parent
    radius: Style.cornerRadius
    color: root.hasCursor ? Style.hoverFillFor(root.foreground, Color.accent) : "transparent"
  }

  Row {
    id: line
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    anchors.leftMargin: Style.space(10)
    anchors.rightMargin: Style.space(10)
    spacing: Style.space(8)

    Text {
      anchors.verticalCenter: parent.verticalCenter
      visible: root.overdue
      // A clock, not the pill's warning triangle: there the glyph means "the service
      // broke", here it means "the day has passed". Same colour, different word.
      text: "\uf017"
      color: Color.urgent
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      textFormat: Text.PlainText
    }

    Text {
      id: title
      anchors.verticalCenter: parent.verticalCenter
      // Takes what the marks to its right leave; a long title elides rather than pushing
      // the deadline off the panel.
      width: Math.max(0, line.width - marks.width - line.spacing * (marks.width > 0 ? 2 : 1)
        - (root.overdue ? Style.space(16) : 0))
      text: root.task ? root.task.title : ""
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      elide: Text.ElideRight
      textFormat: Text.PlainText
    }

    Row {
      id: marks
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(6)

      Text {
        visible: root.priorityLabel !== ""
        text: root.priorityLabel
        color: root.priorityColor
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        textFormat: Text.PlainText
      }

      Text {
        visible: root.deadlineLabel !== ""
        text: root.deadlineLabel
        color: root.overdue ? Color.urgent : root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        textFormat: Text.PlainText
      }
    }
  }

  // hoverEnabled even though hovering paints nothing on its own: without it
  // onPositionChanged fires only while a button is held, and the cursor follows pointer
  // movement. The click stays swallowed on purpose — letting it through would reach the
  // dismiss layer and close the popup.
  MouseArea {
    anchors.fill: parent
    hoverEnabled: true
    onPositionChanged: function(mouse) { root.pointerMoved(mouse) }
  }
}
