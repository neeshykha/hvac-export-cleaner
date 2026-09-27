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

  // A mode change that lands with a setpoint usually arrives as its own ping within a few seconds.
  var MODE_LOOKAHEAD_S = 10;

  function seconds(ts) {
    var t = parseTimestamp(ts);
    return t ? Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s) / 1000 : null;
  }

  // tm is a sparse ping like everything else, so most setpoint rows don't carry it. Resolve the
  // mode from the row itself, else a tm ping just after (the change arriving on its own row),
  // else the last tm reported before it. modeSource records which one was used.
  function setpointEvents(rows) {
    var kept = [], modes = {}, sources = { row: 0, nearby: 0, carried: 0, unknown: 0 };
    var order = rows.map(function (r, i) { return { r: r, i: i, s: seconds(r.timestamp) }; });
    order.sort(function (a, b) {
      if (a.s === null || b.s === null) return a.i - b.i;
      return a.s - b.s || a.i - b.i;
    });
    var last = '';
    order.forEach(function (x, pos) {
      var r = x.r, own = modeLabel(r.tm);
      if (isSetpointEvent(r)) {
        var mode = own, source = 'row';
        if (!mode && x.s !== null) {
          for (var k = pos + 1; k < order.length && order[k].s !== null && order[k].s - x.s <= MODE_LOOKAHEAD_S; k++) {
            var m = modeLabel(order[k].r.tm);
            if (m) { mode = m; source = 'nearby'; break; }
          }
        }
        if (!mode && last) { mode = last; source = 'carried'; }
        record(mode, source, r, x.i);
      }
      if (own) last = own;
    });
    function record(mode, source, r, i) {
      if (!mode) source = 'unknown';
      sources[source]++;
      modes[mode || '(blank)'] = (modes[mode || '(blank)'] || 0) + 1;
      // Values pass through untouched, so "70.0" stays "70.0".
      kept.push({ timestamp: clean(r.timestamp), mode: mode, modeSource: source, tt: clean(r.tt), htt: clean(r.htt), ctt: clean(r.ctt), _i: i });
    }
    // Output keeps the export's own row order.
    kept.sort(function (a, b) { return a._i - b._i; });
    kept.forEach(function (k) { delete k._i; });
    return { rows: kept, kept: kept.length, dropped: rows.length - kept.length, modes: modes, modeSources: sources };
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

  // Exports carry no time zone. Two exports of the same device taken in different zones overlap in
  // time but share almost no timestamps, until one is shifted by a whole (or half) number of hours.
  // Merging those would record every event twice. Returns one finding per suspect pair.
  function detectOffsets(exportsRows) {
    // Match whole rows (time plus every value), not bare timestamps: regular ping schedules line
    // timestamps up at any shift, but the same readings only line up at the real offset.
    var body = function (r) { return COLUMNS.slice(1).map(function (k) { return clean(r[k]); }).join('|'); };
    var sets = exportsRows.map(function (rows) {
      var s = {}, list = [];
      rows.forEach(function (r) {
        var t = seconds(r.timestamp);
        if (t === null) return;
        var k = t + '|' + body(r);
        if (!s[k]) { s[k] = true; list.push({ t: t, b: body(r) }); }
      });
      list.sort(function (a, b) { return a.t - b.t; });
      return { set: s, list: list };
    });
    var found = [];
    for (var a = 0; a < sets.length; a++) {
      for (var b = a + 1; b < sets.length; b++) {
        var A = sets[a], B = sets[b];
        if (A.list.length < 20 || B.list.length < 20) continue;
        var best = { shift: 0, hits: 0, of: 0 }, base = null;
        for (var h = -14; h <= 14; h += 0.5) {
          var off = h * 3600, hits = 0, of = 0;
          var lo = A.list[0].t, hi = A.list[A.list.length - 1].t;
          B.list.forEach(function (x) { var u = x.t + off; if (u >= lo && u <= hi) { of++; if (A.set[u + '|' + x.b]) hits++; } });
          if (h === 0) base = { hits: hits, of: of };
          if (of >= 20 && hits > best.hits) best = { shift: h, hits: hits, of: of };
        }
        // Flag only when a shift explains most of the overlap and unshifted barely matches.
        if (best.shift !== 0 && best.hits >= 0.5 * best.of && (!base || base.hits < 0.2 * Math.max(base.of, 1) || base.hits * 3 < best.hits)) {
          found.push({ a: a, b: b, hours: -best.shift, matched: best.hits, of: best.of });
        }
      }
    }
    return found;
  }

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
      sensorDropouts: dropouts, heatCoolRows: heatCool,
      offsets: exportsRows.length > 1 ? detectOffsets(exportsRows) : []
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
    snapshots: snapshots, detectOffsets: detectOffsets, setpointCSV: setpointCSV, snapshotCSV: snapshotCSV
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HVAC = api;
})(this);
