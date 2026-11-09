// Pure helpers for the Tek Audio Ports widget. Nothing here touches QML or a
// process: BarWidget.qml feeds pactl output in and renders what comes back, so
// every decision below is exercised by node --test without a running shell.

var GLYPH_HEADPHONES = "\u{f02cb}"
var GLYPH_HDMI = "\u{f0379}"
var GLYPH_SPEAKER = "\u{f04c3}"

function normalizePort(port) {
  var value = port || {}
  return {
    name: String(value.name || ""),
    description: String(value.description || ""),
    type: String(value.type || ""),
    profile: String(value.profile || ""),
    label: String(value.label || ""),
    priority: typeof value.priority === "number" ? value.priority : 0,
    availability: String(value.availability || "")
  }
}

// pactl -f json list sinks -> the one sink whose name matches. Malformed JSON,
// an empty document, or a missing sink all mean "nothing to show" (null), so
// the caller can fall back instead of throwing inside the shell.
function parseSink(jsonText, sinkName) {
  var text = String(jsonText || "").trim()
  if (!text) return null

  var sinks
  try {
    sinks = JSON.parse(text)
  } catch (error) {
    return null
  }
  if (!sinks || !sinks.length) return null

  var wanted = String(sinkName || "")
  for (var i = 0; i < sinks.length; i++) {
    var sink = sinks[i]
    if (!sink || String(sink.name || "") !== wanted) continue

    var ports = []
    var rawPorts = sink.ports && sink.ports.length ? sink.ports : []
    for (var p = 0; p < rawPorts.length; p++) {
      ports.push(normalizePort(rawPorts[p]))
    }

    var props = sink.properties || {}
    return {
      name: String(sink.name || ""),
      description: String(sink.description || ""),
      cardName: String(props["device.name"] || ""),
      deviceDescription: String(props["device.description"] || ""),
      activePort: String(sink.active_port || ""),
      ports: ports
    }
  }
  return null
}

// A port on the GPU's HDMI audio card. The audio transport is HDMI-protocol
// even for a DisplayPort cable, so this is what identifies a display output.
function isDisplayPort(port) {
  if (!port) return false
  return String(port.type || "").toLowerCase() === "hdmi"
}

function hasDisplayPorts(sink) {
  if (!sink) return false
  var list = sink.ports && sink.ports.length ? sink.ports : []
  for (var i = 0; i < list.length; i++) {
    if (isDisplayPort(list[i])) return true
  }
  return false
}

// pactl reports "not available" for a port with no cable in it. Everything
// else (including a missing field) is switchable.
function isAvailable(port) {
  if (!port) return true
  return String(port.availability || "") !== "not available"
}

// The description is what a person recognises ("Line Out"); the raw port name
// is the fallback so a row never renders blank.
function portLabel(port) {
  if (!port) return ""
  return String(port.description || port.name || "")
}

function glyphForText(text) {
  var lower = String(text || "").toLowerCase()
  if (lower.indexOf("headphone") !== -1 || lower.indexOf("headset") !== -1) return GLYPH_HEADPHONES
  if (lower.indexOf("hdmi") !== -1 || lower.indexOf("display") !== -1) return GLYPH_HDMI
  return GLYPH_SPEAKER
}

// A null port means "we do not know the port yet": fall back to the sink's own
// description so an HDMI-only output still shows an HDMI glyph.
function glyphFor(port, sinkDescription) {
  if (!port) return glyphForText(sinkDescription)
  return glyphForText(String(port.name || "") + " " + String(port.description || ""))
}

function rawIndex(ports, activeName) {
  var list = ports && ports.length ? ports : []
  for (var i = 0; i < list.length; i++) {
    if (list[i] && String(list[i].name || "") === String(activeName || "")) return i
  }
  return -1
}

// The next switchable port after the active one, wrapping once. Returns null
// when the only available port is the active one, so a right click is a no-op
// rather than a pointless re-apply.
function nextPort(ports, activeName) {
  var list = ports && ports.length ? ports : []
  if (!list.length) return null

  var current = rawIndex(list, activeName)
  var start = current === -1 ? 0 : current + 1
  for (var step = 0; step < list.length - 1; step++) {
    var index = (start + step) % list.length
    var port = list[index]
    if (index === current) continue
    if (isAvailable(port)) return String(port.name || "")
  }
  return null
}

// The row the cursor starts on. A stale active name still points at a real row
// (0) rather than nowhere; only an empty list has no row to point at.
function activeIndex(ports, activeName) {
  var list = ports && ports.length ? ports : []
  if (!list.length) return -1
  var index = rawIndex(list, activeName)
  return index === -1 ? 0 : index
}

function clampIndex(index, count) {
  if (!(count > 0)) return -1
  var value = typeof index === "number" && isFinite(index) ? Math.floor(index) : 0
  if (value < 0) return 0
  if (value > count - 1) return count - 1
  return value
}

if (typeof module !== "undefined") {
  module.exports = {
    parseSink: parseSink,
    isDisplayPort: isDisplayPort,
    hasDisplayPorts: hasDisplayPorts,
    isAvailable: isAvailable,
    portLabel: portLabel,
    glyphFor: glyphFor,
    nextPort: nextPort,
    activeIndex: activeIndex,
    clampIndex: clampIndex
  }
}
