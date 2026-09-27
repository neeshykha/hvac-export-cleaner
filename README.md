# hvac-export-cleaner

**Live:** https://neeshykha.github.io/hvac-export-cleaner/

A smart-thermostat telemetry export is thousands of sparse pings. In the synthetic July sample here, 6,491 rows come down to **80 setpoint events**: about 1% of the file is the part anyone asked about. This tool finds that 1%, or rebuilds the whole stream into a month-by-month timeline someone can read without a data dictionary.

It runs entirely in the browser. Drop a CSV in and nothing leaves your machine, which matters when the file came off a device in someone's home.

## Why this exists

In IoT support, "the thermostat did something weird" usually ends with someone pulling the device export. The export is honest, but it isn't readable: most rows update one field (an ambient reading, a fan state, an internal temperature ping), and the few rows that matter are buried among them. So the export either gets forwarded raw to someone who can't use it, or an engineer spends twenty minutes in a spreadsheet filtering it by hand.

I kept doing that filtering, so I wrote the rules down once as an agent skill. This is that skill ported to plain JavaScript, so anyone can use it without an agent in the loop. The interesting part isn't the code. It's the handful of rules you only learn by misreading these files a few times.

## Two outputs

**Setpoint events.** Only the moments a target temperature was set. The output is five columns (`timestamp, mode, tt, htt, ctt`) with values passed through exactly as exported. The filter rule is:

- keep the row if `tt` (target temperature) has a value, **or**
- keep it if the unit is in heat-cool mode (`tm` = 4) and it holds a heat or cool target (`htt` / `ctt`) instead.

That second clause is the one people miss. In heat-cool mode the unit tracks two setpoints and leaves `tt` blank, so a naive "rows where tt is set" filter silently drops every change made in that mode.

**Monthly timeline.** Every ping from one or more exports, merged, sorted, and forward-filled so each row is a complete snapshot of ambient temperature, current state, and target. It's split by **calendar month, not by file**, because a "July" export usually starts on the evening of June 30.

## The rules that aren't obvious

| Quirk | What goes wrong without handling it | What this does |
|---|---|---|
| `tm` and `cs` both use code 4 | `tm` 4 is heat-cool (a setting); `cs` 4 is aux heat (an action). Mixing them up mislabels every aux-heat cycle. | Separate mappings, tested against each other. |
| CRLF line endings | The trailing `\r` makes the last column (`tt`) non-empty on every row, so every row looks like a setpoint. | Strips `\r` before any emptiness test. |
| `tm` written as `4.0` | String comparison against `"4"` misses it. | Normalizes to a number first. |
| Setpoint rows with a blank `tm` | Dropping them loses real events. | Keeps them, leaves the mode blank. |
| Monthly exports overlap at the edge | Merged files double-count the overlap. | Drops exact duplicate rows; distinct pings that share a timestamp are kept. |
| Ambient reads exactly 32.0°F | Looks like a freezing house; it's a sensor dropout. | Counts and flags it, and leaves it in. Quietly editing telemetry is worse than showing a glitch. |
| Partial months | A single evening from an older export becomes its own tab. | Flags any month with two days of data or fewer. |

## Column reference

| Column | Meaning |
|---|---|
| `tt` | Target temperature (single-mode setpoint) |
| `htt` / `ctt` | Heat / cool target (heat-cool mode) |
| `tm` | Target mode: 0 off, 1 cool, 2 heat, 3 emergency heat, 4 heat-cool |
| `cs` | Current state: 0 off, 1 cooling, 2 heating, 3 emergency heat, 4 aux heat |
| `ct` | Ambient temperature |
| `cf`, `ch`, `fs`, `tf`, `internal_temp` | Compressor, heat, fan, and device-internal telemetry; not used in either output |

Columns are matched by header name, so order doesn't matter.

## Layout

```
index.html              the tool (static, no build step, no dependencies)
cleaner.js              all of the logic, no DOM; shared by the page, the CLI, and the tests
tools/clean.js          same logic from the command line
tools/make_sample.js    generates the synthetic sample exports (deterministic)
sample/                 two synthetic monthly exports that overlap at the month edge
tests/test_cleaner.js   22 tests: every quirk above, plus the samples end to end
```

```bash
node tests/test_cleaner.js
node tools/clean.js setpoints sample/thermostat_export_july.csv
node tools/clean.js timeline sample/thermostat_export_july.csv sample/thermostat_export_august.csv
```

## About the sample data

It's synthetic. `tools/make_sample.js` runs a toy thermal model (a house drifting toward a hot outdoor temperature, a compressor pulling it back) and emits pings in the same sparse shape a real hub export uses, with every quirk above planted on purpose: heat-cool days, blank modes, `4.0`-style codes, CRLF endings, a few 32.0°F dropouts, and a month-edge overlap between the two files. No real device, home, or customer data is in this repo.
