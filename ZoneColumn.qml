import QtQuick
import qs.Commons
import qs.Ui

// One column of the overlay: a store stack or a day. Draws its cards and accepts drops.
//
// The column is the middle ground of three: the overlay behind it, the cards on top. Without
// that middle step twenty-one stacks read as one field of text.
Item {
  id: root

  property string title: ""
  property string zone: ""
  property int count: 0
  property var tasks: []
  property string cursorId: ""
  property string expandedId: ""
  property var service: null
  property bool acceptsDrop: true

  signal cardActivated(string id)
  signal taskDropped(string id)

  readonly property color ink: Color.menu.text
  readonly property color dim: Qt.darker(ink, 1.7)
  readonly property bool dropHovered: root.acceptsDrop && dropArea.containsDrag

  Rectangle {
    anchors.fill: parent
    radius: Style.cornerRadius
    // Sunk below the overlay's own ground, so the cards on top read as raised. Same ladder
    // in either theme: a recess is darker than what surrounds it whichever way round the
    // palette runs.
    color: root.dropHovered ? Style.hoverFillFor(root.ink, Color.accent)
      : Qt.darker(Color.menu.background, 1.25)
    border.width: root.dropHovered ? Math.max(1, Style.hoverBorderWidth) : Style.normalBorderWidth
    border.color: root.dropHovered ? Color.accent : Style.normalBorderFor(root.ink, Color.accent)
  }

  Item {
    anchors.fill: parent
    anchors.margins: Style.space(8)

    // Header: name on the left, count on the right. Small and upper-case so it reads as a
    // label rather than as another card.
    Item {
      id: header
      anchors.top: parent.top
      anchors.left: parent.left
      anchors.right: parent.right
      height: heading.implicitHeight

      Text {
        id: heading
        anchors.left: parent.left
        anchors.right: counter.left
        anchors.rightMargin: Style.space(6)
        text: root.title.toUpperCase()
        color: root.dim
        textFormat: Text.PlainText
        elide: Text.ElideRight
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        font.letterSpacing: 0.5
        font.bold: true
      }

      Text {
        id: counter
        anchors.right: parent.right
        anchors.baseline: heading.baseline
        text: root.count
        color: root.ink
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        font.bold: true
      }
    }

    ListView {
      anchors.top: header.bottom
      anchors.topMargin: Style.space(7)
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.bottom: parent.bottom
      clip: true
      spacing: Style.space(5)
      model: root.tasks

      // Nothing here yet, said outright: an empty column and a column that failed to load
      // look the same otherwise.
      Text {
        anchors.top: parent.top
        anchors.left: parent.left
        visible: root.tasks.length === 0
        text: "пусто"
        color: root.dim
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }

      // The list scrolls, the cursor does not follow the mouse wheel: position is keyboard
      // state, not viewport state.
      delegate: TaskCard {
        required property var modelData
        width: ListView.view.width
        task: modelData
        hasCursor: modelData.id === root.cursorId
        expanded: modelData.id === root.expandedId
        // Read straight off the property, not through service.checklistFor(): a binding
        // tracks the properties it reads, and a value arriving through a method call leaves
        // it with nothing to depend on — the card kept saying "нет пунктов" while the cache
        // held the items.
        checklist: root.service && root.expandedId === modelData.id
          ? (root.service.checklists[modelData.id] || []) : []
        pendingItems: root.service ? root.service.checklistPending : []
        sending: root.service ? root.service.pendingIds.indexOf(modelData.id) !== -1 : false
        onActivated: root.cardActivated(modelData.id)
        onItemToggled: function(itemId) {
          if (root.service) root.service.toggleChecklistItem(modelData.id, itemId)
        }
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
