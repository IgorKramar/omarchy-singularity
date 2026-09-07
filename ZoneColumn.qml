import QtQuick
import qs.Commons
import qs.Ui

// One column of the overlay: a store stack or a day. Draws its cards and accepts drops.
Item {
  id: root

  property string title: ""
  property string zone: ""
  property int count: 0
  property var tasks: []
  property string cursorId: ""
  property var service: null
  property bool acceptsDrop: true

  signal cardActivated(string id)
  signal taskDropped(string id)

  readonly property bool dropHovered: root.acceptsDrop && dropArea.containsDrag

  Rectangle {
    anchors.fill: parent
    radius: Style.cornerRadius
    color: root.dropHovered ? Style.hoverFillFor(Color.menu.text, Color.accent)
      : Style.normalFillFor(Color.menu.text, Color.accent)
    border.width: root.dropHovered ? Style.hoverBorderWidth : Style.normalBorderWidth
    border.color: root.dropHovered ? Style.hoverBorderFor(Color.menu.text, Color.accent)
      : Style.normalBorderFor(Color.menu.text, Color.accent)
  }

  Column {
    anchors.fill: parent
    anchors.margins: Style.space(8)
    spacing: Style.space(6)

    Row {
      width: parent.width
      spacing: Style.space(6)

      Text {
        width: parent.width - counter.width - Style.space(6)
        text: root.title
        color: Color.menu.text
        textFormat: Text.PlainText
        elide: Text.ElideRight
        font.family: Style.font.family
        font.pixelSize: Style.font.small
        font.bold: true
      }

      Text {
        id: counter
        text: root.count
        color: Qt.darker(Color.menu.text, 1.6)
        font.family: Style.font.family
        font.pixelSize: Style.font.small
      }
    }

    ListView {
      width: parent.width
      height: parent.height - Style.space(24)
      clip: true
      spacing: Style.space(4)
      model: root.tasks
      // The list scrolls, the cursor does not follow the mouse wheel: position is keyboard
      // state, not viewport state.
      delegate: TaskCard {
        required property var modelData
        width: ListView.view.width
        task: modelData
        hasCursor: modelData.id === root.cursorId
        sending: root.service ? root.service.pendingIds.indexOf(modelData.id) !== -1 : false
        onActivated: root.cardActivated(modelData.id)
      }
    }
  }

  DropArea {
    id: dropArea
    anchors.fill: parent
    z: 20
    keys: ["singularity-task"]
    enabled: root.acceptsDrop
    onDropped: function(drop) {
      if (!root.acceptsDrop || !drop.source || !drop.source.task) { drop.accepted = false; return }
      drop.acceptProposedAction()
      root.taskDropped(drop.source.task.id)
    }
  }
}
