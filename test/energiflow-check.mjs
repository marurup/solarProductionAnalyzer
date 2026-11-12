#!/usr/bin/env node
// Tester energiflow-parseren og besparelsesmodellen fra index.html — uden browser.
//
// Koden udtrækkes 1:1 fra index.html (blokkene ==INVERTER_PARSE_START/END== og
// ==ANALYSIS_CORE_START/END==), så testen aldrig kan drive fra produktionen.
// Kører mod det syntetiske fixture test/fixtures/energiflow-sample.csv (committet,
// ingen private data) med håndregnede forventede værdier.
//
// Brug:  npm run test:energiflow          (eller: node test/energiflow-check.mjs --verbose)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import Papa from 'papaparse';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');
const html = readFileSync(join(ROOT, 'index.html'), 'utf-8');

function block(name) {
  const start = html.indexOf(`==${name}_START==`);
  const end = html.indexOf(`==${name}_END==`);
  if (start === -1 || end === -1) throw new Error(`Kunne ikke finde ==${name}_START==/==${name}_END== i index.html`);
  return html.slice(html.indexOf('\n', start) + 1, html.lastIndexOf('\n', end));
}

const logged = { warn: [], info: [] };
const log = {
  info: m => { logged.info.push(m); if (verbose) console.log('  [INFO]', m); },
  warn: m => { logged.warn.push(m); if (verbose) console.log('  [WARN]', m); },
  error: m => console.log('  [ERR ]', m),
};
const lib = new Function('Papa', 'log',
  `${block('INVERTER_PARSE')}\n${block('ANALYSIS_CORE')}\n` +
  'return { parseEnergiflowCSV, toDkHourKey, analyzeSavings, buyPriceOere, sellPriceOere, splitHourFlows };')(Papa, log);

// ── Mini-testramme ──────────────────────────────────────────────────────────
let failed = 0, passed = 0;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
function check(name, ok, detail = '') {
  if (ok) { passed++; if (verbose) console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const eq = (name, actual, expected, eps) =>
  check(name, typeof expected === 'number' ? near(actual, expected, eps) : actual === expected,
    `fik ${JSON.stringify(actual)}, forventede ${JSON.stringify(expected)}`);

// ── 1. Parser ───────────────────────────────────────────────────────────────
console.log('\nenergiflow-parser');
const csv = readFileSync(join(ROOT, 'test/fixtures/energiflow-sample.csv'), 'utf-8');
const parsed = lib.parseEnergiflowCSV(csv);
check('parser uden fejl', !parsed.error, parsed.error);
const byKey = new Map(parsed.rows.map(r => [r.hourKey, r]));

eq('meta.version', parsed.meta.version, 1);
eq('meta.source', parsed.meta.source, 'syntetisk test-fixture');
eq('antal timer (12 intervaller → 8 timer)', parsed.rows.length, 8);
eq('intervaller', parsed.stats.intervals, 12);
// Sommertid: 02:00+02:00 og 02:00+01:00 er to forskellige UTC-timer, begge dansk "02"
eq('DST okt: CEST 01:00 → T01', byKey.get('2025-10-26T01')?.load, 0.5);
eq('DST okt: to UTC-timer lagt sammen i T02', byKey.get('2025-10-26T02')?.load, 0.5);
eq('DST okt: CET 03:00 → T03', byKey.get('2025-10-26T03')?.load, 0.4);
eq('Z-tidsstempel 16:00Z → dansk T17', byKey.get('2025-11-03T17')?.batOut, 1.8);
// 15-min summeres til time
const noon = byKey.get('2025-11-03T12');
eq('15-min → time: pv', noon?.pv, 1.4);
eq('15-min → time: load', noon?.load, 0.9);
eq('15-min → time: batIn', noon?.batIn, 0.35);
eq('15-min → time: gridOut', noon?.gridOut, 0.15);
eq('SOC = sidste interval i timen', noon?.soc, 80);
// Negativ værdi = målefejl → ignoreret (her eneste interval → ukendt)
eq('negativ batIn ignoreret → null', byKey.get('2025-11-03T03')?.batIn, null);
eq('negatives talt', parsed.stats.negatives, 1);
eq('tom celle = ukendt (null), ikke 0', byKey.get('2025-11-03T18')?.batOut, null);
eq('huller (timer uden data, DST-sikker)', parsed.stats.gapHours, 202);
eq('toDkHourKey sommertid', lib.toDkHourKey(new Date('2026-07-01T10:00:00Z')), '2026-07-01T12');
eq('toDkHourKey vintertid', lib.toDkHourKey(new Date('2026-01-01T10:00:00Z')), '2026-01-01T11');

const bad = lib.parseEnergiflowCSV('time,pv_kwh\n2025-01-01T00:00:00Z,1');
check('afviser fil uden timestamp-kolonne', !!bad.error);
const noLoad = lib.parseEnergiflowCSV('timestamp,pv_kwh\n2025-01-01T00:00:00Z,1');
check('afviser fil uden load_kwh', !!noLoad.error && noLoad.error.includes('load_kwh'));
const semi = lib.parseEnergiflowCSV('timestamp;pv_kwh;load_kwh\n2025-01-01T00:00:00Z;1,5;0,25');
eq('semikolon + decimalkomma', semi.rows?.[0]?.pv, 1.5);
const semiDot = lib.parseEnergiflowCSV('timestamp;pv_kwh;load_kwh\n2025-01-01T00:00:00Z;1.5;0.25');
eq('semikolon + decimalpunktum', semiDot.rows?.[0]?.pv, 1.5);

// ── 2. Priser ───────────────────────────────────────────────────────────────
console.log('\nkøbs-/salgspris');
const manual = { aftagepligt: false, t1: 0, t2: 0, t3: 0, t4: 1, selfConsumpOverhead: 100 };
eq('manuel købspris = spot×1,25 + overhead', lib.buyPriceOere('2025-11-03T02', 40, null, manual).oere, 150);
eq('manuel salgspris = spot − (t1..t4)', lib.sellPriceOere('2025-11-03T02', 40, null, manual).oere, 39);

const prices24 = h => Array.from({ length: 24 }, (_, i) => (i === h ? 0.5 : 0.1));
const td = {
  supplier: {
    consumption: [{ validFrom: '2025-01-01', validTo: null, prices: prices24(17) }],
    indfodning: [{ validFrom: '2025-01-01', validTo: null, prices: Array(24).fill(0.002) }],
  },
  energinet: { ranges: [{ validFrom: '2025-01-01', validTo: null,
    consumption: { systemTariff: 0.07, transmissionNetTariff: 0.05 },
    production: { indfodningstariff: 0.005, balancetariff: 0.001 } }] },
  elafgift: { ranges: [{ validFrom: '2025-01-01', validTo: null, value: 0.9 }] },
  markup: { ranges: [{ validFrom: '2025-01-01', validTo: null, value: 0.04 }] },
};
// Købspris kl. 17: (2,00 + 0,5 + 0,07 + 0,05 + 0,9 + 0,04) × 1,25 = 4,45 kr = 445 øre
eq('per-time købspris (spot 200 øre, kl. 17)', lib.buyPriceOere('2025-11-03T17', 200, td, manual).oere, 445, 1e-9);
// Salgspris: 200 − (0,001 + 0,005 + 0,002) × 1,25 × 100 − 1 = 198
eq('per-time salgspris', lib.sellPriceOere('2025-11-03T17', 200, td, manual).oere, 198, 1e-9);
eq('aftagepligt fjerner netselskabs indfødning', lib.sellPriceOere('2025-11-03T17', 200, td, { ...manual, aftagepligt: true }).oere, 198.25, 1e-9);

// ── 3. Besparelse ───────────────────────────────────────────────────────────
console.log('\nbesparelsesmodel');
const spot = new Map([
  ['2025-10-26T01', 50], ['2025-10-26T02', 50], ['2025-10-26T03', 50],
  ['2025-11-03T02', 40], ['2025-11-03T03', 40], ['2025-11-03T12', 20],
  ['2025-11-03T17', 200], ['2025-11-03T18', 150],
]);
const s = lib.analyzeSavings(parsed.rows, spot, null, manual, null);
const nov = s.months.get('2025-11');

// Håndregnet (købspris = spot×1,25+100 øre; salgspris = spot−1 øre):
//  kl. 02: net→batteri 2,0 kWh à 1,50 kr = −3,00 kr
//  kl. 12: PV 1,4 / last 0,9 / batteri ind 0,35 / eksport 0,15; PV→batteri 0,35 à 0,19 = −0,0665
//  kl. 17: batteri→hus 1,8 kWh à 3,50 kr = +6,30 kr
eq('batteri, nov', nov.battery, -3.0 - 0.0665 + 6.3);
eq('net→batteri kWh', nov.gridToBat, 2.0);
eq('batteri→hus kWh', nov.batToLoad, 1.8);
eq('direkte selvforbrug kr', nov.direct, 0.9 * 1.25);
eq('PV-overskud salgsværdi kr', nov.surplus, 0.5 * 0.19);
eq('net→batteri omkostning', nov.gridToBatCost, 3.0);
for (const [label, b] of [['total', s.total], ['nov', nov], ['okt', s.months.get('2025-10')]]) {
  eq(`${label}: direkte+overskud+batteri+afvigelse = besparelse`, b.direct + b.surplus + b.battery + b.residual, b.savings);
  eq(`${label}: uden anlæg − faktisk = besparelse`, b.baseline - b.actual, b.savings);
}
eq('afvigelse 0 når inverterens net-tal stemmer', s.total.residual, 0, 1e-9);
eq('døgnprofil: kl. 02 net→batteri', s.profiles.get('2025-11')[2].gridToBat, 2.0);
eq('døgnprofil: kl. 17 batteri→hus', s.profiles.get('2025-11')[17].batToLoad, 1.8);

// Elmåleren er autoritativ: eloverblik siger 2,5 kWh import kl. 02 (inverter: 2,4)
const grid = { imp: new Map([['2025-11-03T02', 2.5]]), exp: new Map([['2025-11-03T02', 0]]) };
const sm = lib.analyzeSavings(parsed.rows, spot, null, manual, grid);
eq('måler-afvigelse havner i "afvigelse"', sm.total.residual, -0.1 * 1.5);
eq('poster summerer stadig med elmåler-tal', sm.total.direct + sm.total.surplus + sm.total.battery + sm.total.residual, sm.total.savings);
eq('timer med elmåler-tal', sm.total.meterHours, 1);
eq('afstemning: inverter-import i målertimer', sm.total.meterInvGridIn, 2.4);
eq('afstemning: måler-import', sm.total.meterGridIn, 2.5);

// Uden net-kolonner udledes net af fordelingen → afvigelse 0
const noGrid = lib.parseEnergiflowCSV(csv.replace(/,grid_import_kwh,grid_export_kwh/, '')
  .split('\n').map(l => l.startsWith('#') || l.startsWith('timestamp') || !l ? l
    : (p => [...p.slice(0, 5), ...p.slice(7)].join(','))(l.split(','))).join('\n'));
check('fixture uden net-kolonner parser', !noGrid.error, noGrid.error);
const sn = lib.analyzeSavings(noGrid.rows, spot, null, manual, null);
eq('udledt net → afvigelse 0', sn.total.residual, 0, 1e-12);

// battery_charge_from_grid_kwh overstyrer fordelingen
const f = lib.splitHourFlows({ pv: 1, load: 0.5, batIn: 1, batOut: 0, gridIn: 0.5, gridOut: 0, batFromGrid: 0.5 });
eq('batFromGrid: PV→batteri', f.pvToBat, 0.5);
eq('batFromGrid: net→batteri', f.gridToBat, 0.5);

console.log(`\n${failed ? '❌' : '✅'} ${passed} bestået, ${failed} fejlet\n`);
process.exit(failed ? 1 : 0);
