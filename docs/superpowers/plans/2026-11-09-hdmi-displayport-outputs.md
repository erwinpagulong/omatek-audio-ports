# HDMI / DisplayPort Output Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** List every live display output of the GPU audio card in the port panel, labelled by cable type and monitor, and switch the card profile when the user picks one on another profile.

**Architecture:** `BarWidget.qml` keeps owning every process. `Model.js` gains pure parsers for `pactl list cards` and `hyprctl monitors -j`, a merge that appends the card's other available HDMI-type ports to the current sink's ports, and cable/model labelling. Selecting a merged port whose `profile` differs from the card's active profile runs `pactl set-card-profile`, then one refresh later `pactl set-default-sink`. Non-display sinks never enter the new path.

**Tech Stack:** QML/Quickshell (Omarchy shell plugin), plain JS model tested with `node --test`, `pactl`, `hyprctl`.

**Spec:** `docs/superpowers/specs/2026-11-09-hdmi-displayport-outputs-design.md`

## Global Constraints

- Augment **only** when the current sink exposes an HDMI-type port (`type === "HDMI"`) and its card can be matched. Analog and USB sinks are returned unchanged.
- List only **available** display outputs, plus the sink's own active port.
- Never choose a surround profile when a stereo output profile is available. Never use `pro-audio`.
- Profile switching targets only the card named by the sink's own `properties["device.name"]`.
- No root, no helper scripts, no install hooks, no writes to `/usr/share/omarchy/`.
- All pure decisions live in `Model.js` and are covered by `node --test tests/`.
- `Panel.qml` never runs a process; it reads widget state.
- Row label format: `<cable> · <model>`, falling back to the card port description.
- The preference-file write in `selectPort` stays exactly as it is.
- No new i18n strings; cable names are literal brand/protocol names.

## Review Focus

- **Analog sink gets GPU rows.** A missing `type` field or a card-name mismatch must leave `Line Out` / `Headphones` untouched. Pinned by the Task 4 merge test with the analog sink.
- **Unplugged output still listed or selectable.** A card port with `availability: "not available"` must not be merged (unless it is the sink's active port). Pinned by the Task 4 unavailable-port test.
- **Surround profile chosen.** When `output:hdmi-stereo-extra1` and `output:hdmi-surround-extra1` are both available, the stereo one must win. Pinned by the Task 2 `chooseProfile` test.
- **Blank or wrong row when `hyprctl` is absent/ambiguous.** Missing JSON, unmatched model, or duplicate models must fall back to the card description, never an empty label. Pinned by the Task 3 fallback tests.
- **Pending default wedges the loop.** A failed `set-card-profile`, or a sink that never appears, must clear the pending target via the 5 s timer and `findSinkByPort` returning `""`. Pinned by the Task 4 not-found test and the Task 6 timer step.

---

### Task 1: Sink metadata and display detection

**Files:**
- Modify: `Model.js`
- Test: `tests/model.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `parseSink(jsonText, sinkName)` returns `{ name, description, cardName, deviceDescription, activePort, ports }` or `null`; each port keeps `type`.
  - `isDisplayPort(port) -> boolean`
  - `hasDisplayPorts(sink) -> boolean`

- [ ] **Step 1: Write the failing tests**

Add to `tests/model.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/model.test.js`
Expected: FAIL — `sink.cardName` is `undefined`, `Model.hasDisplayPorts is not a function`.

- [ ] **Step 3: Implement in `Model.js`**

- In `normalizePort`, add `type: String(value.type || "")`, `profile: String(value.profile || "")`, `label: String(value.label || "")`.
- In `parseSink`, read `var props = sink.properties || {}` and return `cardName: String(props["device.name"] || "")` and `deviceDescription: String(props["device.description"] || "")`.
- Add `isDisplayPort(port)` returning `String((port && port.type) || "").toLowerCase() === "hdmi"`.
- Add `hasDisplayPorts(sink)` looping `sink.ports` with `isDisplayPort`.
- Export both.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/model.test.js`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add Model.js tests/model.test.js
git commit -m "feat(model): expose sink card metadata and display ports"
```

---

### Task 2: Card parsing and profile choice

**Files:**
- Modify: `Model.js`
- Test: `tests/model.test.js`

**Interfaces:**
- Consumes: `isDisplayPort` from Task 1.
- Produces:
  - `parseCard(jsonText, cardName)` returns `{ name, activeProfile, ports, profiles }` or `null`.
    - `ports`: `[{ name, description, type, priority, availability, productName, profiles }]` in JSON key order.
    - `profiles`: `{ [name]: { description, available } }`.
  - `chooseProfile(port, card, activeProfile) -> string` (profile name or `""`).

- [ ] **Step 1: Write the failing tests**

Add to `tests/model.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/model.test.js`
Expected: FAIL — `Model.parseCard is not a function`.

- [ ] **Step 3: Implement in `Model.js`**

- `parseCard`:
  - Trim, `JSON.parse`, tolerate malformed/empty/non-array → `null`.
  - Find the card whose `name` equals `cardName`; `null` if absent.
  - Build `profiles` from the object, keeping `description` and `available === true`.
  - Iterate `card.ports` as an object in key order; build an array with `name`, `description`, `type`, `priority`, `availability`, `productName` from `properties["device.product.name"] || ""`, and `profiles` (array of profile names, `[]` when absent).
- `chooseProfile(port, card, activeProfile)`:
  - `candidates` = `port.profiles` filtered to names whose `card.profiles[name].available === true`.
  - Return `activeProfile` if it is a candidate.
  - Prefer the first candidate not containing `"surround"`; else the first candidate; else `""`.
- Export both.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/model.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Model.js tests/model.test.js
git commit -m "feat(model): parse audio card ports and choose output profiles"
```

---

### Task 3: Monitor parsing and cable labels

**Files:**
- Modify: `Model.js`
- Test: `tests/model.test.js`

**Interfaces:**
- Consumes: `isDisplayPort` (Task 1), card port shape (Task 2).
- Produces:
  - `parseMonitors(jsonText) -> [{ connector, model }]`, `[]` on any failure.
  - `cableForConnector(connector) -> string`
  - `labelDisplayPorts(cardPorts, monitors) -> { [portName]: string }`

- [ ] **Step 1: Write the failing tests**

Add to `tests/model.test.js`:

```js
const MONITORS = JSON.stringify([
  { id: 0, name: "DP-1", model: "VG271U M3" },
  { id: 1, name: "HDMI-A-1", model: "VG240Y S" }
])

test("parseMonitors keeps connector and model, tolerating junk", () => {
  assert.deepEqual(Model.parseMonitors(MONITORS), [
    { connector: "DP-1", model: "VG271U M3" },
    { connector: "HDMI-A-1", model: "VG240Y S" }
  ])
  assert.deepEqual(Model.parseMonitors(""), [])
  assert.deepEqual(Model.parseMonitors("not json"), [])
  assert.deepEqual(Model.parseMonitors("{}"), [])
})

test("cableForConnector names the cable from the connector", () => {
  assert.equal(Model.cableForConnector("DP-1"), "DisplayPort")
  assert.equal(Model.cableForConnector("HDMI-A-1"), "HDMI")
  assert.equal(Model.cableForConnector("DVI-D-1"), "DVI")
  assert.equal(Model.cableForConnector(""), "")
  assert.equal(Model.cableForConnector("eDP-1"), "")
})

test("labelDisplayPorts maps monitor models to cable and model", () => {
  const card = Model.parseCard(CARD, "alsa_card.pci-0000_28_00.1")
  const labels = Model.labelDisplayPorts(card.ports, Model.parseMonitors(MONITORS))
  assert.equal(labels["hdmi-output-0"], "HDMI · VG240Y S")
  assert.equal(labels["hdmi-output-1"], "DisplayPort · VG271U M3")
})

test("labelDisplayPorts falls back to the port description", () => {
  const card = Model.parseCard(CARD, "alsa_card.pci-0000_28_00.1")
  const none = Model.labelDisplayPorts(card.ports, [])
  assert.equal(none["hdmi-output-0"], "HDMI / DisplayPort")
  const twin = Model.labelDisplayPorts(card.ports, [
    { connector: "HDMI-A-1", model: "VG240Y S" },
    { connector: "DP-1", model: "VG240Y S" }
  ])
  assert.equal(twin["hdmi-output-0"], "HDMI · VG240Y S")
  assert.equal(twin["hdmi-output-1"], "HDMI / DisplayPort 2")
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/model.test.js`
Expected: FAIL — `Model.parseMonitors is not a function`.

- [ ] **Step 3: Implement in `Model.js`**

- `parseMonitors`: trim, `JSON.parse`, require an array; map each item to `{ connector: String(item.name || ""), model: String(item.model || "") }`; return `[]` on any failure.
- `cableForConnector`: `/^DP([-_]|$)/i` → `"DisplayPort"`; `/^HDMI/i` → `"HDMI"`; `/^DVI/i` → `"DVI"`; `/^USB[-_]?C/i` → `"USB-C"`; else `""`.
- `labelDisplayPorts(cardPorts, monitors)`:
  - Normalize with `trim().toLowerCase()`; track used monitor indexes.
  - For each `isDisplayPort(port)` in order, find the first unused monitor whose normalized `model` equals the normalized `productName` (skip when `productName` is empty).
  - If matched: `label = monitor.model` prefixed with `cableForConnector(monitor.connector) + " · "` when the cable is non-empty.
  - Else: `label = port.description || port.name`.
  - Return the `{ [portName]: label }` map (include all display ports).
- Export all three.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/model.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Model.js tests/model.test.js
git commit -m "feat(model): label display ports by cable and monitor"
```

---

### Task 4: Merge display outputs and resolve the pending sink

**Files:**
- Modify: `Model.js`
- Test: `tests/model.test.js`

**Interfaces:**
- Consumes: `parseSink`/`hasDisplayPorts` (Task 1), `parseCard`/`chooseProfile` (Task 2), `labelDisplayPorts` (Task 3).
- Produces:
  - `mergeDisplayPorts(sink, card, labels) -> Port[]`
  - `portLabel(port)` now returns `port.label` first.
  - `findSinkByPort(jsonText, cardName, portName) -> string` (sink name or `""`).

- [ ] **Step 1: Write the failing tests**

Add to `tests/model.test.js`:

```js
const SINKS_WITH_EXTRA1 = JSON.stringify([
  {
    index: 6202,
    name: "alsa_output.pci-0000_28_00.1.hdmi-stereo",
    description: "Navi 10 HDMI Audio Digital Stereo (HDMI)",
    properties: { "device.name": "alsa_card.pci-0000_28_00.1" },
    active_port: "hdmi-output-0",
    ports: [{ name: "hdmi-output-0", description: "HDMI / DisplayPort", type: "HDMI", priority: 5900, availability: "available" }]
  },
  {
    index: 6300,
    name: "alsa_output.pci-0000_28_00.1.hdmi-stereo-extra1",
    description: "Navi 10 HDMI Audio Digital Stereo (HDMI 2)",
    properties: { "device.name": "alsa_card.pci-0000_28_00.1" },
    active_port: "hdmi-output-1",
    ports: [{ name: "hdmi-output-1", description: "HDMI / DisplayPort 2", type: "HDMI", priority: 5800, availability: "available" }]
  }
])

test("mergeDisplayPorts appends available card ports with profiles and labels", () => {
  const sink = Model.parseSink(HDMI_SINK, "alsa_output.pci-0000_28_00.1.hdmi-stereo")
  const card = Model.parseCard(CARD, "alsa_card.pci-0000_28_00.1")
  const labels = { "hdmi-output-0": "HDMI · VG240Y S", "hdmi-output-1": "DisplayPort · VG271U M3" }
  const merged = Model.mergeDisplayPorts(sink, card, labels)
  assert.deepEqual(merged.map(p => p.name), ["hdmi-output-0", "hdmi-output-1"])
  assert.equal(merged[0].profile, "output:hdmi-stereo")
  assert.equal(merged[1].profile, "output:hdmi-stereo-extra1")
  assert.equal(Model.portLabel(merged[1]), "DisplayPort · VG271U M3")
  assert.equal(Model.isAvailable(merged[1]), true)
  assert.equal(Model.nextPort(merged, "hdmi-output-0"), "hdmi-output-1")
})

test("mergeDisplayPorts returns the analog ports untouched", () => {
  const sink = Model.parseSink(SINK, "alsa_output.pci-0000_2a_00.4.analog-stereo")
  const card = Model.parseCard(CARD, "alsa_card.pci-0000_28_00.1")
  const merged = Model.mergeDisplayPorts(sink, card, {})
  assert.deepEqual(merged.map(p => p.name), ["analog-output-lineout", "analog-output-headphones"])
  assert.equal(merged[0].profile, "")
})

test("mergeDisplayPorts drops unavailable ports but keeps the active one", () => {
  const sink = Model.parseSink(HDMI_SINK, "alsa_output.pci-0000_28_00.1.hdmi-stereo")
  const card = Model.parseCard(CARD, "alsa_card.pci-0000_28_00.1")
  card.ports[1].availability = "not available"
  const merged = Model.mergeDisplayPorts(sink, card, {})
  assert.deepEqual(merged.map(p => p.name), ["hdmi-output-0"])

  const activeOnUnavailable = Model.parseSink(HDMI_SINK, "alsa_output.pci-0000_28_00.1.hdmi-stereo")
  activeOnUnavailable.activePort = "hdmi-output-2"
  const withActive = Model.mergeDisplayPorts(activeOnUnavailable, card, {})
  assert.deepEqual(withActive.map(p => p.name), ["hdmi-output-0", "hdmi-output-2"])
})

test("mergeDisplayPorts is a no-op without a matching card", () => {
  const sink = Model.parseSink(HDMI_SINK, "alsa_output.pci-0000_28_00.1.hdmi-stereo")
  assert.deepEqual(Model.mergeDisplayPorts(sink, null, {}), sink.ports)
  const other = Model.parseCard(CARD, "alsa_card.pci-0000_28_00.1")
  other.name = "alsa_card.pci-0000_99_00.1"
  assert.deepEqual(Model.mergeDisplayPorts(sink, other, {}), sink.ports)
})

test("findSinkByPort matches the sink on the card with that active port", () => {
  assert.equal(
    Model.findSinkByPort(SINKS_WITH_EXTRA1, "alsa_card.pci-0000_28_00.1", "hdmi-output-1"),
    "alsa_output.pci-0000_28_00.1.hdmi-stereo-extra1"
  )
  assert.equal(Model.findSinkByPort(SINKS_WITH_EXTRA1, "alsa_card.pci-0000_28_00.1", "hdmi-output-3"), "")
  assert.equal(Model.findSinkByPort(SINKS_WITH_EXTRA1, "alsa_card.other", "hdmi-output-1"), "")
  assert.equal(Model.findSinkByPort("not json", "alsa_card.pci-0000_28_00.1", "hdmi-output-1"), "")
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/model.test.js`
Expected: FAIL — `Model.mergeDisplayPorts is not a function`.

- [ ] **Step 3: Implement in `Model.js`**

- `mergeDisplayPorts(sink, card, labels)`:
  - Return `sink ? sink.ports : []` when `sink`/`card` is missing, `card.name !== sink.cardName`, or `!hasDisplayPorts(sink)`.
  - Build `byName` from the sink ports.
  - Iterate `card.ports` in order; skip non-display ports and ports that are unavailable **and** not `sink.activePort`.
  - For each kept port build `{ name, description (sink's when present, else card's), type, priority, availability, profile, label }`, where:
    - `profile = chooseProfile(cardPort, card, card.activeProfile)` for every port — `chooseProfile` preserves the active profile when the port offers it, so the sink's active port maps to `card.activeProfile` and switching candidates map to their own stereo profile.
    - `label = labels[name] || ""`.
  - Append any sink ports not seen (defensive).
- `portLabel(port)`: return `String(port.label || port.description || port.name || "")`.
- `findSinkByPort(jsonText, cardName, portName)`: parse the sink array; return the first sink whose `active_port === portName` and `properties["device.name"] === cardName`; else `""`.
- Export both.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/model.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Model.js tests/model.test.js
git commit -m "feat(model): merge live display outputs into the port list"
```

---

### Task 5: Read the card and monitors, list both outputs

**Files:**
- Modify: `BarWidget.qml`
- Modify: `Panel.qml`

**Interfaces:**
- Consumes: everything exported in Tasks 1–4.
- Produces: widget properties `cardName`, `deviceDescription`, `activeProfile`, `parsedSink`, `parsedCard`, `displayApplyPending`; readonly `headerText`; `presentSink(sink)`, `applySink(sink, portsOverride)`, `finishDisplayApply(monitorJson)`.

- [ ] **Step 1: Add widget state**

In `BarWidget.qml`, add properties:

```qml
property string cardName: ""
property string deviceDescription: ""
property string activeProfile: ""
property var parsedSink: null
property var parsedCard: null
property bool displayApplyPending: false
```

- [ ] **Step 2: Split sink presentation from applying**

Add `presentSink(sink)`:

```qml
function presentSink(sink) {
  if (!sink) { root.clearSink(); root.finishRefresh(); return }
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
```

Change `applySink(sink, portsOverride)` to store `cardName`, `deviceDescription`, set `root.ports = portsOverride || sink.ports || []`, and reset `root.activeProfile = ""`. Reset `parsedSink`, `parsedCard`, `cardName`, `deviceDescription`, `activeProfile` in `clearSink()`.

Replace the `applySink(sink)` call in `listSinksProc`'s `onStreamFinished` with `root.presentSink(sink)`. In `resolverProc`'s `onStreamFinished`, replace the whole body with `root.presentSink(sink || Model.parseSink(root.sinkListJson, root.defaultSink))` — `presentSink` already calls `finishRefresh`, so drop the trailing call.

- [ ] **Step 3: Add the two processes and the apply function**

```qml
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
```

Add:

```qml
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
```

Add `listCardsProc.running || monitorsProc.running` to the guard in `refresh()` and the guard in `chainTimer.onTriggered`, and reset `displayApplyPending` in `clearSink()`. Do not clear the pending default in `clearSink`: a profile switch can empty the sink list for one refresh, and the 5 s timer added in Task 6 is what expires a stuck pending default.

- [ ] **Step 4: Compute the header and tooltip**

```qml
readonly property string headerText: {
  if (root.activeProfile !== "" && root.deviceDescription !== "") {
    var label = Model.portLabel(root.activePortObject)
    return label === "" ? root.deviceDescription : root.deviceDescription + " — " + label
  }
  return root.sinkDescription
}
```

Update `tooltip` to use `(root.activeProfile !== "" ? root.deviceDescription : root.sinkDescription) || root.sinkName`.

In `Panel.qml`, add `readonly property string headerText: root.hostWidget ? String(root.hostWidget.headerText || "") : ""` and use it for the sink-description `Text`'s `visible` and `text` instead of `sinkDescription`.

- [ ] **Step 5: Verify**

Run: `node --test tests/`
Expected: PASS.

Run: `omarchy restart shell`, then `qs log` and confirm no QML errors for `BarWidget.qml` / `Panel.qml`.

Open the widget from the bar while the GPU sink is default. Expected:

```
Output ports
Navi 10 HDMI Audio — DisplayPort (VG271U M3)
────────────────────────────────────────────
DisplayPort · VG271U M3                ✓
HDMI · VG240Y S
```

Then switch the default sink to the analog card in Omarchy's audio panel. Expected: `Line Out` and `Headphones` only, header still `Starship/Matisse...`.

- [ ] **Step 6: Commit**

```bash
git add BarWidget.qml Panel.qml
git commit -m "feat: list HDMI and DisplayPort outputs of the GPU card"
```

---

### Task 6: Switch the card profile on selection

**Files:**
- Modify: `BarWidget.qml`
- Modify: `README.md`

**Interfaces:**
- Consumes: `findSinkByPort` (Task 4), merged port `profile` (Task 4), `presentSink` (Task 5).
- Produces: `selectPort(portName)` profile branch; `pendingCard` / `pendingDefaultPort` state; `pendingTimer`.

- [ ] **Step 1: Route cross-profile selections through `set-card-profile`**

Add properties `pendingCard: ""` and `pendingDefaultPort: ""`, and:

```qml
Timer {
  id: pendingTimer
  interval: 5000
  onTriggered: {
    root.pendingCard = ""
    root.pendingDefaultPort = ""
    root.displayApplyPending = false
  }
}
```

Replace the body of `selectPort(portName)` with:

```qml
function selectPort(portName) {
  if (root.sinkName === "" || !portName) return
  var list = root.ports || []
  var port = null
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].name || "") === String(portName)) { port = list[i]; break }
  }
  var profile = port ? String(port.profile || "") : ""
  if (profile !== "" && profile !== root.activeProfile && root.cardName !== "") {
    root.pendingCard = root.cardName
    root.pendingDefaultPort = String(portName)
    pendingTimer.restart()
    Quickshell.execDetached(["pactl", "set-card-profile", root.cardName, profile])
  } else {
    Quickshell.execDetached(["pactl", "set-sink-port", root.sinkName, String(portName)])
  }
  Quickshell.execDetached(["sh", "-c", "printf '%s\\n' \"$1\" > \"$2\"", "sh", String(portName), root.preferenceFile])
  debounce.restart()
}
```

- [ ] **Step 2: Resolve the pending default on the next sink read**

At the start of `listSinksProc`'s `onStreamFinished`, before parsing the sink:

```qml
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
```

- [ ] **Step 3: Update `README.md`**

- "What it touches": add `pactl -f json list cards` and `hyprctl monitors -j` as reads; add `pactl set-card-profile` as the second write, scoped to the display-audio card.
- "Usage": note that on a GPU audio card the panel lists each live display output by cable and monitor, and that selecting the other cable switches the card profile.
- "Limitations": cross-output switches recreate the sink (brief gap; playback may resume automatically); only live outputs are listed; surround profiles are not offered; identical monitors fall back to the card's port description; `hyprctl` is used for cable labels and its absence only degrades the labels.
- Keep the no-root/no-scripts promise and the analog paragraph unchanged.

- [ ] **Step 4: Verify**

Run: `node --test tests/`
Expected: PASS.

Run: `omarchy restart shell`, open the panel on the GPU sink, select `DisplayPort · VG271U M3`. Expected:

```bash
pactl get-default-sink
# alsa_output.pci-0000_28_00.1.hdmi-stereo-extra1
pactl list cards | grep 'Active Profile'
# Active Profile: output:hdmi-stereo-extra1
```

The panel should reopen with the check on `DisplayPort · VG271U M3` and the header reading `Navi 10 HDMI Audio — DisplayPort (VG271U M3)`. Select `HDMI · VG240Y S` and confirm it switches back. Then switch the default sink to the analog card and confirm the panel still shows only `Line Out` / `Headphones` and switching between them still uses `set-sink-port`.

- [ ] **Step 5: Commit**

```bash
git add BarWidget.qml README.md
git commit -m "feat: switch the GPU card profile from the port panel"
```

---

### Task 7: End-to-end verification

**Files:** none.

- [ ] **Step 1: Full test run**

Run: `node --test tests/`
Expected: PASS.

- [ ] **Step 2: Analog isolation**

With the analog sink default, open the panel and switch `Line Out` ↔ `Headphones`. Confirm:
- the GPU card profile is still `output:hdmi-stereo` or whatever it was;
- `pactl list cards` shows `alsa_card.pci-0000_2a_00.4` active profile unchanged;
- the panel never shows an HDMI/DisplayPort row on this sink.

- [ ] **Step 3: Single-monitor behavior (with the user)**

With one display cable disconnected, open the panel. Expected: one row for the remaining cable, the "only one port" note, and right click does nothing. Reconnect it and confirm the second row returns without audio jumping by itself (or, if WirePlumber restores it, that the panel reflects it correctly).

- [ ] **Step 4: Working tree**

Run: `git status --short`
Expected: clean.
