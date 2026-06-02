#!/usr/bin/env node
// Henter netselskab-tariffer fra EDS DatahubPricelist for alle Strømligning-suppliers.
// Auto-matcher Strømligning's companyName mod EDS ChargeOwner, auto-discoverer
// consumption- og indfødnings-koder pr. netselskab, og skriver tariff-filer +
// supplier-map.
//
// Env vars:
//   FORCE_UPDATE=1     gen-fetch også selvom filen findes
//   COMMIT_EVERY=5     committer efter N suppliers (0 = aldrig)
//   ONLY_SUPPLIERS=n1_c,radius_c   begræns til specifikke supplier_ids (komma)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const FORCE_UPDATE   = process.env.FORCE_UPDATE === '1';
const COMMIT_EVERY   = parseInt(process.env.COMMIT_EVERY || '5', 10);
const ONLY_SUPPLIERS = (process.env.ONLY_SUPPLIERS || '').split(',').filter(Boolean);
const SLEEP_BETWEEN_MS = 3000;

// Manuel mapping for SL suppliers hvor companyName ikke matcher EDS ChargeOwner 1:1.
const MANUAL_GLN_OVERRIDES = {
  elinor:           '5790001095277', // Elinord A/S
  gev_elnet_c:      '5790000681105', // Grindsted Elnet A/S
  'nke-elnet':      '5790001088231', // NKE-Elnet A/S
  // videbaek_elnet_c: ?  // ikke fundet i EDS
};

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, label) {
  for (let i = 0; i < 6; i++) {
    try {
      const resp = await fetch(url);
      if (resp.status === 429) {
        const retry = parseInt(resp.headers.get('retry-after') || '60');
        console.log(`  [${label}] 429 — venter ${retry+1}s`);
        await sleep((retry + 1) * 1000);
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) {
      console.error(`  [${label}] forsøg ${i+1}: ${e.message}`);
      if (i < 5) await sleep(30000);
      else throw e;
    }
  }
}

// Find bedste EDS GLN for en SL-supplier ved companyName-match
function matchGLN(slSupplierId, slCompanyName, chargeOwners) {
  if (MANUAL_GLN_OVERRIDES[slSupplierId]) {
    return { gln: MANUAL_GLN_OVERRIDES[slSupplierId], match: 'manual' };
  }
  const n = (slCompanyName || '').toLowerCase();
  const exact = chargeOwners.find(o => o.name.toLowerCase() === n);
  if (exact) return { gln: exact.gln, match: 'exact' };
  const base = n.replace(/ a\/s$/, '').replace(/ a\.m\.b\.a$/, '').trim();
  const fuzzy = chargeOwners.find(o => o.name.toLowerCase().includes(base) || o.name.toLowerCase().startsWith(base.slice(0, 8)));
  if (fuzzy) return { gln: fuzzy.gln, match: 'fuzzy' };
  return { gln: null, match: 'none' };
}

// Find consumption- og indfødnings-ChargeTypeCode for C-kunder for en GLN
function discoverCodes(records) {
  const d03 = records.filter(r => r.ChargeType === 'D03' &&
    (r.ResolutionDuration === 'PT1H' || r.ResolutionDuration === 'P1D'));

  // Consumption: kig efter unique ChargeTypeCode hvor Note matcher "Nettarif C" (ikke "Nettarif indfødning C")
  const consumptionCandidates = {};
  for (const r of d03) {
    const note = (r.Note || '').toLowerCase().trim();
    if (note === 'nettarif c' || note.startsWith('nettarif c ') || note === 'nettarif c time' || note === 'forbrugstarif c') {
      consumptionCandidates[r.ChargeTypeCode] = (consumptionCandidates[r.ChargeTypeCode] || 0) + 1;
    }
  }
  const consumptionCode = Object.keys(consumptionCandidates).sort((a, b) => consumptionCandidates[b] - consumptionCandidates[a])[0] || null;

  // Indfødning: kig efter "Nettarif indfødning C" først, fallback til B
  const indfodningCandidates = {};
  for (const r of d03) {
    const note = (r.Note || '').toLowerCase();
    if (note.includes('indfødning') && (note.includes(' c') || note.endsWith(' c') || note === 'nettarif indfødning c')) {
      indfodningCandidates[r.ChargeTypeCode] = (indfodningCandidates[r.ChargeTypeCode] || 0) + 1;
    }
  }
  let indfodningCode = Object.keys(indfodningCandidates).sort((a, b) => indfodningCandidates[b] - indfodningCandidates[a])[0] || null;
  let indfodningNote = 'C-spec';
  // Fallback til B-rate hvis ingen C-indfødning findes
  if (!indfodningCode) {
    const bCandidates = {};
    for (const r of d03) {
      const note = (r.Note || '').toLowerCase();
      if (note.includes('indfødning') && (note.includes('b høj') || note.endsWith(' b'))) {
        bCandidates[r.ChargeTypeCode] = (bCandidates[r.ChargeTypeCode] || 0) + 1;
      }
    }
    indfodningCode = Object.keys(bCandidates).sort((a, b) => bCandidates[b] - bCandidates[a])[0] || null;
    if (indfodningCode) indfodningNote = 'B-fallback (intet C-specifikt)';
  }

  return { consumptionCode, indfodningCode, indfodningNote };
}

async function fetchGlnRecords(gln) {
  const url = `https://api.energidataservice.dk/dataset/DatahubPricelist`
    + `?filter=${encodeURIComponent(JSON.stringify({ GLN_Number: gln }))}`
    + `&sort=${encodeURIComponent('ValidFrom DESC')}`
    + `&limit=5000`;
  return (await fetchJson(url, gln)).records || [];
}

function recordsToTariff(records, code) {
  return records
    .filter(r => r.ChargeTypeCode === code && r.ChargeType === 'D03' &&
                 (r.ResolutionDuration === 'PT1H' || r.ResolutionDuration === 'P1D'))
    .map(r => {
      const hourly = r.ResolutionDuration === 'PT1H';
      const prices = hourly
        ? Array.from({ length: 24 }, (_, i) => r[`Price${i+1}`] ?? 0)
        : Array.from({ length: 24 }, () => r.Price1 ?? 0);
      return {
        validFrom: r.ValidFrom,
        validTo:   r.ValidTo,
        note:      r.Note,
        resolution: r.ResolutionDuration,
        prices,
      };
    })
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom));
}

function commitProgress(msg) {
  if (COMMIT_EVERY === 0) return;
  try {
    execSync('git add data/tariffs data/constants', { stdio: 'pipe' });
    try { execSync('git diff --staged --quiet', { stdio: 'pipe' }); return; } catch {}
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    execSync(`git commit -m "Backfill tariffer: ${msg} (${stamp}Z)"`, { stdio: 'pipe' });
    for (let i = 0; i < 3; i++) {
      try { execSync('git pull --rebase origin main', { stdio: 'pipe' }); execSync('git push origin main', { stdio: 'pipe' }); console.log(`  📦 pushed: ${msg}`); return; }
      catch { if (i < 2) execSync('sleep 3'); }
    }
  } catch (e) { console.error(`  Commit fejlede: ${e.message.split('\n')[0]}`); }
}

async function main() {
  console.log('Henter Strømligning suppliers...');
  const slResp = await fetch('https://stromligning.dk/api/suppliers');
  const slSuppliers = await slResp.json();
  console.log(`SL suppliers: ${slSuppliers.length}`);

  console.log('Henter EDS ChargeOwners (jan 2026)...');
  const edsSample = await fetchJson(
    'https://api.energidataservice.dk/dataset/DatahubPricelist?start=2026-01-01T00:00&end=2026-02-01T00:00&limit=10000',
    'eds-sample'
  );
  const chargeOwnersMap = new Map();
  for (const r of edsSample.records) {
    if (r.ChargeOwner && r.GLN_Number) chargeOwnersMap.set(r.ChargeOwner, r.GLN_Number);
  }
  const chargeOwners = [...chargeOwnersMap.entries()].map(([name, gln]) => ({ name, gln }));
  console.log(`EDS unique ChargeOwners: ${chargeOwners.length}`);

  const supplierMap = {};
  let n = 0;

  for (const sup of slSuppliers) {
    if (ONLY_SUPPLIERS.length && !ONLY_SUPPLIERS.includes(sup.id)) continue;

    const { gln, match } = matchGLN(sup.id, sup.companyName || sup.name, chargeOwners);
    if (!gln) {
      console.warn(`  ${sup.id}: ingen GLN-match — springer over`);
      continue;
    }

    const filePath = `data/tariffs/${gln}.json`;
    if (!FORCE_UPDATE) {
      try {
        const existing = JSON.parse(await fs.readFile(filePath, 'utf-8'));
        // Læs koder fra eksisterende fil så supplier-map'en stadig er korrekt
        supplierMap[sup.id] = {
          gln,
          consumptionCode: existing._meta?.consumptionCode ?? null,
          indfodningCode:  existing._meta?.indfodningCode ?? null,
          indfodningNote:  existing._meta?.indfodningNote ?? null,
          companyName:     existing._meta?.chargeOwner ?? sup.companyName,
          match,
        };
        console.log(`  ${sup.id} (${gln}): findes, springer over`);
        continue;
      } catch {}
    }

    console.log(`\n${sup.id} (${sup.companyName}, GLN ${gln}, match=${match}):`);
    try {
      const records = await fetchGlnRecords(gln);
      const { consumptionCode, indfodningCode, indfodningNote } = discoverCodes(records);
      if (!consumptionCode) {
        console.warn(`  Ingen consumption-kode fundet — springer over (${records.length} records)`);
        continue;
      }
      console.log(`  Discovery: consumption=${consumptionCode}, indfodning=${indfodningCode || 'INGEN'} (${indfodningNote})`);

      const consumption = recordsToTariff(records, consumptionCode);
      const indfodning  = indfodningCode ? recordsToTariff(records, indfodningCode) : [];
      console.log(`  Forbrug: ${consumption.length} perioder, indfødn: ${indfodning.length} perioder`);

      const content = {
        _meta: {
          gln,
          chargeOwner: records[0]?.ChargeOwner || '',
          consumptionCode,
          indfodningCode,
          indfodningNote,
          slSupplierId: sup.id,
          slCompanyName: sup.companyName,
          fetched: new Date().toISOString(),
        },
        consumption,
        indfodning,
      };

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(content, null, 2) + '\n');
      supplierMap[sup.id] = {
        gln,
        consumptionCode,
        indfodningCode,
        companyName: records[0]?.ChargeOwner || sup.companyName,
        match,
      };
      n++;

      if (COMMIT_EVERY > 0 && n % COMMIT_EVERY === 0) {
        await writeSupplierMap(supplierMap);
        commitProgress(`${n} netselskaber`);
      }
      await sleep(SLEEP_BETWEEN_MS);
    } catch (e) {
      console.error(`  FEJL: ${e.message}`);
    }
  }

  await writeSupplierMap(supplierMap);
  console.log(`\nFærdig: ${n} netselskab(er) hentet/opdateret`);
  if (COMMIT_EVERY > 0) commitProgress(`final ${n} netselskaber`);
}

async function writeSupplierMap(map) {
  // Merge med eksisterende fil for at undgå at miste suppliers ved partial run
  let existing = { suppliers: {} };
  try { existing = JSON.parse(await fs.readFile('data/tariffs/_supplier-map.json', 'utf-8')); } catch {}
  const merged = { ...(existing.suppliers || {}), ...map };
  const content = {
    _meta: {
      description: 'Strømligning supplier_id → EDS GLN + ChargeTypeCode. consumptionCode = nettarif på forbrugs-siden. indfodningCode = nettarif på eksport-siden (kan være B-rate hvis netselskab ikke har separat C-kode).',
      generatedAt: new Date().toISOString(),
      supplierCount: Object.keys(merged).length,
    },
    suppliers: merged,
  };
  await fs.mkdir('data/tariffs', { recursive: true });
  await fs.writeFile('data/tariffs/_supplier-map.json', JSON.stringify(content, null, 2) + '\n');
}

main().catch(e => { console.error(e); process.exit(1); });
