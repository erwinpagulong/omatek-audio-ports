pragma ComponentBehavior: Bound
import QtQuick
import Quickshell
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import qs.Ui as Ui
import "Model.js" as Model

// The port list for the current output sink. BarWidget.qml owns every pactl
// process and this panel only reads its snapshots and asks it to switch; the
// bar-widget contract (open/close/opened/anchorItem/hostWidget) is what lets
// the shell summon and hide this panel from IPC.
//
// The base type is qualified through a Ui alias on purpose: this file is
// itself Panel.qml, so a bare `Panel` resolves to the file being linted.
Ui.Panel {
  id: root
  moduleName: "io.github.erwinpagulong.omatek-audio-ports"
  manageIpc: false

  property var anchorItem: null
  // The bar widget mounted in the slot; the popout coordinator and
  // switchPanelFrom must identify the panel by that widget, not by this
  // nested Loader item.
  property var hostWidget: null
  property int cursorIndex: -1

  readonly property var barIdentity: hostWidget || root
  readonly property var ports: hostWidget ? hostWidget.ports : []
  readonly property string activePortName: hostWidget ? String(hostWidget.activePort || "") : ""
  // The cursor is always resolved against the current list, so a sink switch
  // that shrinks the ports mid-open can never index past the end.
  readonly property int safeCursor: Model.clampIndex(root.cursorIndex, root.ports.length)

  readonly property color hoverFill: bar
    ? Style.hoverFillFor(bar.foreground, Commons.Color.accent)
    : "transparent"
  readonly property color selectedFill: bar
    ? Style.selectedFillFor(bar.foreground, Commons.Color.accent)
    : "transparent"

  Commons.Translations {
    id: strings
    directory: Qt.resolvedUrl("i18n")
  }

  function open() {
    root.controller.show()
    root.syncCursor()
    // The port list is refreshed when the panel opens, not only on a
    // subscribe event, so the first open after a resume is never stale.
    if (root.hostWidget && typeof root.hostWidget.refresh === "function") root.hostWidget.refresh()
  }

  function close() {
    root.controller.hide()
  }

  function switchPanel(direction) {
    return root.bar && typeof root.bar.switchPanelFrom === "function"
      ? root.bar.switchPanelFrom(root.barIdentity, direction)
      : false
  }

  function syncCursor() {
    root.cursorIndex = Model.activeIndex(root.ports, root.activePortName)
  }

  function moveCursor(delta) {
    var count = root.ports.length
    if (count === 0) return
    root.cursorIndex = Model.clampIndex(root.safeCursor + delta, count)
  }

  function activate() {
    var index = root.safeCursor
    if (index < 0) return
    var port = root.ports[index]
    if (!port || !Model.isAvailable(port)) return
    if (root.hostWidget) root.hostWidget.selectPort(String(port.name || ""))
    root.close()
  }

  Connections {
    target: root.hostWidget
    ignoreUnknownSignals: true
    function onPortsChanged() { if (root.opened) root.syncCursor() }
    function onActivePortChanged() { if (root.opened) root.syncCursor() }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(300))
    contentHeight: panel.fittedContentHeight(content.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      implicitHeight: content.implicitHeight

      onMoveRequested: function(dx, dy) {
        if (dy !== 0) root.moveCursor(dy)
      }
      onActivateRequested: root.activate()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: content
        width: parent.width
        spacing: Style.space(6)

        PanelSectionHeader {
          text: strings.t("ports.title")
          foreground: root.barForeground
          fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
        }

        Text {
          textFormat: Text.PlainText
          width: parent.width
          visible: root.hostWidget ? String(root.hostWidget.sinkDescription || "") !== "" : false
          text: root.hostWidget ? String(root.hostWidget.sinkDescription || "") : ""
          color: Qt.darker(root.barForeground, 1.4)
          font.family: root.bar ? root.bar.fontFamily : Style.font.family
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }

        PanelSeparator {
          foreground: root.barForeground
        }

        Text {
          textFormat: Text.PlainText
          width: parent.width
          visible: root.ports.length < 2
          text: root.ports.length === 0 ? strings.t("ports.none") : strings.t("ports.single")
          color: Qt.darker(root.barForeground, 1.4)
          font.family: root.bar ? root.bar.fontFamily : Style.font.family
          font.pixelSize: Style.font.body
          wrapMode: Text.WordWrap
        }

        Repeater {
          model: root.ports

          CursorSurface {
            id: portRow
            required property var modelData
            required property int index

            readonly property bool portAvailable: Model.isAvailable(portRow.modelData)

            width: parent.width
            implicitHeight: rowInner.implicitHeight + Style.spacing.xl
            hasCursor: portRow.index === root.safeCursor
            current: String(portRow.modelData.name || "") === root.activePortName
            foreground: root.barForeground
            fill: root.hoverFill
            currentFill: root.selectedFill
            // A port with no cable in it is readable but not switchable.
            opacity: portRow.portAvailable ? 1 : 0.5

            Row {
              id: rowInner
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: Style.space(6)
              anchors.rightMargin: Style.space(6)
              spacing: Style.space(8)

              Text {
                textFormat: Text.PlainText
                text: Model.glyphFor(portRow.modelData, "")
                color: root.barForeground
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.title
                width: Style.space(22)
                horizontalAlignment: Text.AlignHCenter
                anchors.verticalCenter: parent.verticalCenter
              }

              Text {
                textFormat: Text.PlainText
                text: Model.portLabel(portRow.modelData)
                color: root.barForeground
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.body
                font.bold: portRow.current
                elide: Text.ElideRight
                anchors.verticalCenter: parent.verticalCenter
                width: parent.width - Style.space(22) - Style.space(8) - trailing.width
                  - (trailing.width > 0 ? Style.space(8) : 0)
              }

              Row {
                id: trailing
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(6)

                Text {
                  textFormat: Text.PlainText
                  visible: !portRow.portAvailable
                  text: strings.t("ports.unavailable")
                  color: Qt.darker(root.barForeground, 1.5)
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.caption
                  anchors.verticalCenter: parent.verticalCenter
                }

                Text {
                  textFormat: Text.PlainText
                  visible: portRow.current
                  text: "✓"
                  color: root.barForeground
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.body
                  anchors.verticalCenter: parent.verticalCenter
                }
              }
            }

            MouseArea {
              anchors.fill: parent
              hoverEnabled: true
              enabled: portRow.portAvailable
              cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
              onEntered: root.cursorIndex = portRow.index
              onPositionChanged: root.cursorIndex = portRow.index
              onClicked: {
                root.cursorIndex = portRow.index
                root.activate()
              }
            }
          }
        }
      }
    }
  }
}
