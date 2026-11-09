pragma ComponentBehavior: Bound
import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Bar glyph for the current output port: left click opens the port list,
// right click cycles to the next switchable port without opening it.
//
// This widget owns every pactl process and is the only source of state: the
// panel is a Loader over Panel.qml and reads the properties below. The port
// list is stored as primitives, never as live PipeWire objects, so a node
// disappearing mid-refresh cannot dangle inside a delegate.
BarWidget {
  id: root
  moduleName: "io.github.erwinpagulong.omatek-audio-ports"

  // The default sink as pactl reports it. When it exposes no ports (a DSP
  // sink such as easyeffects_sink) resolverProc resolves the physical output
  // beneath it and sinkName becomes that sink instead — the one whose ports
  // are listed and the one set-sink-port must address.
  property string defaultSink: ""
  property string sinkName: ""
  property string sinkDescription: ""
  property string activePort: ""
  property var ports: []
  // True once a sink has been resolved. A sink with no ports (or only one)
  // keeps the glyph visible so the bar does not shift when the default output
  // changes; only "pactl returned nothing" hides the widget entirely.
  property bool ready: false

  // Display-audio state. A GPU sink exposes one port per card profile, so the
  // card supplies the other live connectors and monitors supplies their cable
  // labels. All three stay empty for analog/USB sinks.
  property string cardName: ""
  property string deviceDescription: ""
  property string activeProfile: ""
  property var parsedSink: null
  property var parsedCard: null
  property bool displayApplyPending: false
  // Set when a selection switches the card profile; the next sink read finds
  // the sink the switch created and makes it the default.
  property string pendingCard: ""
  property string pendingDefaultPort: ""

  property bool refreshPending: false
  property string sinkListJson: ""

  readonly property string glyph: Model.glyphFor(root.activePortObject, root.sinkDescription)

  readonly property var activePortObject: {
    var list = root.ports || []
    for (var i = 0; i < list.length; i++) {
      if (list[i] && String(list[i].name || "") === root.activePort) return list[i]
    }
    return null
  }

  // "<sink description> — <port description>", with the sink alone when the
  // port has no label. An empty port description already falls back to its
  // name inside Model.portLabel, so this never renders a bare dash.
  readonly property string tooltip: {
    var label = Model.portLabel(root.activePortObject)
    var sink = (root.activeProfile !== "" ? root.deviceDescription : root.sinkDescription) || root.sinkName
    if (sink === "") return label
    if (label === "") return sink
    return sink + " — " + label
  }

  // For a display sink the raw description says "(HDMI)" even on a
  // DisplayPort cable because the audio transport is HDMI-protocol, so name
  // the active cable and monitor instead.
  readonly property string headerText: {
    if (root.activeProfile !== "" && root.deviceDescription !== "") {
      var label = Model.portLabel(root.activePortObject)
      return label === "" ? root.deviceDescription : root.deviceDescription + " — " + label
    }
    return root.sinkDescription
  }

  readonly property string preferenceFile:
    (Quickshell.env("XDG_CONFIG_HOME") || (Quickshell.env("HOME") + "/.config")) + "/omarchy/audio-output-port"

  // ---- Panel shape contract for shell.summon/hide/toggle routing ----------
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function toggle() { if (panelLoader.item) panelLoader.item.toggle() }
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  // ---- pactl: default sink -> its port list -> optional resolver ----------

  function refresh() {
    if (defaultSinkProc.running || listSinksProc.running || listCardsProc.running
        || monitorsProc.running || resolverProc.running) {
      root.refreshPending = true
      return
    }
    root.refreshPending = false
    chainTimer.restart()
    defaultSinkProc.running = true
  }

  function finishRefresh() {
    chainTimer.stop()
    if (root.refreshPending) {
      root.refreshPending = false
      // Deferred: the process still reports running while it signals the end
      // of its stream, so calling refresh() here would bounce off the guard.
      Qt.callLater(root.refresh)
    }
  }

  function applySink(sink, portsOverride) {
    if (!sink) {
      root.clearSink()
      return
    }
    root.sinkName = sink.name || root.defaultSink
    root.sinkDescription = sink.description || sink.name || ""
    root.cardName = sink.cardName || ""
    root.deviceDescription = sink.deviceDescription || ""
    root.activePort = sink.activePort || ""
    root.ports = portsOverride || sink.ports || []
    // Set again by the display path after the merge; clearing it here keeps an
    // analog sink from inheriting a stale display profile.
    root.activeProfile = ""
    root.ready = true
  }

  // A display sink needs one more read (its card) and one more (the monitors)
  // before it can be applied. Everything else is applied right away.
  function presentSink(sink) {
    if (!sink) {
      root.clearSink()
      root.finishRefresh()
      return
    }
    root.parsedSink = sink
    if (Model.hasDisplayPorts(sink) && sink.cardName !== "") {
      root.displayApplyPending = false
      listCardsProc.running = true
      return
    }
    root.parsedCard = null
    root.applySink(sink)
    root.finishRefresh()
  }

  function finishDisplayApply(monitorJson) {
    if (!root.displayApplyPending || !root.parsedSink || !root.parsedCard) return
    root.displayApplyPending = false
    var monitors = Model.parseMonitors(monitorJson)
    var labels = Model.labelDisplayPorts(root.parsedCard.ports, monitors)
    var merged = Model.mergeDisplayPorts(root.parsedSink, root.parsedCard, labels)
    root.applySink(root.parsedSink, merged)
    root.activeProfile = root.parsedCard.activeProfile
    root.finishRefresh()
  }

  // No sink to show: render nothing and take no width.
  function clearSink() {
    root.sinkName = ""
    root.sinkDescription = ""
    root.cardName = ""
    root.deviceDescription = ""
    root.activeProfile = ""
    root.parsedSink = null
    root.parsedCard = null
    root.displayApplyPending = false
    root.activePort = ""
    root.ports = []
    root.ready = false
  }

  function selectPort(portName) {
    if (root.sinkName === "" || !portName) return
    var list = root.ports || []
    var port = null
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].name || "") === String(portName)) { port = list[i]; break }
    }
    var profile = port ? String(port.profile || "") : ""
    if (profile !== "" && profile !== root.activeProfile && root.cardName !== "") {
      // A port on another profile only exists after the card switches to it;
      // the resulting sink is made default on the next read.
      root.pendingCard = root.cardName
      root.pendingDefaultPort = String(portName)
      pendingTimer.restart()
      Quickshell.execDetached(["pactl", "set-card-profile", root.cardName, profile])
    } else {
      Quickshell.execDetached(["pactl", "set-sink-port", root.sinkName, String(portName)])
    }
    // Best effort persistence, inert on machines that do not read it. A
    // heredoc-free printf keeps the port name exactly as pactl knows it.
    Quickshell.execDetached(["sh", "-c", "printf '%s\\n' \"$1\" > \"$2\"", "sh", String(portName), root.preferenceFile])
    debounce.restart()
  }

  function cycle() {
    var next = Model.nextPort(root.ports, root.activePort)
    if (next) root.selectPort(next)
  }

  implicitWidth: root.ready ? button.implicitWidth : 0
  implicitHeight: root.ready ? button.implicitHeight : 0

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  // get-default-sink is the entry point. A failed or missing pactl emits no
  // exit; chainTimer below keeps the chain from wedging in that case.
  Process {
    id: defaultSinkProc
    command: ["pactl", "get-default-sink"]
    stdout: StdioCollector {
      id: defaultSinkOut
      waitForEnd: true
      // Read the collector at stream end, the way the shell's own processes
      // do: the text is complete here even though the process still reports
      // running while it signals exit.
      onStreamFinished: root.defaultSink = String(text || "").trim()
    }
    onExited: listSinksProc.running = true
  }

  Process {
    id: listSinksProc
    command: ["pactl", "-f", "json", "list", "sinks"]
    stdout: StdioCollector {
      id: listSinksOut
      waitForEnd: true
      onStreamFinished: {
        root.sinkListJson = String(text || "")
        if (root.pendingDefaultPort !== "") {
          var target = Model.findSinkByPort(root.sinkListJson, root.pendingCard, root.pendingDefaultPort)
          if (target !== "") {
            if (target !== root.defaultSink) Quickshell.execDetached(["pactl", "set-default-sink", target])
            root.defaultSink = target
            root.pendingCard = ""
            root.pendingDefaultPort = ""
            pendingTimer.stop()
          }
        }
        var sink = Model.parseSink(root.sinkListJson, root.defaultSink)
        if (sink && sink.ports.length > 0) {
          root.presentSink(sink)
        } else if (root.defaultSink !== "") {
          resolverProc.running = true
        } else {
          root.presentSink(null)
        }
      }
    }
  }

  // The active profile only creates a sink for its own port, so the card is
  // the only place the other display connectors are visible. Read-only.
  Process {
    id: listCardsProc
    command: ["pactl", "-f", "json", "list", "cards"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var card = Model.parseCard(String(text || ""), root.parsedSink ? root.parsedSink.cardName : "")
        if (!card) {
          root.parsedCard = null
          root.applySink(root.parsedSink)
          root.finishRefresh()
          return
        }
        root.parsedCard = card
        root.displayApplyPending = true
        monitorsProc.running = true
      }
    }
  }

  // hyprctl gives the connector type and model of each active display, which
  // is how a card port becomes "DisplayPort · VG271U M3". If it cannot run,
  // finishDisplayApply still applies the card descriptions.
  Process {
    id: monitorsProc
    command: ["hyprctl", "monitors", "-j"]
    stdout: StdioCollector {
      id: monitorsOut
      waitForEnd: true
      onStreamFinished: root.finishDisplayApply(String(text || ""))
    }
    onExited: root.finishDisplayApply(String(monitorsOut.text || ""))
  }

  // Read-only fallback that names the physical output under a virtual DSP
  // sink. If it cannot resolve one either, the sink we already parsed (with
  // zero ports) is still worth showing: the glyph reflects the device class
  // and the panel explains that there is nothing to switch.
  Process {
    id: resolverProc
    command: ["omarchy-audio-output-sink"]
    stdout: StdioCollector {
      id: resolverOut
      waitForEnd: true
      onStreamFinished: {
        var resolved = String(text || "").trim()
        var sink = resolved !== "" ? Model.parseSink(root.sinkListJson, resolved) : null
        root.presentSink(sink || Model.parseSink(root.sinkListJson, root.defaultSink))
      }
    }
  }

  // One subscription for every sink/server/card change, debounced so a burst
  // of events results in one refresh. PulseAudio restarting kills the
  // process; the resubscribe timer brings it back and the refresh recovers
  // the state.
  Process {
    id: subscribeProc
    command: ["pactl", "subscribe"]
    running: true
    stdout: SplitParser {
      onRead: function(line) {
        if (/ on (sink|server|card)/.test(line)) debounce.restart()
      }
    }
    onExited: resubscribe.restart()
  }

  Timer {
    id: debounce
    interval: 120
    onTriggered: root.refresh()
  }

  // A profile that refuses to switch, or a sink that never appears, must not
  // leave the widget waiting for a default forever.
  Timer {
    id: pendingTimer
    interval: 5000
    onTriggered: {
      root.pendingCard = ""
      root.pendingDefaultPort = ""
      root.displayApplyPending = false
    }
  }

  Timer {
    id: resubscribe
    interval: 2000
    onTriggered: subscribeProc.running = true
  }

  // Watchdog for a pactl that is missing or refuses to start: no exited
  // signal arrives then, and the chain would otherwise stay pending forever.
  Timer {
    id: chainTimer
    interval: 3000
    onTriggered: {
      if (defaultSinkProc.running || listSinksProc.running || listCardsProc.running
          || monitorsProc.running || resolverProc.running) return
      root.finishRefresh()
    }
  }

  WidgetButton {
    id: button
    anchors.fill: root
    bar: root.bar
    text: root.ready ? root.glyph : ""
    tooltipText: root.tooltip
    // No wheel handling: the audio widget next door owns wheel = volume.
    onPressed: function(code) {
      if (code === Qt.RightButton) root.cycle()
      else root.toggle()
    }
  }

  Component.onCompleted: root.refresh()
}
