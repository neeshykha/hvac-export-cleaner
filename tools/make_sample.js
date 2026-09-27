#!/usr/bin/env node
// Generates the synthetic sample exports in sample/. Deterministic: same seed, same files.
// Nothing here comes from a real device. It's a toy thermal model that emits pings in the
// same sparse shape a thermostat hub export uses, including the quirks the cleaner handles.
'use strict';
const fs = require('fs');
const path = require('path');

let seed = 20260927;
function rand() { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }
function pick(a) { return a[Math.floor(rand() * a.length)]; }
function f1(n) { return (Math.round(n * 10) / 10).toFixed(1); }
function pad(n) { return String(n).padStart(2, '0'); }
function stamp(d) {
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

const COLS = ['timestamp', 'cf', 'ch', 'cs', 'ct', 'ctt', 'fs', 'htt', 'internal_temp', 'tf', 'tm', 'tt'];
const start = Date.UTC(2026, 5, 30, 12, 0, 0);   // Jun 30 2026
const end = Date.UTC(2026, 8, 1, 12, 0, 0);      // Sep 1 2026
const STEP = 10 * 60 * 1000;

let indoor = 76, tm = 1, tt = 72, htt = null, ctt = null, cs = 0;
const rows = [];
function emit(t, fields) {
  const row = { timestamp: stamp(new Date(t)) };
  COLS.slice(1).forEach(k => { row[k] = fields[k] !== undefined ? fields[k] : ''; });
  rows.push(row);
}

// Initial state so the stream opens with a mode and setpoint.
emit(start, { tm: '1', tt: '72.0' });
emit(start + 1000, { cs: '0' });

for (let t = start + STEP; t < end; t += STEP) {
  const d = new Date(t);
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  const day = Math.floor((t - start) / 86400000);
  const outdoor = 84 + 9 * Math.sin((hour - 9) / 24 * 2 * Math.PI) + 3 * Math.sin(day / 5);

  // Resident setpoint changes: mornings, evenings, and the odd fiddle.
  const minute = d.getUTCMinutes();
  let changed = false;
  if (minute === 0 && (hour === 7 || hour === 22)) {
    if (day % 11 === 6) {                       // a few heat-cool days: two setpoints, no tt
      tm = 4; htt = 68; ctt = hour === 7 ? 76 : 74; changed = 'hc';
    } else if (day % 17 === 9 && hour === 7) {  // vacation-style off day
      tm = 0; changed = 'tt';
    } else {
      tm = 1; tt = hour === 7 ? pick([74, 75, 76]) : pick([70, 71, 72]); changed = 'tt';
    }
  } else if (rand() < 0.004) {
    if (tm === 4) { ctt = pick([73, 74, 75]); changed = 'hc'; }
    else { tt = pick([71, 72, 73, 74]); changed = 'tt'; }
  }
  if (changed === 'tt') {
    // Occasionally the export drops tm on a setpoint row, and sometimes writes it as "1.0".
    const tmCell = rand() < 0.05 ? '' : (rand() < 0.3 ? `${tm}.0` : `${tm}`);
    emit(t - 90 * 1000, { tm: tmCell, tt: f1(tt) });
  } else if (changed === 'hc') {
    emit(t - 90 * 1000, { tm: '4.0', htt: f1(htt), ctt: f1(ctt) });
  }

  // Thermal model: drift toward outdoor, the compressor pulls it down.
  const coolTo = tm === 4 ? ctt : tt;
  const heatTo = tm === 4 ? htt : null;
  indoor += (outdoor - indoor) * 0.03 + (cs === 1 ? -0.55 : 0) + (cs === 2 ? 0.4 : 0) + (rand() - 0.5) * 0.1;
  let next = cs;
  if (tm === 0) next = 0;
  else if (cs === 0 && indoor > coolTo + 1) next = 1;
  else if (cs === 1 && indoor < coolTo - 0.5) next = 0;
  else if (heatTo !== null && cs === 0 && indoor < heatTo - 1) next = 2;
  else if (cs === 2 && heatTo !== null && indoor > heatTo + 0.5) next = 0;
  if (next !== cs) {
    cs = next;
    emit(t + 20 * 1000, { cs: String(cs), fs: cs ? '1' : '0', cf: cs === 1 ? '1' : '0', ch: cs === 2 ? '1' : '0' });
  }

  // Ambient ping every step; a rare sensor dropout reads 32.0.
  emit(t, { ct: rand() < 0.0015 ? '32.0' : f1(indoor) });
  if (minute % 30 === 0) emit(t + 5 * 1000, { internal_temp: f1(indoor + 3.5 + rand()), tf: '0' });
}

rows.sort((a, b) => {
  const ka = a.timestamp.replace(/(\d+)\/(\d+)\/(\d+)/, '$3$1$2');
  const kb = b.timestamp.replace(/(\d+)\/(\d+)\/(\d+)/, '$3$1$2');
  return ka < kb ? -1 : ka > kb ? 1 : 0;
});

function slice(fromUTC, toUTC) {
  return rows.filter(r => {
    const m = r.timestamp.match(/(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+)/);
    const t = Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]);
    return t >= fromUTC && t < toUTC;
  });
}
function write(name, list) {
  const out = [COLS.join(',')].concat(list.map(r => COLS.map(k => r[k]).join(','))).join('\r\n') + '\r\n';
  const dir = path.join(__dirname, '..', 'sample');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), out);
  console.log(`${name}: ${list.length} rows`);
}

// Two "monthly" exports that overlap at the month edge, the way real ones do.
write('thermostat_export_july.csv', slice(Date.UTC(2026, 5, 30, 17), Date.UTC(2026, 7, 1, 6)));
write('thermostat_export_august.csv', slice(Date.UTC(2026, 6, 31, 17), Date.UTC(2026, 8, 1, 6)));
