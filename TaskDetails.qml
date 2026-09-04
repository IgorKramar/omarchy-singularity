import QtQuick
import qs.Commons
import qs.Ui
import "Api.mjs" as Api

// What a task holds beyond its title: the note, the fields that carry a value, and the way
// out to the web app. Shown under the row that owns it, one at a time.
//
// Everything here is plain text for the same reason the row is (R28): a note written in
// the web app is a note, not markup, and Text would happily parse it into links.
Column {
  id: root

  required property var task
  property color foreground: Color.foreground
  property string fontFamily: Style.font.family

  signal openRequested(string url)

  readonly property color dim: Qt.darker(foreground, 1.6)
  readonly property var note: Api.parseNote(root.task ? root.task.note : "")
  readonly property var fields: Api.taskFields(root.task, new Date())
  readonly property var web: Api.taskWebUrl(root.task)

  // Qt.locale, not the engine's toLocaleDateString with Intl options: the latter silently
  // ignores them here and prints "04.09.2026" beside a Russian interface. The row formats
  // its deadline the same way, for the same reason.
  function formatField(f) {
    if (f.kind !== "date") return f.value
    var d = new Date(f.value)
    return isNaN(d.getTime()) ? String(f.value) : d.toLocaleDateString(Qt.locale("ru_RU"), "d MMMM")
  }

  spacing: Style.space(6)
  topPadding: Style.space(2)
  bottomPadding: Style.space(8)
  leftPadding: Style.space(10) + Style.space(13) + Style.space(8)   // under the title, past the checkbox
  rightPadding: Style.space(10)

  // The note is the reason to open a task at all, so it comes first and whole — no elide,
  // no line cap. A task with a long note is a task whose note you wanted to read.
  Text {
    width: root.width - root.leftPadding - root.rightPadding
    visible: root.note.state !== "empty"
    text: root.note.text
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.Wrap
    textFormat: Text.PlainText
  }

  // An unreadable note is said out loud. Dropping it silently would draw the same empty
  // space as a task with no note — a confident wrong answer where a visible failure costs
  // one line.
  Text {
    visible: root.note.state === "unparsed"
    text: "— заметку не удалось разобрать, показана как есть"
    color: root.dim
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
    textFormat: Text.PlainText
  }

  Repeater {
    model: root.fields

    Row {
      id: field
      required property var modelData
      spacing: Style.space(6)

      Text {
        text: field.modelData.label
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        textFormat: Text.PlainText
      }

      Text {
        text: root.formatField(field.modelData)
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        textFormat: Text.PlainText
      }
    }
  }

  // The label names what actually opens. A per-task route was never established, so for a
  // task in a project this lands on the project and for one without it lands on the app —
  // and saying "открыть задачу" either time would be a promise the link does not keep.
  Row {
    spacing: Style.space(6)

    PanelActionButton {
      anchors.verticalCenter: parent.verticalCenter
      iconText: ""
      tooltipText: root.web.url
      foreground: root.foreground
      fontFamily: root.fontFamily
      onClicked: root.openRequested(root.web.url)
    }

    Text {
      anchors.verticalCenter: parent.verticalCenter
      text: root.web.kind === "project" ? "проект в вебе" : "веб-версия"
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      textFormat: Text.PlainText
    }
  }
}
