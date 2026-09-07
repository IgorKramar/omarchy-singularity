import QtQuick
import qs.Commons
import qs.Ui
import "Api.mjs" as Api

// One card in the overlay. Smaller than TaskRow — the overlay shows hundreds at once — and
// carrying the one thing a row never needed: it can be picked up and dropped somewhere else.
//
// It draws its own plate rather than sitting on the column's background. With two hundred
// titles on screen, "where does this card end and the next begin" is the whole of legibility:
// the first version left the plate to the cursor alone and read as a wall of text.
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

  readonly property color dim: Qt.darker(foreground, 1.7)
  // The scale is inverted in this API (0 = high), which is why the question is asked in
  // Api.mjs and not here.
  readonly property bool urgent: task ? Api.isHighPriority(task.priority) : false
  readonly property string deadlineLabel: {
    if (!task || !task.deadline) return ""
    var d = new Date(task.deadline)
    return isNaN(d.getTime()) ? "" : d.toLocaleDateString(Qt.locale("ru_RU"), "d MMM")
  }
  readonly property bool dragging: dragHandler.active
  readonly property bool hot: hover.hovered

  implicitHeight: Math.max(Style.space(26), body.implicitHeight + Style.space(10))

  Rectangle {
    id: plate
    anchors.fill: parent
    radius: Style.cornerRadius
    // Three levels of ground, as in the mock-up: the overlay, the column, and this. Each
    // step is an alpha over the same foreground, so both themes keep the same ladder.
    color: root.hasCursor ? Style.selectedFillFor(root.foreground, Color.accent)
      : root.dragging || root.hot ? Style.hoverFillFor(root.foreground, Color.accent)
      : Style.normalFillFor(root.foreground, Color.accent)
    border.width: root.hasCursor ? Math.max(1, Style.selectedBorderWidth) : Style.normalBorderWidth
    border.color: root.hasCursor ? Color.accent
      : Style.normalBorderFor(root.foreground, Color.accent)
    opacity: root.sending ? 0.45 : 1.0
  }

  Row {
    id: body
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    anchors.leftMargin: Style.space(7)
    anchors.rightMargin: Style.space(7)
    spacing: Style.space(5)

    // Named as well as coloured: the mark still reads without colour vision.
    Text {
      id: bang
      visible: root.urgent
      anchors.top: parent.top
      text: "!"
      color: Color.urgent
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      font.bold: true
    }

    Text {
      id: label
      width: body.width - (bang.visible ? bang.width + body.spacing : 0)
        - (deadline.visible ? deadline.width + body.spacing : 0)
      text: root.task ? root.task.title : ""
      color: root.foreground
      // Plain text on purpose: a title carrying markup is a title, not markup.
      textFormat: Text.PlainText
      elide: Text.ElideRight
      maximumLineCount: 2
      wrapMode: Text.Wrap
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
    }

    Text {
      id: deadline
      visible: root.deadlineLabel !== ""
      anchors.top: parent.top
      text: root.deadlineLabel
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }

  HoverHandler { id: hover }

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
