import QtQuick
import qs.Commons
import qs.Ui
import "Api.mjs" as Api

// One card in the overlay. Smaller than TaskRow — the overlay shows hundreds at once — and
// carrying the one thing a row never needed: it can be picked up and dropped somewhere else.
Item {
  id: root

  required property var task
  property bool hasCursor: false
  // Sent and waiting. The card stays where it is until the answer arrives: moving it on
  // hope and moving it back on failure is two lies where one wait would do.
  property bool sending: false
  property bool movable: true
  property color foreground: Color.menu.text
  property string fontFamily: Style.font.family

  signal activated()
  signal dragStarted()
  signal dragFinished()

  readonly property color dim: Qt.darker(foreground, 1.6)
  // The scale is inverted in this API (0 = high), which is why the question is asked in
  // Api.mjs and not here.
  readonly property bool urgent: task ? Api.isHighPriority(task.priority) : false
  readonly property string deadlineLabel: {
    if (!task || !task.deadline) return ""
    var d = new Date(task.deadline)
    return isNaN(d.getTime()) ? "" : d.toLocaleDateString(Qt.locale("ru_RU"), "d MMM")
  }
  readonly property bool dragging: dragHandler.active

  implicitHeight: line.implicitHeight + Style.space(10)

  Rectangle {
    anchors.fill: parent
    radius: Style.cornerRadius
    color: root.hasCursor ? Style.selectedFillFor(root.foreground, Color.accent)
      : root.dragging ? Style.hoverFillFor(root.foreground, Color.accent) : "transparent"
    border.width: root.hasCursor ? Style.selectedBorderWidth : 0
    border.color: Style.selectedBorderFor(root.foreground, Color.accent)
    opacity: root.sending ? 0.5 : 1.0
  }

  Row {
    id: line
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    anchors.leftMargin: Style.space(8)
    anchors.rightMargin: Style.space(8)
    spacing: Style.space(6)

    // Named as well as coloured: the mark still reads without colour vision.
    Text {
      visible: root.urgent
      anchors.verticalCenter: parent.verticalCenter
      text: "!"
      color: Color.urgent
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      font.bold: true
    }

    Text {
      id: label
      width: line.width - (root.urgent ? Style.space(12) : 0)
        - (deadline.visible ? deadline.width + line.spacing : 0)
      anchors.verticalCenter: parent.verticalCenter
      text: root.task ? root.task.title : ""
      color: root.foreground
      // Plain text on purpose: a title carrying markup is a title, not markup.
      textFormat: Text.PlainText
      elide: Text.ElideRight
      maximumLineCount: 2
      wrapMode: Text.Wrap
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
    }

    Text {
      id: deadline
      visible: root.deadlineLabel !== ""
      anchors.verticalCenter: parent.verticalCenter
      text: root.deadlineLabel
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.small
    }
  }

  MouseArea {
    anchors.fill: parent
    acceptedButtons: Qt.LeftButton
    cursorShape: root.dragging ? Qt.ClosedHandCursor
      : root.movable ? Qt.OpenHandCursor : Qt.ArrowCursor
    onClicked: root.activated()
  }

  // The one drag-and-drop pattern that works in this shell: a DragHandler with no target,
  // and a proxy Item that carries the Drag attached properties. MouseArea.drag is used
  // nowhere in the shell and does not compose with DropArea the same way.
  DragHandler {
    id: dragHandler
    acceptedButtons: Qt.LeftButton
    enabled: root.movable && !root.sending
    target: null
    dragThreshold: Style.space(6)
    onActiveChanged: {
      if (active) {
        proxy.session = true
        root.dragStarted()
      } else if (proxy.session) {
        proxy.Drag.drop()
        proxy.session = false
        root.dragFinished()
      }
    }
  }

  Item {
    id: proxy
    property bool session: false
    width: 1
    height: 1
    x: dragHandler.active ? dragHandler.centroid.position.x : 0
    y: dragHandler.active ? dragHandler.centroid.position.y : 0
    Drag.active: proxy.session
    Drag.source: root
    Drag.keys: ["singularity-task"]
    Drag.supportedActions: Qt.MoveAction
    Drag.proposedAction: Qt.MoveAction
  }
}
