#!/usr/bin/env node
// Run: node tests/test_cleaner.js
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const H = require('../cleaner.js');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures.push(name + '\n    ' + e.message); }
}

const HEADER = 'timestamp,cf,ch,cs,ct,ctt,fs,htt,internal_temp,tf,tm,tt';
function exp(lines, eol) { return [HEADER].concat(lines).join(eol || '\r\n') + (eol || '\r\n'); }

// --- Setpoint filter rule ---
test('keeps a row with tt set', () => {
  const r = H.readExport(exp(['07/01/2026 07:00:00,,,,,,,,,,1,74.0'])).rows;
  assert.strictEqual(H.setpointEvents(r).kept, 1);
});
test('drops ambient-only and state-only pings', () => {
  const r = H.readExport(exp(['07/01/2026 07:00:00,,,,75.2,,,,,,,', '07/01/2026 07:01:00,1,0,1,,,1,,,,,'])).rows;
  const res = H.setpointEvents(r);
  assert.strictEqual(res.kept, 0);
  assert.strictEqual(res.dropped, 2);
});
test('keeps heat-cool row with only htt/ctt', () => {
  const r = H.readExport(exp(['07/01/2026 07:00:00,,,,,76.0,,68.0,,,4,'])).rows;
  const res = H.setpointEvents(r);
  assert.strictEqual(res.kept, 1);
  assert.deepStrictEqual(res.rows[0], { timestamp: '07/01/2026 07:00:00', mode: 'heat-cool', modeSource: 'row', tt: '', htt: '68.0', ctt: '76.0' });
});
test('drops htt/ctt row when tm is not 4', () => {
  const r = H.readExport(exp(['07/01/2026 07:00:00,,,,,76.0,,68.0,,,1,'])).rows;
  assert.strictEqual(H.setpointEvents(r).kept, 0);
});
test('tm "4.0" is treated as heat-cool', () => {
  const r = H.readExport(exp(['07/01/2026 07:00:00,,,,,76.0,,,,,4.0,'])).rows;
  assert.strictEqual(H.setpointEvents(r).rows[0].mode, 'heat-cool');
});
test('blank tm with tt set and no mode anywhere is kept with a blank mode', () => {
  const r = H.readExport(exp(['07/01/2026 07:00:00,,,,,,,,,,,72.0'])).rows;
  const res = H.setpointEvents(r);
  assert.strictEqual(res.kept, 1);
  assert.strictEqual(res.rows[0].mode, '');
  assert.strictEqual(res.rows[0].modeSource, 'unknown');
});
test('blank tm carries the last reported mode forward', () => {
  const r = H.readExport(exp(['07/01/2026 06:00:00,,,,,,,,,,2,', '07/01/2026 07:00:00,,,,,,,,,,,72.0'])).rows;
  const row = H.setpointEvents(r).rows[0];
  assert.deepStrictEqual([row.mode, row.modeSource], ['heat', 'carried']);
});
test('a mode ping within 10s after the change beats the carried mode', () => {
  const r = H.readExport(exp(['07/01/2026 06:00:00,,,,,,,,,,2,', '07/01/2026 07:00:00,,,,,,,,,,,72.0', '07/01/2026 07:00:04,,,,,,,,,,1,'])).rows;
  const row = H.setpointEvents(r).rows[0];
  assert.deepStrictEqual([row.mode, row.modeSource], ['cool', 'nearby']);
});
test('a mode ping more than 10s later is not used', () => {
  const r = H.readExport(exp(['07/01/2026 06:00:00,,,,,,,,,,2,', '07/01/2026 07:00:00,,,,,,,,,,,72.0', '07/01/2026 07:00:30,,,,,,,,,,1,'])).rows;
  assert.strictEqual(H.setpointEvents(r).rows[0].mode, 'heat');
});
test('a row\'s own tm always wins', () => {
  const r = H.readExport(exp(['07/01/2026 06:00:00,,,,,,,,,,2,', '07/01/2026 07:00:00,,,,,,,,,,1,72.0', '07/01/2026 07:00:02,,,,,,,,,,0,'])).rows;
  const row = H.setpointEvents(r).rows[0];
  assert.deepStrictEqual([row.mode, row.modeSource], ['cool', 'row']);
});
test('CRLF: trailing \\r never makes an empty tt look filled', () => {
  const r = H.readExport(exp(['07/01/2026 07:00:00,,,,75.0,,,,,,,'], '\r\n')).rows;
  assert.strictEqual(r[0].tt, '');
  assert.strictEqual(H.setpointEvents(r).kept, 0);
});
test('values pass through as-is (trailing .0 preserved)', () => {
  const r = H.readExport(exp(['07/01/2026 07:00:00,,,,,,,,,,2,70.0'])).rows;
  assert.strictEqual(H.setpointEvents(r).rows[0].tt, '70.0');
});
test('all five tm labels, and unknown codes map to blank', () => {
  assert.deepStrictEqual([0, 1, 2, 3, 4, 7, ''].map(H.modeLabel), ['off', 'cool', 'heat', 'emergency-heat', 'heat-cool', '', '']);
});
test('cs 4 is Aux Heat, not heat-cool', () => {
  assert.strictEqual(H.stateLabel('4'), 'Aux Heat');
  assert.strictEqual(H.modeLabel('4'), 'heat-cool');
});
test('columns are matched by name, not position', () => {
  const text = 'tt,tm,timestamp\r\n72.0,1,07/01/2026 07:00:00\r\n';
  const res = H.setpointEvents(H.readExport(text).rows);
  assert.strictEqual(res.rows[0].timestamp, '07/01/2026 07:00:00');
});
test('a non-export CSV fails with a readable error', () => {
  assert.throws(() => H.readExport('name,email\r\na,b\r\n'), /Missing required column/);
});
test('setpoint CSV header and order', () => {
  const res = H.setpointEvents(H.readExport(exp(['07/01/2026 07:00:00,,,,,,,,,,1,74.0'])).rows);
  assert.strictEqual(H.setpointCSV(res), 'timestamp,mode,tt,htt,ctt\r\n07/01/2026 07:00:00,cool,74.0,,\r\n');
});

// --- Snapshot timeline ---
test('forward-fills and drops leading rows until all three series are known', () => {
  const r = H.readExport(exp([
    '07/01/2026 07:00:00,,,,75.24,,,,,,,',
    '07/01/2026 07:01:00,,,1,,,,,,,,',
    '07/01/2026 07:02:00,,,,,,,,,,1,72.0',
    '07/01/2026 07:03:00,,,,74.96,,,,,,,'
  ])).rows;
  const s = H.snapshots([r]);
  assert.strictEqual(s.leadingDropped, 2);
  assert.strictEqual(s.total, 2);
  assert.deepStrictEqual(s.months[0].rows.map(x => [x.timestamp, x.ambient, x.state, x.target]), [
    ['2026-07-01 07:02:00', '75.2', 'Cooling', '72.0'],
    ['2026-07-01 07:03:00', '75.0', 'Cooling', '72.0']
  ]);
});
test('groups by calendar month, not by file', () => {
  const a = H.readExport(exp(['06/30/2026 23:00:00,,,0,75.0,,,,,,1,72.0', '07/01/2026 01:00:00,,,,74.0,,,,,,,'])).rows;
  const s = H.snapshots([a]);
  assert.deepStrictEqual(s.months.map(m => m.label), ['Jun 2026', 'Jul 2026']);
  assert.strictEqual(s.months[0].partial, true);
});
test('exact duplicate rows across overlapping exports are dropped once', () => {
  const line = '07/31/2026 18:00:00,,,0,75.0,,,,,,1,72.0';
  const s = H.snapshots([H.readExport(exp([line])).rows, H.readExport(exp([line, '08/01/2026 01:00:00,,,,74.0,,,,,,,'])).rows]);
  assert.strictEqual(s.duplicates, 1);
  assert.strictEqual(s.total, 2);
});
test('sorts merged exports chronologically even when files arrive out of order', () => {
  const aug = H.readExport(exp(['08/02/2026 01:00:00,,,0,74.0,,,,,,1,72.0'])).rows;
  const jul = H.readExport(exp(['07/02/2026 01:00:00,,,0,75.0,,,,,,1,71.0'])).rows;
  const s = H.snapshots([aug, jul]);
  assert.deepStrictEqual(s.months.map(m => m.label), ['Jul 2026', 'Aug 2026']);
});
test('32.0 ambient readings are counted, not removed', () => {
  const s = H.snapshots([H.readExport(exp(['07/01/2026 07:00:00,,,0,32.0,,,,,,1,72.0'])).rows]);
  assert.strictEqual(s.sensorDropouts, 1);
  assert.strictEqual(s.months[0].rows[0].ambient, '32.0');
});

// --- Sample files, end to end ---
const sampleDir = path.join(__dirname, '..', 'sample');
const jul = H.readExport(fs.readFileSync(path.join(sampleDir, 'thermostat_export_july.csv'), 'utf8')).rows;
const aug = H.readExport(fs.readFileSync(path.join(sampleDir, 'thermostat_export_august.csv'), 'utf8')).rows;

test('sample: setpoint events are a small minority of rows', () => {
  const res = H.setpointEvents(jul);
  assert.ok(res.kept > 20 && res.kept < jul.length * 0.1, `kept ${res.kept} of ${jul.length}`);
  assert.ok(res.modes['heat-cool'] > 0, 'expected heat-cool rows in the sample');
  assert.ok(res.modeSources.carried > 0, 'expected blank-mode rows resolved by carrying forward');
});
test('sample: overlapping monthly exports in the same zone are not flagged as offset', () => {
  assert.deepStrictEqual(H.snapshots([jul, aug]).offsets, []);
});
test('sample: the same export shifted six hours is flagged, with the right direction', () => {
  const shifted = jul.map(r => {
    const t = H.parseTimestamp(r.timestamp);
    const d = new Date(Date.UTC(t.y, t.mo - 1, t.d, t.h + 6, t.mi, t.s));
    const p = n => String(n).padStart(2, '0');
    return Object.assign({}, r, { timestamp: `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}` });
  });
  const o = H.snapshots([jul, shifted]).offsets;
  assert.strictEqual(o.length, 1);
  assert.strictEqual(o[0].hours, 6, 'second file should read 6 hours ahead');
  assert.ok(o[0].matched > 0.9 * o[0].of);
});
test('sample: every kept row satisfies the filter rule', () => {
  H.setpointEvents(aug).rows.forEach(r => {
    assert.ok(r.tt !== '' || (r.mode === 'heat-cool' && (r.htt !== '' || r.ctt !== '')), JSON.stringify(r));
  });
});
test('sample: merging both exports removes the month-edge overlap and yields Jun/Jul/Aug/Sep tabs', () => {
  const s = H.snapshots([jul, aug]);
  assert.ok(s.duplicates > 100, `duplicates ${s.duplicates}`);
  assert.deepStrictEqual(s.months.map(m => m.label), ['Jun 2026', 'Jul 2026', 'Aug 2026', 'Sep 2026']);
  assert.ok(s.months[0].partial && s.months[3].partial, 'edge months should be flagged partial');
  assert.ok(!s.months[1].partial && !s.months[2].partial);
});
test('sample: snapshot timestamps are strictly non-decreasing', () => {
  const s = H.snapshots([aug, jul]);
  let prev = '';
  s.months.forEach(m => m.rows.forEach(r => { assert.ok(r.timestamp >= prev); prev = r.timestamp; }));
});

console.log(`${passed} passed, ${failures.length} failed`);
failures.forEach(f => console.log('  FAIL ' + f));
process.exit(failures.length ? 1 : 0);
