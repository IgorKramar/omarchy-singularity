import QtQuick

// Placeholder: the full-screen overlay arrives with SNG-4. It exists so the manifest
// validates and loads, and answers the shell's summon/hide contract without drawing.
Item {
  id: root

  property var shell: null
  property var manifest: null
  property var service: null
  property bool opened: false

  implicitWidth: 0
  implicitHeight: 0

  function open(payloadJson) { opened = true }
  function close() { opened = false }
  function toggle() { opened = !opened }
}
