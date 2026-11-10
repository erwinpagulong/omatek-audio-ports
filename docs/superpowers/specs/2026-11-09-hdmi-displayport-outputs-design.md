# HDMI / DisplayPort output switching — design

## Intent

On this machine the AMD Navi 10 card exposes one audio sink per display
connector profile. PipeWire shows only the active one (currently
`output:hdmi-stereo` → `hdmi-output-0`), so the panel reports "only one port"
even though a second monitor's audio output exists on
`output:hdmi-stereo-extra1` → `hdmi-output-1`. The widget must list the live
display outputs together and let the user route audio to either monitor.

The user identifies the two outputs by cable type: **HDMI** and
**DisplayPort**.

## Goals

- List every live display output of the current GPU audio card in the existing
  port panel, labelled by cable type and monitor model
  (`DisplayPort · VG271U M3`, `HDMI · VG240Y S`).
- Selecting a display output that lives on another card profile switches the
  card profile and makes the resulting sink the default.
- Keep keyboard, mouse and right-click behaviour working over the merged list.
- Fall back to the card's own port description when a monitor cannot be matched.
- Leave every non-display sink (analog, USB) byte-for-byte unchanged — in
  particular the analog card's two jacks, `analog-output-lineout` (rear out,
  shown as `Line Out`) and `analog-output-headphones` (shown as `Headphones`),
  stay separate rows on the existing `set-sink-port` path.

## Non-goals

- Surround (5.1 / 7.1) profiles; the widget picks a stereo output profile.
- The `pro-audio` profile.
- Volume, mute, per-app routing, or "both monitors at once".
- Auto-selecting an output when a monitor is replugged beyond whatever
  WirePlumber already does.

## Anti-goals

- Touching the analog card's profile, ports, routes, or volume.
- Writing `set-default-sink` or `set-card-profile` without a user selection.
- Requiring root, a helper daemon, or shell scripts outside the plugin.

## Constraints

- The plugin owns every process; `Panel.qml` only reads widget state.
- Pure decisions live in `Model.js` and are exercised by `node --test`.
- Omarchy always ships Hyprland, so `hyprctl monitors -j` is available;
  the plugin must still degrade without it.
- The card profile switch recreates the sink node, so there is a short audio
  gap and WirePlumber reconnects streams.

## Approaches considered

1. **Merge card ports into the existing port list (chosen).** Read the current
   sink, detect HDMI-type ports, read its card's ports, and present the live
   display outputs as extra rows. Selecting a cross-profile row switches the
   card profile. Reuses the whole panel, cursor and cycle logic.
2. Separate "output device" section above the port list. More accurate
   conceptually but needs two-level navigation and a second cursor model for a
   two-row payoff.
3. Label-only change. Cheapest, but the second output is not reachable, so it
   does not solve the request.

Cable-type discovery: `hyprctl monitors -j` (connector name + model) is chosen
over parsing `/sys/class/drm/*/edid`; it is one JSON read, Omarchy-native, and
avoids binary EDID parsing. If it fails, rows fall back to the card description
(`HDMI / DisplayPort 2`).

## How it works

### Data flow

`BarWidget.qml` refresh chain:

1. `pactl get-default-sink` (unchanged).
2. `pactl -f json list sinks` (unchanged) — `Model.parseSink` additionally keeps
   each port's `type`, and the sink's `properties["device.name"]` (card name)
   and `properties["device.description"]`.
3. If any sink port is HDMI-type (`type === "HDMI"`), run:
   - `pactl -f json list cards` → `Model.parseCard` for the card matching the
     sink's `device.name`: ports (with `device.product.name`), profiles with
     availability, active profile.
   - `hyprctl monitors -j` → monitor `model` + connector `name`.
4. `Model.mergeDisplayPorts` returns the sink's ports plus the card's other
   **available** HDMI-type ports, each with `profile`, cable type and display
   label. Duplicates are merged by port name; the sink's active port stays the
   active one.
5. Non-display sinks skip steps 3–4 entirely.

### Selection

`selectPort(portName)` looks the port up in the merged list:

- No `profile`, or `profile === activeProfile` → `pactl set-sink-port` (today's
  path).
- Different profile → `pactl set-card-profile <card> <profile>`, then remember
  the target port. The next refresh (triggered by `pactl subscribe`) finds the
  sink on that card whose `active_port` matches and calls `pactl set-default-sink`
  once. A short timeout clears the pending target so a failed switch cannot
  wedge the refresh loop.
- The existing preference-file write and `pactl subscribe` refresh are unchanged.

Profile choice for a port: among the port's `profiles` that are available on the
card, prefer the stereo output profile (`output:hdmi-stereo*`), then any other
available `output:*` profile. Surround variants are never preferred.

### Labels

- Cable type from the Hyprland connector prefix: `DP-*` → `DisplayPort`,
  `HDMI-*` → `HDMI`, `DVI-*` → `DVI`, otherwise the card description.
- Monitor match: card port `device.product.name` against Hyprland monitor
  `model` (trimmed, case-insensitive), each monitor used once. Unmatched or
  duplicate models fall back to the card port description.
- Row text: `<cable> · <model>` when matched, else the existing description.
- Panel header for display sinks: `<device description> — <active row label>`
  (e.g. `Navi 10 HDMI Audio — DisplayPort (VG271U M3)`); analog sinks keep
  today's raw sink description.
- Bar glyph stays the monitor glyph for every display output; the tooltip uses
  the active row label.

## Edge cases

- **One monitor.** Only live outputs are listed, so the panel shows one row and
  today's "only one port" note. Right click is a no-op.
- **Active monitor unplugged.** The pin becomes `not available`; PipeWire moves
  the default output (other display or analog); the widget's next refresh shows
  the new truth and the removed row disappears. No stale selection or error.
- **Other monitor unplugged.** The row disappears; the active output and audio
  are untouched.
- **Replug.** The row reappears; the widget does not auto-select it.
  WirePlumber may restore its remembered route; the widget simply reflects it.
- **Profile becomes unavailable between read and click.** `set-card-profile`
  fails harmlessly; the next refresh corrects the list.
- **`hyprctl` missing or malformed JSON.** Rows fall back to card descriptions.
- **No display ports available.** Default sink falls back to analog; the panel
  is the analog panel.
- **Identical monitors.** Model matching is ambiguous; rows fall back to port
  descriptions but remain selectable.

## Files

- `Model.js` — keep port `type`, card name and device description; add
  `parseCard`, `chooseProfile`, `mergeDisplayPorts`, cable-type and label
  helpers.
- `BarWidget.qml` — card + `hyprctl` processes gated on a display sink; merged
  ports; profile-aware `selectPort`; pending-default step.
- `Panel.qml` — render the merged label; display-sink header.
- `i18n/en.json` — only if a new user-visible string is needed.
- `tests/model.test.js` — card parsing, profile choice, merge, labels,
  fallbacks, one-monitor and unplugged-active cases, analog untouched.
- `README.md` — new read commands, new write, brief-gap limitation; keep the
  no-root promise.

## What is left to the builder

- Exact QML process chaining and the pending-default timeout.
- Unit tests for the helpers.
- Manual check on the running shell: switch to HDMI and back, confirm the
  default sink follows and Line Out is never touched.
