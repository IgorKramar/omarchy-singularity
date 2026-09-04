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

  // "none" — ordinary, "pending" — sent and waiting, "recurring" — refuses to complete
  // because doing so could extinguish a series, "unknown" — the recurrence field did not
  // arrive, so we decline rather than guess.
  property string checkState: "none"

  signal pointerMoved(var mouse)
  signal completeRequested()
  signal expandRequested()
  signal renameAccepted(string title)
  signal renameCancelled()

  // Owned by the panel, not by this row: the field lives two Repeaters deep, and the
  // panel has no reference to reach it with. It sets the flag, the row shows the field.
  property bool renaming: false
  // While a rename is in flight the field stays put and keeps what was typed — a failure
  // that silently discarded the text would cost the user the edit twice over.
  property bool renameSending: false

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

  readonly property bool completable: root.checkState === "none"

  Row {
    id: line
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    anchors.leftMargin: Style.space(10)
    anchors.rightMargin: Style.space(10)
    spacing: Style.space(8)

    // The checkbox is the most frequent action and the only one worth keeping under the
    // mouse; everything else lives in the expansion.
    Item {
      id: box
      anchors.verticalCenter: parent.verticalCenter
      width: Style.space(13)
      height: Style.space(13)

      // A box only where a box means something. A dimmed box is not a different
      // affordance — at this size it reads as an ordinary checkbox, so the user clicks
      // it and nothing happens. Where completion is refused the slot carries a repeat
      // glyph instead: not a disabled control, a different thing.
      Rectangle {
        anchors.centerIn: parent
        visible: root.completable || root.checkState === "pending"
        width: Style.space(12)
        height: Style.space(12)
        radius: Style.cornerRadius
        color: root.checkState === "pending"
          ? Style.selectedFillFor(root.foreground, Color.accent) : "transparent"
        border.width: Style.spacing.hairline
        border.color: Style.normalBorderFor(root.foreground, Color.accent)
      }

      Text {
        anchors.centerIn: parent
        visible: root.checkState === "recurring" || root.checkState === "unknown"
        text: "\uf021"
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        textFormat: Text.PlainText
      }

      // A glyph rather than a spinner: the popup has no animation vocabulary, and a mark
      // that simply appears says "sent" without pretending to measure progress.
      Text {
        anchors.centerIn: parent
        visible: root.checkState === "pending"
        text: "\uf110"
        color: Color.accent
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        textFormat: Text.PlainText
      }
    }

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

    Item {
      id: titleSlot
      anchors.verticalCenter: parent.verticalCenter
      // Takes what the marks to its right leave; a long title elides rather than pushing
      // the deadline off the panel.
      width: Math.max(0, line.width - marks.width - box.width - line.spacing
        * (marks.width > 0 ? 3 : 2) - (root.overdue ? Style.space(16) : 0))
      height: Math.max(title.implicitHeight, renameField.visible ? renameField.implicitHeight : 0)

      Text {
        id: title
        anchors.verticalCenter: parent.verticalCenter
        width: parent.width
        visible: !root.renaming
        text: root.task ? root.task.title : ""
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        elide: Text.ElideRight
        textFormat: Text.PlainText
      }

      TextField {
        id: renameField
        anchors.verticalCenter: parent.verticalCenter
        width: parent.width
        visible: root.renaming
        enabled: !root.renameSending
        onAccepted: root.renameAccepted(text)
        // TextField carries no Escape handling of its own, and while the catcher is
        // blocked it only passes the key through — without this the user would be shut
        // inside the field with no way back to the list.
        Keys.onEscapePressed: root.renameCancelled()

        onVisibleChanged: {
          if (!visible) return
          text = root.task ? root.task.title : ""
          forceActiveFocus()
          selectAll()
        }
      }
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
  // movement. The click must still not reach the dismiss layer below, which would close
  // the popup — so it is consumed here and spent on the expansion instead.
  MouseArea {
    anchors.fill: parent
    hoverEnabled: true
    onPositionChanged: function(mouse) { root.pointerMoved(mouse) }
    onClicked: root.expandRequested()
  }

  // Declared last so it sits above the row-wide handler, which deliberately swallows every
  // click. Without this the checkbox would never see one — the row's own comment says the
  // swallowing is on purpose, and a checkbox placed inside the layout is not a drop-in.
  MouseArea {
    x: line.x + box.x
    y: line.y + box.y
    width: box.width
    height: box.height
    enabled: root.completable
    cursorShape: Qt.PointingHandCursor
    onClicked: root.completeRequested()
  }
}
