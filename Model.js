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

// pactl -f json list cards -> the card whose name matches. A display-audio
// card lists one port per physical connector, but PipeWire only creates a
// sink for the active profile: this is where the other connector's output
// lives. Card ports arrive as an object keyed by port name.
function parseCard(jsonText, cardName) {
  var text = String(jsonText || "").trim()
  if (!text) return null

  var cards
  try {
    cards = JSON.parse(text)
  } catch (error) {
    return null
  }
  if (!cards || !cards.length) return null

  var wanted = String(cardName || "")
  for (var i = 0; i < cards.length; i++) {
    var card = cards[i]
    if (!card || String(card.name || "") !== wanted) continue

    var profiles = {}
    var rawProfiles = card.profiles || {}
    var profileNames = Object.keys(rawProfiles)
    for (var p = 0; p < profileNames.length; p++) {
      var rawProfile = rawProfiles[profileNames[p]] || {}
      profiles[profileNames[p]] = {
        description: String(rawProfile.description || ""),
        available: rawProfile.available === true
      }
    }

    var ports = []
    var rawPorts = card.ports || {}
    var portNames = Object.keys(rawPorts)
    for (var k = 0; k < portNames.length; k++) {
      var rawPort = rawPorts[portNames[k]] || {}
      var props = rawPort.properties || {}
      ports.push({
        name: portNames[k],
        description: String(rawPort.description || ""),
        type: String(rawPort.type || ""),
        priority: typeof rawPort.priority === "number" ? rawPort.priority : 0,
        availability: String(rawPort.availability || ""),
        productName: String(props["device.product.name"] || ""),
        profiles: rawPort.profiles && rawPort.profiles.length ? rawPort.profiles.map(String) : []
      })
    }

    return {
      name: String(card.name || ""),
      activeProfile: String(card.active_profile || ""),
      ports: ports,
      profiles: profiles
    }
  }
  return null
}

// The stereo output profile of a connector; a surround variant is a last
// resort. Keeping the active profile when the port offers it makes the sink's
// own row a no-op instead of a pointless re-apply.
function chooseProfile(port, card, activeProfile) {
  if (!port || !card) return ""
  var declared = port.profiles && port.profiles.length ? port.profiles : []
  var candidates = []
  for (var i = 0; i < declared.length; i++) {
    var name = String(declared[i] || "")
    if (!name) continue
    var profile = card.profiles ? card.profiles[name] : null
    if (profile && profile.available === true) candidates.push(name)
  }

  var active = String(activeProfile || "")
  if (active !== "" && candidates.indexOf(active) !== -1) return active

  for (var s = 0; s < candidates.length; s++) {
    if (candidates[s].indexOf("surround") === -1) return candidates[s]
  }
  return candidates.length ? candidates[0] : ""
}

// hyprctl monitors -j -> the connector and model of each active display.
// Omarchy always has Hyprland; when it is unavailable the list is empty and
// display rows fall back to the card's own description.
function parseMonitors(jsonText) {
  var text = String(jsonText || "").trim()
  if (!text) return []

  var monitors
  try {
    monitors = JSON.parse(text)
  } catch (error) {
    return []
  }
  if (!monitors || !monitors.length) return []

  var result = []
  for (var i = 0; i < monitors.length; i++) {
    var monitor = monitors[i]
    if (!monitor) continue
    result.push({
      connector: String(monitor.name || ""),
      model: String(monitor.model || "")
    })
  }
  return result
}

function cableForConnector(connector) {
  var value = String(connector || "")
  if (/^DP([-_]|$)/i.test(value)) return "DisplayPort"
  if (/^HDMI/i.test(value)) return "HDMI"
  if (/^DVI/i.test(value)) return "DVI"
  if (/^USB[-_]?C/i.test(value)) return "USB-C"
  return ""
}

function normalizeModel(value) {
  return String(value || "").trim().toLowerCase()
}

// Card port product name (from the connector's ELD) matched against the
// Hyprland monitor model gives the cable type. Each monitor is used once, so
// two identical monitors cannot both claim the same row: the unmatched one
// falls back to the card description instead of showing a wrong cable.
function labelDisplayPorts(cardPorts, monitors) {
  var labels = {}
  var list = cardPorts && cardPorts.length ? cardPorts : []
  var displays = monitors && monitors.length ? monitors : []
  var used = []

  // Two identical monitors make the model ambiguous: matching them by order
  // could hand a port the wrong cable. Count the product names first and only
  // label a port when its model identifies exactly one connector.
  var counts = {}
  for (var c = 0; c < list.length; c++) {
    if (!isDisplayPort(list[c])) continue
    var key = normalizeModel(list[c].productName)
    if (key === "") continue
    counts[key] = (counts[key] || 0) + 1
  }

  for (var i = 0; i < list.length; i++) {
    var port = list[i]
    if (!isDisplayPort(port)) continue

    var product = normalizeModel(port.productName)
    var match = null
    if (product !== "" && counts[product] === 1 && isAvailable(port)) {
      for (var m = 0; m < displays.length; m++) {
        if (used[m]) continue
        if (normalizeModel(displays[m].model) !== product) continue
        used[m] = true
        match = displays[m]
        break
      }
    }

    if (match) {
      var cable = cableForConnector(match.connector)
      labels[port.name] = cable === "" ? match.model : cable + " · " + match.model
    } else {
      labels[port.name] = String(port.description || port.name || "")
    }
  }
  return labels
}

// A display sink only shows the port of its active profile, so the card's
// other available connectors are merged in here. Non-display sinks (analog,
// USB) and sinks whose card cannot be matched come back exactly as they were.
function mergeDisplayPorts(sink, card, labels) {
  var sinkPorts = sink && sink.ports ? sink.ports : []
  if (!sink || !card) return sinkPorts
  if (String(card.name || "") !== String(sink.cardName || "")) return sinkPorts
  if (!hasDisplayPorts(sink)) return sinkPorts

  var byName = {}
  for (var i = 0; i < sinkPorts.length; i++) byName[sinkPorts[i].name] = sinkPorts[i]

  var merged = []
  var seen = {}
  var active = String(sink.activePort || "")
  var cardPorts = card.ports && card.ports.length ? card.ports : []
  for (var p = 0; p < cardPorts.length; p++) {
    var port = cardPorts[p]
    if (!isDisplayPort(port)) continue
    // Only live outputs are offered; the sink's own active port stays even if
    // the card marks it unavailable for a moment, so the current row cannot
    // vanish from under the cursor during a hotplug.
    if (!isAvailable(port) && port.name !== active) continue
    if (seen[port.name]) continue
    seen[port.name] = true

    var live = byName[port.name]
    merged.push({
      name: port.name,
      description: String((live && live.description) || port.description || ""),
      type: port.type,
      priority: typeof port.priority === "number" ? port.priority : 0,
      availability: String(port.availability || ""),
      profile: chooseProfile(port, card, card.activeProfile),
      label: String(labels && labels[port.name] ? labels[port.name] : "")
    })
  }

  for (var s = 0; s < sinkPorts.length; s++) {
    if (!seen[sinkPorts[s].name]) {
      seen[sinkPorts[s].name] = true
      merged.push(sinkPorts[s])
    }
  }
  return merged
}

// The sink the profile switch just created: the one on the same card whose
// active port is the one the user picked. Used once per switch to make it the
// default without guessing PipeWire's node naming.
function findSinkByPort(jsonText, cardName, portName) {
  var text = String(jsonText || "").trim()
  if (!text) return ""

  var sinks
  try {
    sinks = JSON.parse(text)
  } catch (error) {
    return ""
  }
  if (!sinks || !sinks.length) return ""

  var wantedPort = String(portName || "")
  var wantedCard = String(cardName || "")
  for (var i = 0; i < sinks.length; i++) {
    var sink = sinks[i]
    if (!sink) continue
    if (String(sink.active_port || "") !== wantedPort) continue
    var props = sink.properties || {}
    if (String(props["device.name"] || "") !== wantedCard) continue
    return String(sink.name || "")
  }
  return ""
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
  return String(port.label || port.description || port.name || "")
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
    parseCard: parseCard,
    chooseProfile: chooseProfile,
    parseMonitors: parseMonitors,
    cableForConnector: cableForConnector,
    labelDisplayPorts: labelDisplayPorts,
    mergeDisplayPorts: mergeDisplayPorts,
    findSinkByPort: findSinkByPort,
    isAvailable: isAvailable,
    portLabel: portLabel,
    glyphFor: glyphFor,
    nextPort: nextPort,
    activeIndex: activeIndex,
    clampIndex: clampIndex
  }
}
