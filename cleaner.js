/* HVAC export cleaner: pure logic, no DOM. Used by index.html and tests/. */
(function (root) {
  'use strict';

  var COLUMNS = ['timestamp', 'cf', 'ch', 'cs', 'ct', 'ctt', 'fs', 'htt', 'internal_temp', 'tf', 'tm', 'tt'];

  // tm: what the unit is set to. cs: what it's actually doing. 4 means different things in each.
  var TM_LABELS = { 0: 'off', 1: 'cool', 2: 'heat', 3: 'emergency-heat', 4: 'heat-cool' };
  var CS_LABELS = { 0: 'Off', 1: 'Cooling', 2: 'Heating', 3: 'Emergency Heat', 4: 'Aux Heat' };
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function clean(v) {
    // Exports use CRLF; a stray \r makes the last column look filled on every row.
    return v == null ? '' : String(v).replace(/\r/g, '').trim();
  }

  // Minimal RFC 4180 parser: handles quotes, escaped quotes, CRLF, and a BOM.
  function parseCSV(text) {
    text = String(text).replace(/^﻿/, '');
    var rows = [], row = [], field = '', i = 0, q = false, c;
    while (i < text.length) {
      c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
        if (c === '"') { q = false; i++; continue; }
        field += c; i++; continue;
      }
      if (c === '"') { q = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\n' || c === '\r') {
        row.push(field); field = '';
        if (row.length > 1 || clean(row[0]) !== '') rows.push(row);
        row = [];
        i += (c === '\r' && text[i + 1] === '\n') ? 2 : 1;
        continue;
      }
      field += c; i++;
    }
    row.push(field);
    if (row.length > 1 || clean(row[0]) !== '') rows.push(row);
    return rows;
  }

  // Map rows to objects by header name, so column order in the export doesn't matter.
  function readExport(text) {
    var rows = parseCSV(text);
    if (!rows.length) throw new Error('The file is empty.');
    var header = rows[0].map(function (h) { return clean(h).toLowerCase(); });
    var missing = ['timestamp', 'tm', 'tt'].filter(function (k) { return header.indexOf(k) < 0; });
    if (missing.length) throw new Error('Missing required column(s): ' + missing.join(', ') + '. Is this a thermostat telemetry export?');
    var out = [];
    for (var r = 1; r < rows.length; r++) {
      var o = {};
      for (var k = 0; k < header.length; k++) o[header[k]] = clean(rows[r][k]);
      out.push(o);
    }
    return { header: header, rows: out };
  }

  // "4", "4.0", and " 4 " all mean mode 4. Returns null for blank or non-numeric.
  function code(v) {
    v = clean(v);
    if (v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function modeLabel(tm) {
    var n = code(tm);
    return (n !== null && TM_LABELS.hasOwnProperty(n)) ? TM_LABELS[n] : '';
  }

  function stateLabel(cs) {
    var n = code(cs);
    return (n !== null && CS_LABELS.hasOwnProperty(n)) ? CS_LABELS[n] : '';
  }

  // Keep a row if tt is set, or if the unit is in heat-cool (tm 4) and holds htt or ctt instead.
  function isSetpointEvent(r) {
    if (clean(r.tt) !== '') return true;
    return code(r.tm) === 4 && (clean(r.htt) !== '' || clean(r.ctt) !== '');
  }

  function setpointEvents(rows) {
    var kept = [], modes = {};
    rows.forEach(function (r) {
      if (!isSetpointEvent(r)) return;
      var mode = modeLabel(r.tm);
      modes[mode || '(blank)'] = (modes[mode || '(blank)'] || 0) + 1;
      // Values pass through untouched, so "70.0" stays "70.0".
      kept.push({ timestamp: clean(r.timestamp), mode: mode, tt: clean(r.tt), htt: clean(r.htt), ctt: clean(r.ctt) });
    });
    return { rows: kept, kept: kept.length, dropped: rows.length - kept.length, modes: modes };
  }

  // MM/DD/YYYY HH:MM:SS. Also accepts ISO-style YYYY-MM-DD HH:MM:SS.
  function parseTimestamp(s) {
    s = clean(s);
    var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) return { y: +m[3], mo: +m[1], d: +m[2], h: +m[4], mi: +m[5], s: +(m[6] || 0) };
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0) };
    return null;
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function sortKey(t) { return t.y + '-' + pad(t.mo) + '-' + pad(t.d) + ' ' + pad(t.h) + ':' + pad(t.mi) + ':' + pad(t.s); }
  function oneDecimal(v) { var n = Number(v); return isFinite(n) ? n.toFixed(1) : ''; }

  // Merge any number of exports into forward-filled snapshots, grouped by calendar month.
  function snapshots(exportsRows) {
    var all = [], seen = {}, dupes = 0, unparsed = 0, heatCool = 0;
    exportsRows.forEach(function (rows, fileIdx) {
      rows.forEach(function (r, i) {
        var t = parseTimestamp(r.timestamp);
        if (!t) { unparsed++; return; }
        // Month-boundary overlap between exports repeats rows exactly; drop those, keep distinct same-second pings.
        var sig = COLUMNS.map(function (k) { return clean(r[k]); }).join('|');
        if (seen[sig]) { dupes++; return; }
        seen[sig] = true;
        if (code(r.tm) === 4) heatCool++;
        all.push({ key: sortKey(t), t: t, r: r, order: fileIdx * 1e7 + i });
      });
    });
    all.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : a.order - b.order; });

    var ct = null, cs = null, tt = null, out = [], lead = 0, dropouts = 0;
    all.forEach(function (x) {
      if (clean(x.r.ct) !== '') { ct = clean(x.r.ct); if (Number(ct) === 32) dropouts++; }
      if (stateLabel(x.r.cs) !== '') cs = stateLabel(x.r.cs);
      if (clean(x.r.tt) !== '') tt = clean(x.r.tt);
      if (ct === null || cs === null || tt === null) { lead++; return; }
      out.push({ t: x.t, timestamp: x.key, ambient: oneDecimal(ct), state: cs, target: oneDecimal(tt) });
    });

    var months = [], byKey = {};
    out.forEach(function (s) {
      var k = s.t.y + '-' + pad(s.t.mo);
      if (!byKey[k]) { byKey[k] = { key: k, label: MONTHS[s.t.mo - 1] + ' ' + s.t.y, rows: [] }; months.push(byKey[k]); }
      byKey[k].rows.push(s);
    });
    months.forEach(function (m) {
      var days = {};
      m.rows.forEach(function (s) { days[s.t.d] = true; });
      m.days = Object.keys(days).length;
      // A tab with a day or two of data is the tail of an export that spilled across a month edge.
      m.partial = m.days <= 2;
    });

    return {
      months: months, total: out.length, input: all.length + dupes + unparsed,
      duplicates: dupes, unparsed: unparsed, leadingDropped: lead,
      sensorDropouts: dropouts, heatCoolRows: heatCool
    };
  }

  function csvCell(v) {
    v = v == null ? '' : String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  function toCSV(header, rows) {
    return [header.join(',')].concat(rows.map(function (r) { return r.map(csvCell).join(','); })).join('\r\n') + '\r\n';
  }

  function setpointCSV(result) {
    return toCSV(['timestamp', 'mode', 'tt', 'htt', 'ctt'],
      result.rows.map(function (r) { return [r.timestamp, r.mode, r.tt, r.htt, r.ctt]; }));
  }

  function snapshotCSV(month) {
    return toCSV(['Timestamp', 'Ambient Temperature (°F)', 'Current State', 'Target Temp (°F)'],
      month.rows.map(function (s) { return [s.timestamp, s.ambient, s.state, s.target]; }));
  }

  var api = {
    COLUMNS: COLUMNS, TM_LABELS: TM_LABELS, CS_LABELS: CS_LABELS,
    parseCSV: parseCSV, readExport: readExport, modeLabel: modeLabel, stateLabel: stateLabel,
    isSetpointEvent: isSetpointEvent, setpointEvents: setpointEvents, parseTimestamp: parseTimestamp,
    snapshots: snapshots, setpointCSV: setpointCSV, snapshotCSV: snapshotCSV
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HVAC = api;
})(this);
