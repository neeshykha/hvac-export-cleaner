#!/usr/bin/env node
// Same logic as the web page, from the command line.
//   node tools/clean.js setpoints <export.csv> [out.csv]
//   node tools/clean.js timeline <export.csv> [more.csv ...]   (writes one CSV per month to ./out/)
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../cleaner.js');

const [mode, ...files] = process.argv.slice(2);
if (!['setpoints', 'timeline'].includes(mode) || !files.length) {
  console.error('usage: clean.js setpoints <export.csv> [out.csv] | clean.js timeline <export.csv> [more.csv ...]');
  process.exit(2);
}

if (mode === 'setpoints') {
  const rows = H.readExport(fs.readFileSync(files[0], 'utf8')).rows;
  const res = H.setpointEvents(rows);
  const out = files[1] || files[0].replace(/\.csv$/i, '') + '_cleaned.csv';
  fs.writeFileSync(out, H.setpointCSV(res));
  console.log(`rows in: ${rows.length}  kept: ${res.kept}  dropped: ${res.dropped}`);
  console.log('modes: ' + Object.entries(res.modes).map(([k, v]) => `${k} ${v}`).join(', '));
  console.log('wrote ' + out);
} else {
  const s = H.snapshots(files.map(f => H.readExport(fs.readFileSync(f, 'utf8')).rows));
  fs.mkdirSync('out', { recursive: true });
  console.log(`rows in: ${s.input}  duplicates dropped: ${s.duplicates}  leading rows dropped: ${s.leadingDropped}  snapshots: ${s.total}`);
  console.log(`32.0°F ambient readings (likely sensor dropouts, left as-is): ${s.sensorDropouts}  heat-cool rows: ${s.heatCoolRows}`);
  s.months.forEach(m => {
    const out = path.join('out', `timeline_${m.key}.csv`);
    fs.writeFileSync(out, H.snapshotCSV(m));
    console.log(`${m.label}: ${m.rows.length} rows over ${m.days} day(s)${m.partial ? '  (partial month)' : ''} -> ${out}`);
  });
}
