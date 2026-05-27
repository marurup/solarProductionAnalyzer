#!/usr/bin/env node
// Henter netselskab-nettariffer fra EDS DatahubPricelist og skriver dem som
// data/tariffs/{GLN}.json. Hver fil indeholder ALLE historiske perioder med
// per-hour-of-day rates (Price1..Price24) for C-kunder.
//
// MVP: kører kun for de supplier-ID'er der står i SUPPLIER_MAP. Udvides senere
// til at auto-matche alle Strømligning suppliers via companyName ↔ ChargeOwner.
//
// Env vars:
//   FORCE_UPDATE=1   gen-fetch også selvom filen findes

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const FORCE_UPDATE = process.env.FORCE_UPDATE === '1';
const COMMIT_EVERY = parseInt(process.env.COMMIT_EVERY || '5', 10);

// MVP — udvides; key er Strømlignings supplier_id, gln er EDS GLN_Number,
// chargeTypeCode er Note='Nettarif C' (eller tilsvarende) for det netselskab.
const SUPPLIER_MAP = {
  n1_c: { gln: '5790001089030', chargeTypeCode: 'CD', companyName: 'N1 A/S - 131' },
  // TODO: udvid med flere netselskaber efter MVP er valideret
};

async function fetchJson(url, label) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const resp = await fetch(url);
      if (resp.status === 429) {
        const retry = parseInt(resp.headers.get('retry-after') || '60');
        console.log(`  [${label}] 429 — venter ${retry+1}s`);
        await new Promise(r => setTimeout(r, (retry + 1) * 1000));
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) {
      console.error(`  [${label}] forsøg ${attempt}: ${e.message}`);
      if (attempt < 6) await new Promise(r => setTimeout(r, 30000));
      else throw e;
    }
  }
}

async function fetchTariffsForGLN(gln, chargeTypeCode) {
  // ChargeType=D03 og ResolutionDuration=PT1H = per-kWh nettarif (ikke abonnement)
  // ChargeTypeCode er ikke unik på tværs af ChargeType: samme "CD" findes både som
  // D03 (Nettarif C, per kWh) og D01 (Net abo C, månedligt abonnement). Vi filtrerer
  // ChargeType=D03 i query'en og dropper non-PT1H records efterfølgende.
  const filter = JSON.stringify({ GLN_Number: gln, ChargeTypeCode: chargeTypeCode, ChargeType: 'D03' });
  const url = `https://api.energidataservice.dk/dataset/DatahubPricelist`
    + `?filter=${encodeURIComponent(filter)}`
    + `&sort=${encodeURIComponent('ValidFrom DESC')}`
    + `&limit=1000`;
  const json = await fetchJson(url, `${gln}/${chargeTypeCode}`);
  const records = (json.records || []).filter(r => r.ResolutionDuration === 'PT1H');
  return records;
}

function recordsToTariff(records) {
  // Konverter til kompakt format: per periode, 24 priser per hour-of-day
  // Returner records sorteret efter ValidFrom DESC (nyeste først for at lookup-loop kan break tidligt)
  return records
    .map(r => ({
      validFrom: r.ValidFrom,
      validTo:   r.ValidTo, // kan være null = "open"
      note:      r.Note,
      prices:    Array.from({ length: 24 }, (_, i) => r[`Price${i+1}`] ?? 0),
      // Behold metadata til debugging
      vatClass:  r.VATClass,
    }))
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom));
}

function commitProgress(msg) {
  if (COMMIT_EVERY === 0) return;
  try {
    execSync('git add data/tariffs data/constants', { stdio: 'pipe' });
    try {
      execSync('git diff --staged --quiet', { stdio: 'pipe' });
      return; // ingen ændringer
    } catch {}
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    execSync(`git commit -m "Backfill tariffer: ${msg} (${stamp}Z)"`, { stdio: 'pipe' });
    for (let i = 0; i < 3; i++) {
      try {
        execSync('git pull --rebase origin main', { stdio: 'pipe' });
        execSync('git push origin main', { stdio: 'pipe' });
        console.log(`  📦 pushed: ${msg}`);
        return;
      } catch (e) {
        console.error(`  push forsøg ${i+1} fejlede`);
        if (i < 2) execSync('sleep 3');
      }
    }
  } catch (e) {
    console.error(`  Commit fejlede: ${e.message.split('\n')[0]}`);
  }
}

async function main() {
  console.log(`Henter tariffer for ${Object.keys(SUPPLIER_MAP).length} netselskab(er)`);

  const supplierMap = {};
  let n = 0;

  for (const [supplierId, info] of Object.entries(SUPPLIER_MAP)) {
    const filePath = `data/tariffs/${info.gln}.json`;

    if (!FORCE_UPDATE) {
      try { await fs.access(filePath); console.log(`  ${supplierId} (${info.gln}): findes allerede, spring over`);
            supplierMap[supplierId] = info;
            continue; } catch {}
    }

    console.log(`  ${supplierId} (${info.gln} ${info.chargeTypeCode}): henter...`);
    try {
      const records = await fetchTariffsForGLN(info.gln, info.chargeTypeCode);
      if (records.length === 0) {
        console.warn(`    Tomt svar — springer over`);
        continue;
      }
      const tariff = recordsToTariff(records);

      const content = {
        _meta: {
          gln: info.gln,
          chargeOwner: records[0].ChargeOwner,
          chargeTypeCode: info.chargeTypeCode,
          recordCount: tariff.length,
          fetched: new Date().toISOString(),
        },
        records: tariff,
      };

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(content, null, 2) + '\n');
      console.log(`    ${tariff.length} historiske perioder skrevet til ${filePath}`);
      supplierMap[supplierId] = info;
      n++;

      if (COMMIT_EVERY > 0 && n % COMMIT_EVERY === 0) {
        await writeSupplierMap(supplierMap);
        commitProgress(`${n} netselskaber`);
      }
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      console.error(`    FEJL: ${e.message}`);
    }
  }

  await writeSupplierMap(supplierMap);
  console.log(`\nFærdig: ${n} netselskab(er) hentet`);
  if (COMMIT_EVERY > 0) commitProgress(`final ${n} netselskaber`);
}

async function writeSupplierMap(map) {
  const content = {
    _meta: { generatedAt: new Date().toISOString(), supplierCount: Object.keys(map).length },
    suppliers: map,
  };
  await fs.mkdir('data/tariffs', { recursive: true });
  await fs.writeFile('data/tariffs/_supplier-map.json', JSON.stringify(content, null, 2) + '\n');
  console.log(`  Wrote supplier-map (${Object.keys(map).length} entries)`);
}

main().catch(e => { console.error(e); process.exit(1); });
