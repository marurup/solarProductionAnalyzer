#!/usr/bin/env node
// Henter spotpriser fra Energi Data Service og skriver dem som månedlige JSON-filer
// under data/prices/{DK1,DK2}/{YYYY-MM}.json. Designet til at køre i GitHub Actions,
// men kan også køres lokalt: `node scripts/fetch-prices.mjs`.
//
// Env vars (alle valgfri):
//   START_DATE=YYYY-MM-DD   (default: 2021-01-01)
//   END_DATE=YYYY-MM-DD     (default: i morgen)
//   FORCE_UPDATE=1          (gen-fetch også gamle, komplette måneder)
//   AREAS=DK1,DK2           (default: begge)

import { promises as fs } from 'node:fs';
import path from 'node:path';

const CUTOFF = '2025-10-01';            // Elspotprices → DayAheadPrices
const DEFAULT_START = '2021-01-01';
const SLEEP_BETWEEN_CALLS_MS = 5000;    // vær flink ved API'et
const RATE_LIMIT_MAX_ATTEMPTS = 6;

const AREAS = (process.env.AREAS || 'DK1,DK2').split(',').map(s => s.trim());
const FORCE_UPDATE = process.env.FORCE_UPDATE === '1';

function isoDay(date) { return date.toISOString().slice(0, 10); }
function lastDayOfMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }

function* genMonths(startDate, endDate) {
  const [sy, sm] = startDate.split('-').map(Number);
  const [ey, em] = endDate.split('-').map(Number);
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    yield { year: y, month: m, ym: `${y}-${String(m).padStart(2, '0')}` };
    m++;
    if (m > 12) { m = 1; y++; }
  }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, label) {
  for (let attempt = 1; attempt <= RATE_LIMIT_MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(url);
      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get('retry-after') || '60');
        console.log(`    [${label}] 429 rate-limit, venter ${retryAfter + 1}s (forsøg ${attempt}/${RATE_LIMIT_MAX_ATTEMPTS})`);
        await sleep((retryAfter + 1) * 1000);
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) {
      console.error(`    [${label}] fejl forsøg ${attempt}: ${e.message}`);
      if (attempt < RATE_LIMIT_MAX_ATTEMPTS) await sleep(30000);
      else throw e;
    }
  }
}

async function fetchMonth(area, ym) {
  const [year, month] = ym.split('-').map(Number);
  const startDay = `${ym}-01`;
  const endDay = `${ym}-${String(lastDayOfMonth(year, month)).padStart(2, '0')}`;
  const useDayAhead = startDay >= CUTOFF;
  const dataset = useDayAhead ? 'DayAheadPrices' : 'Elspotprices';
  const timeCol  = useDayAhead ? 'TimeDK' : 'HourDK';
  const priceCol = useDayAhead ? 'DayAheadPriceDKK' : 'SpotPriceDKK';

  const url = new URL(`https://api.energidataservice.dk/dataset/${dataset}`);
  url.searchParams.set('start', `${startDay}T00:00`);
  url.searchParams.set('end',   `${endDay}T23:59`);
  url.searchParams.set('filter', JSON.stringify({ PriceArea: area }));
  url.searchParams.set('columns', `${timeCol},${priceCol}`);
  url.searchParams.set('sort', `${timeCol} ASC`);
  url.searchParams.set('limit', '5000');

  const json = await fetchJson(url.toString(), `${area} ${ym} ${dataset}`);
  return json.records || [];
}

// Aggregér til timegennemsnit — DayAheadPrices leverer 15-min data (4 records per time)
function recordsToPrices(records) {
  const buckets = new Map(); // hourKey → { sum, count }
  for (const r of records) {
    const ts = r.HourDK || r.TimeDK;
    const price = r.SpotPriceDKK ?? r.DayAheadPriceDKK;
    if (!ts || price == null) continue;
    const hourKey = ts.slice(0, 13);
    const b = buckets.get(hourKey) || { sum: 0, count: 0 };
    b.sum += price;
    b.count++;
    buckets.set(hourKey, b);
  }
  const prices = {};
  for (const [hourKey, { sum, count }] of buckets) {
    prices[hourKey] = +(sum / count * 0.1).toFixed(4); // gns. DKK/MWh → øre/kWh
  }
  return prices;
}

async function main() {
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86400000);
  const startDate = process.env.START_DATE || DEFAULT_START;
  const endDate   = process.env.END_DATE   || isoDay(tomorrow);
  const currentMonth = isoDay(today).slice(0, 7);

  console.log(`Henter spotpriser ${startDate} → ${endDate}`);
  console.log(`Områder: ${AREAS.join(', ')}, force-update: ${FORCE_UPDATE}`);

  let totalFetched = 0;
  let totalSkipped = 0;

  for (const area of AREAS) {
    console.log(`\n=== ${area} ===`);
    for (const { ym } of genMonths(startDate, endDate)) {
      const filePath = `data/prices/${area}/${ym}.json`;
      const isCurrentOrFuture = ym >= currentMonth;

      // Komplette måneder i fortiden caches permanent — spring over hvis filen findes
      if (!FORCE_UPDATE && !isCurrentOrFuture) {
        try {
          await fs.access(filePath);
          totalSkipped++;
          continue;
        } catch { /* fil findes ikke, hent den */ }
      }

      console.log(`  ${ym}: henter ${isCurrentOrFuture ? '(opdaterer aktuel måned)' : '(ny)'}`);
      try {
        const records = await fetchMonth(area, ym);
        if (records.length === 0) {
          console.log(`    tomt resultat — springer over`);
          continue;
        }

        const prices = recordsToPrices(records);
        const content = {
          _meta: {
            area,
            month: ym,
            fetched: new Date().toISOString(),
            hourCount: Object.keys(prices).length,
          },
          prices,
        };

        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, JSON.stringify(content) + '\n');
        console.log(`    ${Object.keys(prices).length} timer skrevet til ${filePath}`);
        totalFetched++;

        await sleep(SLEEP_BETWEEN_CALLS_MS);
      } catch (e) {
        console.error(`    FEJL: ${e.message}`);
      }
    }
  }

  console.log(`\nFærdig. Hentet: ${totalFetched} måned(er), sprunget over: ${totalSkipped}.`);

  // Generér manifest så klienten kan vise hvilke måneder der findes
  await writeManifest();
}

async function writeManifest() {
  const manifest = { generatedAt: new Date().toISOString(), areas: {} };
  for (const area of AREAS) {
    const dir = `data/prices/${area}`;
    let files = [];
    try {
      files = (await fs.readdir(dir))
        .filter(f => /^\d{4}-\d{2}\.json$/.test(f))
        .map(f => f.replace('.json', ''))
        .sort();
    } catch { /* mappen findes ikke */ }
    manifest.areas[area] = {
      monthCount: files.length,
      firstMonth: files[0] || null,
      lastMonth: files[files.length - 1] || null,
      months: files,
    };
  }
  await fs.writeFile('data/prices/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Manifest skrevet: ${Object.entries(manifest.areas).map(([a, i]) => `${a}=${i.monthCount}m`).join(', ')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
