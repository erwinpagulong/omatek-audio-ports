const test = require("node:test")
const assert = require("node:assert/strict")
const Model = require("../Model.js")

const SINK = JSON.stringify([{
  index: 58,
  name: "alsa_output.pci-0000_2a_00.4.analog-stereo",
  description: "Starship/Matisse HD Audio Controller Analog Stereo",
  active_port: "analog-output-lineout",
  ports: [
    { name: "analog-output-lineout", description: "Line Out", priority: 9000, availability: "available" },
    { name: "analog-output-headphones", description: "Headphones", priority: 9900, availability: "available" }
  ]
}])

test("parseSink finds the sink by name", () => {
  const sink = Model.parseSink(SINK, "alsa_output.pci-0000_2a_00.4.analog-stereo")
  assert.equal(sink.activePort, "analog-output-lineout")
  assert.equal(sink.ports.length, 2)
  assert.equal(sink.ports[1].description, "Headphones")
})

test("parseSink returns null for malformed JSON", () => {
  assert.equal(Model.parseSink("not json", "x"), null)
  assert.equal(Model.parseSink("", "x"), null)
})

test("parseSink returns null when the sink is absent", () => {
  assert.equal(Model.parseSink(SINK, "alsa_output.pci-0000_28_00.1.hdmi-stereo"), null)
})

test("parseSink tolerates a sink with no ports array", () => {
  const sink = Model.parseSink(JSON.stringify([{ name: "easyeffects_sink", description: "EasyEffects" }]), "easyeffects_sink")
  assert.deepEqual(sink.ports, [])
  assert.equal(sink.activePort, "")
})

test("isAvailable is false only for 'not available'", () => {
  assert.equal(Model.isAvailable({ availability: "available" }), true)
  assert.equal(Model.isAvailable({ availability: "unknown" }), true)
  assert.equal(Model.isAvailable({ availability: "not available" }), false)
  assert.equal(Model.isAvailable(null), true)
})

test("portLabel falls back to the port name", () => {
  assert.equal(Model.portLabel({ name: "analog-output-lineout", description: "Line Out" }), "Line Out")
  assert.equal(Model.portLabel({ name: "analog-output-lineout", description: "" }), "analog-output-lineout")
  assert.equal(Model.portLabel({ name: "", description: "" }), "")
})

test("glyphFor picks headphones, hdmi and the speaker default", () => {
  assert.equal(Model.glyphFor({ name: "analog-output-headphones", description: "Headphones" }, ""), "\u{f02cb}")
  assert.equal(Model.glyphFor({ name: "hdmi-output-0", description: "HDMI / DisplayPort" }, ""), "\u{f0379}")
  assert.equal(Model.glyphFor({ name: "analog-output-lineout", description: "Line Out" }, ""), "\u{f04c3}")
  assert.equal(Model.glyphFor(null, "USB Audio"), "\u{f04c3}")
})

test("nextPort skips unavailable ports and wraps", () => {
  const ports = [
    { name: "a", availability: "available" },
    { name: "b", availability: "not available" },
    { name: "c", availability: "available" }
  ]
  assert.equal(Model.nextPort(ports, "a"), "c")
  assert.equal(Model.nextPort(ports, "c"), "a")
  assert.equal(Model.nextPort([{ name: "a", availability: "available" }], "a"), null)
})

test("activeIndex and clampIndex stay inside the list", () => {
  const ports = [{ name: "a" }, { name: "b" }]
  assert.equal(Model.activeIndex(ports, "b"), 1)
  assert.equal(Model.activeIndex(ports, "zzz"), 0)
  assert.equal(Model.activeIndex([], "a"), -1)
  assert.equal(Model.clampIndex(5, 2), 1)
  assert.equal(Model.clampIndex(-3, 2), 0)
  assert.equal(Model.clampIndex(0, 0), -1)
})

const HDMI_SINK = JSON.stringify([{
  index: 6202,
  name: "alsa_output.pci-0000_28_00.1.hdmi-stereo",
  description: "Navi 10 HDMI Audio Digital Stereo (HDMI) [VG271U M3]",
  properties: {
    "device.name": "alsa_card.pci-0000_28_00.1",
    "device.description": "Navi 10 HDMI Audio"
  },
  active_port: "hdmi-output-0",
  ports: [
    { name: "hdmi-output-0", description: "HDMI / DisplayPort", type: "HDMI", priority: 5900, availability: "available" }
  ]
}])

test("parseSink keeps the card name, device description and port type", () => {
  const sink = Model.parseSink(HDMI_SINK, "alsa_output.pci-0000_28_00.1.hdmi-stereo")
  assert.equal(sink.cardName, "alsa_card.pci-0000_28_00.1")
  assert.equal(sink.deviceDescription, "Navi 10 HDMI Audio")
  assert.equal(sink.ports[0].type, "HDMI")
  assert.equal(sink.ports[0].availability, "available")
})

test("hasDisplayPorts is true for HDMI and false for analog", () => {
  const hdmi = Model.parseSink(HDMI_SINK, "alsa_output.pci-0000_28_00.1.hdmi-stereo")
  const analog = Model.parseSink(SINK, "alsa_output.pci-0000_2a_00.4.analog-stereo")
  assert.equal(Model.hasDisplayPorts(hdmi), true)
  assert.equal(Model.hasDisplayPorts(analog), false)
})

const CARD = JSON.stringify([{
  name: "alsa_card.pci-0000_28_00.1",
  active_profile: "output:hdmi-stereo",
  profiles: {
    "output:hdmi-stereo": { description: "Digital Stereo (HDMI) Output", available: true },
    "output:hdmi-stereo-extra1": { description: "Digital Stereo (HDMI 2) Output", available: true },
    "output:hdmi-surround-extra1": { description: "Digital Surround 5.1 (HDMI 2) Output", available: true },
    "output:hdmi-stereo-extra2": { description: "Digital Stereo (HDMI 3) Output", available: false }
  },
  ports: {
    "hdmi-output-0": {
      description: "HDMI / DisplayPort", type: "HDMI", priority: 5900, availability: "available",
      properties: { "device.product.name": "VG240Y S" },
      profiles: ["output:hdmi-stereo"]
    },
    "hdmi-output-1": {
      description: "HDMI / DisplayPort 2", type: "HDMI", priority: 5800, availability: "available",
      properties: { "device.product.name": "VG271U M3" },
      profiles: ["output:hdmi-stereo-extra1", "output:hdmi-surround-extra1"]
    },
    "hdmi-output-2": {
      description: "HDMI / DisplayPort 3", type: "HDMI", priority: 5700, availability: "not available",
      properties: { "device.product.name": "" },
      profiles: ["output:hdmi-stereo-extra2"]
    }
  }
}])

test("parseCard finds the card and keeps port metadata", () => {
  const card = Model.parseCard(CARD, "alsa_card.pci-0000_28_00.1")
  assert.equal(card.activeProfile, "output:hdmi-stereo")
  assert.equal(card.ports.length, 3)
  assert.equal(card.ports[1].name, "hdmi-output-1")
  assert.equal(card.ports[1].productName, "VG271U M3")
  assert.equal(card.ports[1].availability, "available")
  assert.equal(card.profiles["output:hdmi-stereo-extra1"].available, true)
})

test("parseCard returns null for malformed JSON or an unknown card", () => {
  assert.equal(Model.parseCard("not json", "x"), null)
  assert.equal(Model.parseCard("", "x"), null)
  assert.equal(Model.parseCard(CARD, "alsa_card.other"), null)
})

test("chooseProfile prefers the stereo profile over surround", () => {
  const card = Model.parseCard(CARD, "alsa_card.pci-0000_28_00.1")
  const p1 = card.ports[1]
  assert.equal(Model.chooseProfile(p1, card, ""), "output:hdmi-stereo-extra1")
})

test("chooseProfile falls back to surround, then to empty", () => {
  const card = Model.parseCard(CARD, "alsa_card.pci-0000_28_00.1")
  const surroundOnly = { profiles: ["output:hdmi-surround-extra1"] }
  assert.equal(Model.chooseProfile(surroundOnly, card, ""), "output:hdmi-surround-extra1")
  assert.equal(Model.chooseProfile({ profiles: ["output:gone"] }, card, ""), "")
  assert.equal(Model.chooseProfile({ profiles: [] }, card, ""), "")
})

test("chooseProfile keeps the active profile when the port offers it", () => {
  const card = Model.parseCard(CARD, "alsa_card.pci-0000_28_00.1")
  assert.equal(Model.chooseProfile(card.ports[0], card, "output:hdmi-stereo"), "output:hdmi-stereo")
})
