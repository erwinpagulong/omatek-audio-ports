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
