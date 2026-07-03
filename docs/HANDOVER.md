# Handover-dokument — Solcelle Eksport-Analyse

**Sidst opdateret:** 2026-07-03
**Repo:** https://github.com/marurup/solarProductionAnalyzer
**Live:** https://marurup.github.io/solarProductionAnalyzer/

Dette dokument beskriver hele projektets nuværende tilstand, så arbejdet kan fortsætte fra en anden maskine uden kontekst-tab. Læs `README.md` først for arkitektur-overblik.

## 1. Hvad er færdigt og live

### Frontend (browser)
- **CSV-upload** med auto-detektion af målepunkt via typekode (D06=eksport, D07=forbrug, E17/E18)
  - **Dansk + engelsk** eloverblik-format genkendes (`Fra`/`From_date`, `Mængde`/`Volume`, `Målepunktstype_kode`/`Metering_point_type_Code` m.fl.)
  - **Måleserie = målepunkts-ID + typekode** — samme fil kan indeholde flere flows; hver vises med tidsinterval i upload-boksen (så man ser fx at produktionen først er tilføjet senere)
  - **Blandet opløsning per serie** håndteres: `processRows()` aggregerer altid til timer ved at summere kWh per `hourKey` (korrekt for både time- og 15-min-data). Der bruges INGEN global opløsnings-detektion længere
  - Auto-valg af D06 + auto-indlæsning af D07 fra samme fil; separat forbrugsfil-boks viser dæmpet note når forbrug kom fra hovedfilen
  - **Tydelige fejl** vises direkte i upload-boksen (ikke kun i log) hvis CSV-formatet ikke genkendes
- **`file://`-advarsel:** åbnes siden som lokal fil (ikke via webserver) vises en rød banner — ellers fejler alle `fetch()` med "Failed to fetch" og analysen melder fejlagtigt manglende spotpriser
- **Grænseværdier:** "Dårlig"/"Advarsel"-nettopris + **minimum eksport** (default 0,01 kWh) der filtrerer måle-støj (fx 0,001 kWh) fra de problematiske timer
- **Hjælpe-ikoner (`?`)** med tooltip på alle konfigurations-felter (hover + tastatur-fokus)
- **Log** samlet i én foldbar sektion nederst (uafhængig af trin 1/2); foldet sammen som standard, auto-åbner kun ved fejl, badge viser antal advarsler/fejl, hver entry har tidsstempel
- **Quick-konfiguration via adresse:**
  - DAWA autocomplete med 250 ms debounce → fuld adresse + koordinater
  - Strømligning `/api/suppliers/find?lat=&long=` → netselskab auto-valgt
  - Strømligning `/api/companies` → elselskab + produkt + markup (dato-aware via `fromDate`/`toDate`)
  - localStorage persistens (`solar-analyzer-config-v1`)
- **Per-time tariff-analyse:**
  - `analyze()` slår op for hver CSV-time i `state.tariffData` (loaded ved konfig + page-load)
  - `lookupHourlyComponents()`: distribution (per hour-of-day), systemtarif, transmissionsnettarif, elafgift, markup (forbrugsside) + Energinet indfødning + balance + supplier indfødning (eksportside)
  - Formel: `selvforbrugsværdi = spot × 1,25 + tariffer × 1,25`
  - Fallback til manuelle felter (`t1`..`t4`, `selfConsumpOverhead`) hvis tariff-data ikke tilgængelig for valgt supplier
- **Status-side** (`status.html`):
  - IndexedDB-cache: dage per prisområde
  - Statiske månedsfiler: liste + datointerval
  - Tariff-data: tabel per netselskab (consumption + indfødning + EDS-koder)
  - Energinet konstanter: per periode, forbrug/produktion grupperet med korrekt terminologi
  - Elafgift: per periode med "reduceret periode"-markering
  - Gemt brugerkonfiguration + ryd-knapper for hver type cache
- **Version-info i footer** med commit SHA + dato fra GitHub API (cached 1 time i sessionStorage)
- **Lightbox** for billeder i upload-guide
- **Detail-breakdown** under "Tariff-overhead"-feltet:
  - Aktuelle rates (dags dato) komprimeret som "kl. XX-YY: Z øre"
  - Eksport-fradrag opdelt per komponent
  - Foldable "Alle historiske perioder" med min/max per periode

### Data-layer (i repo'et)

| Filtype | Indhold | Genereret af | Status |
|---|---|---|---|
| `data/prices/{DK1,DK2}/{ym}.json` | Spotpriser per måned, dansk lokal tid | `scripts/fetch-prices.mjs` | Backfillet 2021-01 → nu |
| `data/prices/manifest.json` | Liste af tilgængelige måneder | `scripts/fetch-prices.mjs` | Auto |
| `data/tariffs/{GLN}.json` | Netselskabs nettarif (consumption + indfødn) | `scripts/fetch-tariffs.mjs` | **34 netselskaber** komplet historik 2015→nu |
| `data/tariffs/_supplier-map.json` | Strømligning supplier_id → GLN + ChargeTypeCode | `scripts/fetch-tariffs.mjs` | 34 entries |
| `data/constants/energinet.json` | System+transmission+indfødn+balance | `scripts/fetch-energinet.mjs` | Komplet 2020-2026 |
| `data/constants/elafgift.json` | Statslig elafgift | `scripts/fetch-energinet.mjs` | Komplet 2018-2026 |

### Backfill-infrastruktur

- **`scripts/fetch-prices.mjs`** — Spotpris-backfill. Bruger DayAheadPrices fra 2025-10-01, Elspotprices før. Aggregerer 15-min → time. Inkrementelle commits per 5 filer.
- **`scripts/fetch-tariffs.mjs`** — Netselskabs-tariffer fra DatahubPricelist. Auto-discover ChargeTypeCode via Note-match. Auto-match Strømligning supplier_id mod EDS ChargeOwner. Manuel override-tabel for 3 navn-mismatch.
- **`scripts/fetch-energinet.mjs`** — Energinet (GLN 5790000432752) + elafgift. Henter koder 40000, 41000, 40010, 45012, EA-001. Merger til perioder med unique breakpoints.
- **`.github/workflows/update-prices.yml`** — Dagligt cron 14:00 UTC + manuel
- **`.github/workflows/update-tariffs.yml`** — Månedligt cron 05:00 1. + manuel. Kører Energinet først, så netselskaber.

## 2. Hvad mangler / kendte TODOs

### Korrekthed (åbne)
- **⚠️ Produktionsfradrag matcher ikke faktisk afregnings-opgørelse (2026-07-03).** De beregnede fradrag på eksportsiden (Energinets balance- + indfødningstarif, netselskabets indfødningstarif, leverandørgebyr) i "Netto eksport"/"Afregnings-validering" stemmer ikke med tallene på brugerens rigtige afregnings-opgørelse. Skal undersøges:
  - Hvilke komponenter og satser står der faktisk på opgørelsen? Sammenlign post-for-post mod `lookupHourlyComponents()` og `analyze()`.
  - Moms-håndtering på eksportsiden: `analyze()` ganger eksportfradrag med `1,25` (`exportFradragOere = (energinetBalance + energinetIndfodning + supplierIndfodning) * 1.25 * 100 + t4`) — er moms korrekt på produktion/salg, eller skal fradragene være uden moms?
  - Er `t4` (leverandørgebyr) dobbeltregnet eller i forkert enhed?
  - Verificér satserne i `data/tariffs/{GLN}.json` og `data/constants/energinet.json` mod opgørelsens periode.

### Data-fuldstændighed
- **Videbæk Elnet** kunne ikke auto-matches til EDS (kun 34 af 38 Strømligning suppliers er backfillet). Skal undersøges hvor de findes i EDS.
- **8 netselskaber har ingen indfødningskode** (`null` i supplier-map): N1 (har faktisk `C INDF` nu — fix kom efter), Aal El-Net, Cerius, Dinel, El-net Kongerslev, Elektrus, Elinor, Elnet Midt, m.fl. — disse netselskaber har enten reelt ingen separat C-indfødning, eller auto-discovery missede det. Verificér mod Strømlignings UI eller netselskabernes egne sider. **Note:** N1 fik faktisk `C INDF` ved seneste run; lokalt vises 26/34 med kode efter merge fra eksisterende filer.
- **Energinet 2019 og tidligere** mangler i `data/constants/energinet.json`. EDS har historik længere tilbage — udvid `fetch-energinet.mjs` til at hente mere.

### Nye features (implementeret)
- ✅ **Validér produktionsafregning** — Tab "Afregnings-validering": per-måned breakdown af spotindtægt brutto, fradrag (Energinet balance + indfødning, netselskab indfødning, leverandørgebyr) og beregnet netto. Brugeren taster faktisk udbetaling → difference med farvemarkering. Klikbar fradragsdetalje per måned når per-time tariff-data er aktiv. Beløb gemmes i localStorage.
- ✅ **Validér elforbrug-regning** — Tab "Elforbrug-validering": analyserer D07-forbrugsdata per time (spot + alle forbrugstariffer inkl. moms). Faste abonnements-gebyrer (netselskab + elselskab, kr/md inkl. moms) lægges til beregnet månedstotal. Brugeren taster faktisk regning → difference. Klikbar komponent-breakdown (spot, nettarif, Energinet system/transmission, elafgift, leverandørtillæg) når per-time data er aktiv. Spotpris-hentning dækker nu begge dataintervaller hvis eksport og forbrug har forskellig rækkevidde.

### UI/UX
- **Mobil-layout** ikke optimeret (testet kun desktop)
- **Eksport CSV** fra resultattabel inkluderer ikke alle per-time komponenter (kun aggregerede tal)
- **Breakdown viser "i dag"** — kunne udvides til at vise per CSV-periode for længere historiske analyser
- **Manuel t1-t4 fallback** når supplier ikke har tariff-data — ingen UI-indikator om man er i fallback eller per-time mode på selve analyse-skærmen (kun i log)

### Test
- **CSV-parser: `test/parse-check.mjs`** kører den ægte parser mod filer i `test-data/` (git-ignoreret). Parser-koden udtrækkes 1:1 fra `index.html` mellem `==PARSE_CORE_START==`/`==PARSE_CORE_END==`-markørerne (ingen kopi der kan drive fra hinanden). Kør med `npm run test:parse`. Viser måleserier, tidsintervaller, aggregerede timetal og om analyser-knappen ville aktiveres.
  - **Vigtigt:** hvis du flytter/omdøber parser-funktionerne, så hold dem inden for markørerne og lad blokken kun referere `Papa`, `log` og `meterTypeDescription` udefra.
- **Resten er manuel verifikation:**
  - "Per-time aktiv"-badge dukker op efter "Anvend konfiguration"
  - Sanity-check af tal vs. Strømlignings egen UI for samme adresse
- Et sanity-check-script kunne sammenligne vores per-hour beregning mod Strømlignings prices API for tilfældige timer.

### Mindre TODO'er i koden
Søg på `// TODO` i `index.html` og `scripts/`.

## 3. Sådan vedligeholdes data

**Når Energinet annoncerer nye rates** (typisk 1 gang om året, omkring november):
- Trigger workflow "Update tariffs" manuelt → henter nye rates fra EDS DatahubPricelist
- Alternativt: vent på månedlig cron 1. i måneden

**Når nyt netselskab dukker op hos Strømligning:**
- Trigger workflow "Update tariffs" → auto-discover finder evt. nye netselskaber
- Hvis navn ikke matcher EDS ChargeOwner: tilføj manuel override i `scripts/fetch-tariffs.mjs` `MANUAL_GLN_OVERRIDES`

**Når spotpriser for en ny måned skal hentes:**
- Daglig cron kører automatisk 14:00 UTC og opdaterer aktuel/næste måned
- Manuel trigger ved behov

**Når elafgift ændres (politisk beslutning):**
- Trigger "Update tariffs" → henter direkte fra EDS (autoritativ kilde)
- INGEN manuel rate-tabel skal vedligeholdes

## 4. Kendte edge cases

### CSV-parser
- **Sprog:** danske OG engelske kolonnenavne genkendes via `findColumn()` (substring-match efter fjernelse af ikke-bogstaver).
- **Multiple måleserier i samme fil:** serie-identitet = målepunkts-ID + typekode. Ved flere serier auto-vælges D06 (eksport) + D07 (forbrug); ellers vises dropdown.
- **Kvarter vs. time (blandet per serie):** der bruges INGEN global opløsnings-detektion. `processRows()` aggregerer altid hver valgt serie til timer ved at summere kWh per `hourKey`. For time-data er det identitet; for 15-min summeres 4 rækker → 1 time. Det håndterer korrekt en fil hvor fx E17 er time-data og D06/D07 er 15-min.
- **Måle-støj:** timer under "minimum eksport" (default 0,01 kWh) flagges ikke som problematiske (se `tariffs.minExportKwh` i `analyze()`).

### Tariff-lookup
- **ValidFrom/ValidTo grænser:** Vores `lookupByDate` bruger `validFrom <= date < validTo` (eksklusiv øvre grænse). Records er sorteret nyeste først for hurtig lookup.
- **PT1H vs P1D records:** P1D records har kun Price1 udfyldt (flat daily rate). I `recordsToTariff` fyldes alle 24 timer med samme værdi for at gøre lookup ens i klienten.
- **Indfødnings-tarif null:** Hvis netselskab ikke har separat C-indfødnings-tarif (8 netselskaber pt), behandles supplier_indfodning som 0 i analysen. Kan være forkert hvis netselskab faktisk har en kode vi missede.

### Energinet
- **Reduceret elafgift-periode** (2023-01 → 2023-07): rate var midlertidigt 0,008 kr/kWh under energikrise. Datene afspejler det korrekt.
- **2024-07 ændring i indfødnings-tarif:** Energinet ændrede `40010` fra 0 til 0,003 og senere til 0,005. Vores `mergeRanges` håndterer breakpoints korrekt.

### GitHub Actions
- **Concurrent commits** (workflow + udvikler) løses via `git pull --rebase` + retry i scripts. Hvis konflikt opstår på en JSON-fil, bruges den nyeste version automatisk.
- **6-timers Action-limit** håndteres via inkrementelle commits (hver 5. fil for prices, hver 5. supplier for tariffs). Hvis timeout: re-trig manuelt, springer over allerede backfillede.
- **EDS rate-limit** (~1 kald/15 min for anonymous) håndteres via 3-10 sek sleeps mellem kald + 429-retry med exponential backoff.

## 5. Sådan fortsætter du arbejdet

### Setup på ny maskine
```sh
git clone git@github.com:marurup/solarProductionAnalyzer.git
cd solarProductionAnalyzer

# Start lokal server (KRÆVES — file:// virker ikke, se nedenfor)
python3 -m http.server 8080
# Åbn http://localhost:8080/

# Hvis du vil køre scripts eller CSV-parser-testen lokalt
node --version   # skal være 18+
npm install      # kun papaparse (devDep), til test/parse-check.mjs
```

> **`file://` virker ikke:** browseren blokerer `fetch()` af lokale filer, så pris-/tarif-data fejler. Servér altid over HTTP (`python3 -m http.server`). Appen viser en advarselsbanner hvis den åbnes via `file://`.

### Hyppige opgaver

**Test ændring i index.html:**
1. Edit + save
2. Refresh browser
3. Tjek browser-konsol for fejl

**Debug en CSV-parse-fejl:**
1. Upload CSV → fold **log-sektionen nederst på siden** ud (åbner automatisk ved fejl)
2. Læs log-linjerne (hver med tidsstempel + `[INFO]`/`[WARN]`/`[ERR]`)
3. Eller kør `npm run test:parse` mod filen (lagt i `test-data/`) for samme parse uden browser

**Test ny netselskab-tilføjelse til supplier-map:**
1. Edit `scripts/fetch-tariffs.mjs` `MANUAL_GLN_OVERRIDES` (hvis navne ikke matcher)
2. `ONLY_SUPPLIERS=ny_supplier_id node scripts/fetch-tariffs.mjs`
3. Verificér output i `data/tariffs/{GLN}.json`
4. Commit + push → workflow tager over fremover

**Verificér tariff-tal mod Strømlignings UI:**
1. Åbn https://stromligning.dk/elpriser → indtast adresse → vælg supplier
2. Noter "Transportudgifter til netselskabet" + "Energinet-tariffer" + "Elafgift"
3. Sammenlign med "Vis udregning" på vores app for samme periode
4. Forskelle bør være < 0,01 øre/kWh per komponent

### Filer du ofte vil ændre

- **`index.html`** — hele appen. Vigtige sektioner markeret med `// ─── XXX ─────` kommentar-blokke. CSV-parseren ligger mellem `==PARSE_CORE_START==`/`==PARSE_CORE_END==` (udtrækkes af testen — hold den selvstændig).
- **`status.html`** — debug + cache-view
- **`scripts/fetch-*.mjs`** — backfill-logik
- **`test/parse-check.mjs`** — offline-test af CSV-parseren mod `test-data/`
- **`data/constants/*.json`** — manuelt vedligeholdte konstanter (overskrives af workflow ved næste run)

### Trigger-deeplinks

- **Run "Update spot prices"** → https://github.com/marurup/solarProductionAnalyzer/actions/workflows/update-prices.yml
- **Run "Update tariffs"** → https://github.com/marurup/solarProductionAnalyzer/actions/workflows/update-tariffs.yml
- **Følg fremdrift** → https://github.com/marurup/solarProductionAnalyzer/actions

## 6. Beslutnings-log (vigtige valg)

- **Vanilla JS, ingen build-step** — for at holde det simpelt og gennemskueligt
- **Statisk JSON i repo som data-lag** — løser CORS og rate-limit, gør data versioneret og inspicerbart
- **Strømligning til auto-detect, EDS til faktiske rates** — Strømligning kender netselskab fra koordinater (har ingen historiske rates), EDS DatahubPricelist har komplet historik (men kan ikke fetches fra browseren)
- **Per-time analyse via lookup, ikke ved aggregeret gennemsnit** — distribution varierer fra 11 til 79 øre over døgnet (4-7×), så gennemsnit ville gøre "tabt fortjeneste"-beregningen forkert
- **Markup beholdes i sessionStorage** — det er per produkt og kunne ændre sig, men hentes friskt fra Strømligning ved hver page-load via `cachedJson()` med 24t TTL
- **Spot fra EDS, ikke fra Strømligning** — vi vil ikke blande spot fra flere kilder; én autoritativ kilde (Nord Pool via EDS)
- **Ingen elafgift hardcoded** — EDS er autoritativ (vi fandt fejl i vores oprindelige hardcoded historik for 2022/2023)

## 7. Kontakt-info

- Repo: https://github.com/marurup/solarProductionAnalyzer
- Issues: brug GitHub issues
- Live site: https://marurup.github.io/solarProductionAnalyzer/
- Status: https://marurup.github.io/solarProductionAnalyzer/status.html
