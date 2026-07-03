#!/usr/bin/env node
// Kører den ægte CSV-parser fra index.html mod en eloverblik-fil — uden browser.
//
// Parser-koden udtrækkes 1:1 fra index.html (blokken mellem ==PARSE_CORE_START==
// og ==PARSE_CORE_END==), så testen aldrig kan drive fra produktionen.
//
// Brug:
//   node test/parse-check.mjs                      # tager første *.csv i test-data/
//   node test/parse-check.mjs test-data/min.csv    # specifik fil
//   node test/parse-check.mjs --verbose            # vis alle [INFO]-linjer
//
// test-data/ er git-ignoreret — private forbrugsdata forlader aldrig maskinen.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import Papa from 'papaparse';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const fileArg = args.find(a => !a.startsWith('--'));

// ── Find CSV-fil ────────────────────────────────────────────────────────────
function pickCsv() {
  if (fileArg) return resolve(ROOT, fileArg);
  const dir = join(ROOT, 'test-data');
  const csvs = readdirSync(dir).filter(f => /\.csv$/i.test(f));
  if (!csvs.length) {
    console.error(`Ingen .csv fundet i ${dir}. Læg din eloverblik-fil der, eller angiv en sti.`);
    process.exit(2);
  }
  return join(dir, csvs[0]);
}

// ── Udtræk parser-blokken fra index.html ─────────────────────────────────────
function loadParser() {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf-8');
  const start = html.indexOf('==PARSE_CORE_START==');
  const end = html.indexOf('==PARSE_CORE_END==');
  if (start === -1 || end === -1) {
    console.error('Kunne ikke finde ==PARSE_CORE_START==/==PARSE_CORE_END== i index.html.');
    process.exit(2);
  }
  // Fra første linjeskift efter start-markøren til linjen før end-markøren.
  const block = html.slice(html.indexOf('\n', start) + 1, html.lastIndexOf('\n', end));

  const log = {
    info: (...a) => { if (verbose) console.log('  [INFO]', ...a); },
    warn: (...a) => console.log('  [WARN]', ...a),
    error: (...a) => console.log('  [ERR ]', ...a),
  };
  // Minimal stub — kun brugt i parserens log-linjer.
  const METER_TYPE_CODES = {
    D06: 'Leveret til net (eksport)', D07: 'Forbrugt fra net (forbrug)',
    E17: 'Forbrugsmålepunkt (netto)', E18: 'Produktionsmålepunkt',
  };
  const meterTypeDescription = info =>
    info.meterTypeCode
      ? `${info.meterTypeCode}${METER_TYPE_CODES[info.meterTypeCode] ? ' — ' + METER_TYPE_CODES[info.meterTypeCode] : ''}`
      : (info.type || '?');

  const factory = new Function('Papa', 'log', 'meterTypeDescription',
    `${block}\n return { parseEloverblikCSV, processRows };`);
  return factory(Papa, log, meterTypeDescription);
}

// ── Kør ───────────────────────────────────────────────────────────────────────
const csvPath = pickCsv();
const { parseEloverblikCSV, processRows } = loadParser();

console.log(`\nFil: ${csvPath}`);
const text = readFileSync(csvPath, 'utf-8');
const parsed = parseEloverblikCSV(text, 'Eksport');

if (!parsed || parsed.error) {
  console.log(`\n❌ Parsing fejlede: ${parsed?.error || 'ukendt fejl'}`);
  process.exit(1);
}

const { rows, meterIds, meterInfo } = parsed;
console.log(`\nMåleserier fundet: ${meterIds.length}`);
for (const id of meterIds) {
  const i = meterInfo.get(id);
  console.log(`  • ${i.meterId || '(intet id)'}  ${i.meterTypeCode || i.type || '?'}  `
    + `— ${i.count.toLocaleString('da-DK')} rækker  (${i.firstKey?.slice(0,10)} → ${i.lastKey?.slice(0,10)})`);
}

// Simulér browserens auto-valg: D06 = eksport, D07/E17 = forbrug.
const d06 = meterIds.find(id => meterInfo.get(id)?.meterTypeCode === 'D06');
const d07 = meterIds.find(id => meterInfo.get(id)?.meterTypeCode === 'D07')
        || meterIds.find(id => meterInfo.get(id)?.meterTypeCode === 'E17');

function summarise(name, seriesId) {
  if (!seriesId) { console.log(`\n${name}: ingen serie fundet`); return null; }
  const out = processRows(rows, seriesId);
  const total = out.reduce((s, r) => s + r.kwh, 0);
  console.log(`\n${name} (${meterInfo.get(seriesId).meterTypeCode}): ${out.length.toLocaleString('da-DK')} timer, `
    + `sum ${total.toLocaleString('da-DK', { maximumFractionDigits: 1 })} kWh`);
  console.log(`   første: ${out[0]?.hourKey}  ${out[0]?.kwh} kWh   |   sidste: ${out[out.length-1]?.hourKey}  ${out[out.length-1]?.kwh} kWh`);
  return out;
}

const exportRows = summarise('Eksport (D06)', d06);
summarise('Forbrug', d07);

// Preview af hvad upload-boksen (dropExport) viser — spejler describeRole/
// updateExportZone i index.html.
const ROLE = { D06: 'Produktion/Eksport', E18: 'Produktion', D07: 'Forbrug/Import', D14: 'Nettoforbrug', E17: 'Hovedmåler (netto)' };
const ORDER = { D06: 0, E18: 1, D07: 2, D14: 3, E17: 4 };
console.log('\nUpload-boks (Forbrug/Produktion) viser:');
[...meterIds].sort((a, b) => (ORDER[meterInfo.get(a).meterTypeCode] ?? 9) - (ORDER[meterInfo.get(b).meterTypeCode] ?? 9))
  .forEach(id => {
    const i = meterInfo.get(id);
    const code = i.meterTypeCode || i.type || '?';
    const used = id === d06 ? ' — bruges til eksport-analyse' : id === d07 ? ' — bruges til forbrug-analyse' : '';
    console.log(`   ${used ? '✓' : '•'} ${ROLE[code] || code} (${code}): ${i.firstKey?.slice(0,10)} → ${i.lastKey?.slice(0,10)}${used}`);
  });

// Verificér det, der styrer "Hent spotpriser og analyser"-knappen.
const ready = !!(exportRows && exportRows.length > 0);
console.log(`\n${ready ? '✅' : '❌'} state.exportRows = ${exportRows?.length || 0} timer `
  + `→ "Hent spotpriser og analyser"-knappen ville være ${ready ? 'AKTIV' : 'DISABLED'}`);
process.exit(ready ? 0 : 1);
