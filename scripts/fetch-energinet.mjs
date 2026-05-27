#!/usr/bin/env node
// Henter Energinets historiske tariffer fra EDS DatahubPricelist (GLN
// 5790000432752 = "Energinet Systemansvar A/S (SYO)") og bygger
// data/constants/energinet.json. Også elafgift (EA-001 + EA-002)
// til data/constants/elafgift.json — så vi har én autoritativ kilde.
//
// Køres af GitHub Action eller manuelt: node scripts/fetch-energinet.mjs

import { promises as fs } from 'node:fs';
import { execSync } from 'node:child_process';

const GLN = '5790000432752';
const SLEEP_BETWEEN_MS = 10000; // EDS rate-limit er ~1 kald/min for anonymous

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, label) {
  for (let i = 0; i < 8; i++) {
    try {
      const resp = await fetch(url);
      if (resp.status === 429) {
        const retry = parseInt(resp.headers.get('retry-after') || '90');
        console.log(`  [${label}] 429 — venter ${retry+1}s`);
        await sleep((retry + 1) * 1000);
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) {
      console.error(`  [${label}] forsøg ${i+1}: ${e.message}`);
      if (i < 7) await sleep(60000); else throw e;
    }
  }
}

async function fetchCode(code) {
  const filter = JSON.stringify({ GLN_Number: GLN, ChargeTypeCode: code });
  const url = `https://api.energidataservice.dk/dataset/DatahubPricelist`
    + `?filter=${encodeURIComponent(filter)}`
    + `&sort=${encodeURIComponent('ValidFrom DESC')}&limit=200`;
  const json = await fetchJson(url, `Energinet/${code}`);
  return (json.records || []).filter(r => r.ResolutionDuration === 'P1D' || r.ResolutionDuration === 'PT1H');
}

function recordToRange(r) {
  return {
    validFrom: r.ValidFrom,
    validTo:   r.ValidTo,
    value:     r.Price1 ?? 0,
    note:      r.Note,
  };
}

// Sammenflet records fra 4 koder til en sorteret liste af ranges hvor hvert
// punkt har et samlet view af alle 4 værdier
function mergeRanges(sys, trans, indf, bal) {
  // Saml alle unique breakpoints (validFrom dates)
  const points = new Set();
  for (const arr of [sys, trans, indf, bal]) for (const r of arr) {
    if (r.ValidFrom) points.add(r.ValidFrom.slice(0, 10));
    if (r.ValidTo)   points.add(r.ValidTo.slice(0, 10));
  }
  const sorted = [...points].sort();

  const findAt = (arr, date) => arr.find(r => {
    const vf = (r.ValidFrom || '').slice(0, 10);
    const vt = r.ValidTo ? r.ValidTo.slice(0, 10) : null;
    return vf <= date && (vt == null || date < vt);
  });

  const ranges = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i], to = sorted[i + 1];
    const s = findAt(sys, from), t = findAt(trans, from);
    const ip = findAt(indf, from), bp = findAt(bal, from);
    if (!s && !t && !ip && !bp) continue; // ingen data for denne periode
    ranges.push({
      validFrom: from + 'T00:00:00',
      validTo:   to   + 'T00:00:00',
      consumption: {
        systemTariff:           s?.Price1 ?? null,
        transmissionNetTariff:  t?.Price1 ?? null,
      },
      production: {
        indfodningstariff: ip?.Price1 ?? null,
        balancetariff:     bp?.Price1 ?? null,
      },
    });
  }
  // Sidste range — åben hvis sidste sorted-punkt er ValidFrom for åbne records
  // Find aktive åbne records
  const openSys = sys.find(r => !r.ValidTo); const openTr = trans.find(r => !r.ValidTo);
  const openInd = indf.find(r => !r.ValidTo); const openBal = bal.find(r => !r.ValidTo);
  if (openSys || openTr || openInd || openBal) {
    const lastFrom = sorted[sorted.length - 1];
    // Tilføj kun hvis vi ikke allerede har dækket den
    if (!ranges.length || ranges[ranges.length - 1].validTo.slice(0,10) === lastFrom) {
      ranges.push({
        validFrom: lastFrom + 'T00:00:00',
        validTo: null,
        consumption: {
          systemTariff:          openSys?.Price1 ?? null,
          transmissionNetTariff: openTr?.Price1 ?? null,
        },
        production: {
          indfodningstariff: openInd?.Price1 ?? null,
          balancetariff:     openBal?.Price1 ?? null,
        },
      });
    }
  }
  return ranges;
}

async function main() {
  console.log('Henter Energinets historiske tariffer fra EDS DatahubPricelist...\n');

  console.log('1/5: 41000 (Systemtarif forbrug)');
  const sys = await fetchCode('41000'); await sleep(SLEEP_BETWEEN_MS);
  console.log(`   ${sys.length} historiske perioder\n`);

  console.log('2/5: 40000 (Transmissions nettarif forbrug)');
  const trans = await fetchCode('40000'); await sleep(SLEEP_BETWEEN_MS);
  console.log(`   ${trans.length} historiske perioder\n`);

  console.log('3/5: 40010 (Indfødningstarif produktion)');
  const indf = await fetchCode('40010'); await sleep(SLEEP_BETWEEN_MS);
  console.log(`   ${indf.length} historiske perioder\n`);

  console.log('4/5: 45012 (Balancetarif produktion)');
  const bal = await fetchCode('45012'); await sleep(SLEEP_BETWEEN_MS);
  console.log(`   ${bal.length} historiske perioder\n`);

  console.log('5/5: EA-001 (Elafgift)');
  const tax = await fetchCode('EA-001');
  console.log(`   ${tax.length} historiske perioder\n`);

  const ranges = mergeRanges(sys, trans, indf, bal);

  const eneOut = {
    _meta: {
      description: 'Energinets tariffer fra EDS DatahubPricelist GLN 5790000432752. Komponenter: 41000 systemtarif + 40000 transmissionsnettarif (forbrug), 40010 indfødnings + 45012 balance (produktion). Alle i kr/kWh ekskl. moms.',
      source: 'EDS DatahubPricelist',
      sourceGln: GLN,
      lastUpdated: new Date().toISOString(),
    },
    ranges,
  };
  await fs.mkdir('data/constants', { recursive: true });
  await fs.writeFile('data/constants/energinet.json', JSON.stringify(eneOut, null, 2) + '\n');
  console.log(`Skrev data/constants/energinet.json (${ranges.length} merged perioder)`);

  // Elafgift som separat fil
  const taxRanges = tax.map(r => recordToRange(r)).sort((a, b) => b.validFrom.localeCompare(a.validFrom));
  const taxOut = {
    _meta: {
      description: 'Statslig elafgift (kr/kWh ekskl. moms) fra EDS DatahubPricelist GLN 5790000432752 ChargeTypeCode EA-001.',
      source: 'EDS DatahubPricelist',
      sourceGln: GLN,
      sourceCode: 'EA-001',
      lastUpdated: new Date().toISOString(),
    },
    ranges: taxRanges,
  };
  await fs.writeFile('data/constants/elafgift.json', JSON.stringify(taxOut, null, 2) + '\n');
  console.log(`Skrev data/constants/elafgift.json (${taxRanges.length} perioder)`);
}

main().catch(e => { console.error(e); process.exit(1); });
