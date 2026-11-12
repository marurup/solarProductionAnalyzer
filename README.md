# Solcelle Eksport-Analyse

Statisk web-app der hjælper danske solcelleejere med at forstå deres eksport-økonomi — hvad de faktisk fik for den strøm de sendte ud på nettet, time for time, med fuld tarif-beregning.

Alt processeres lokalt i browseren — ingen data forlader brugerens maskine.

**Live:** https://marurup.github.io/solarProductionAnalyzer/

## Sådan virker det

1. Brugeren uploader CSV-eksport fra eloverblik.dk (én fil med både forbrug og produktion). CSV'en kan være på **dansk eller engelsk** — kolonnenavne genkendes for begge (`Fra`/`From_date`, `Mængde`/`Volume`, `Målepunktstype_kode`/`Metering_point_type_Code` osv.)
2. Appen detekterer automatisk eksport (D06) og forbrug (D07) via typekoden. Hver måleserie (kombination af målepunkts-ID + typekode) vises med tidsinterval, så man kan se fx at produktionen først er tilføjet senere end forbruget. Blandet opløsning i samme fil håndteres (fx time-data på hovedmåleren og 15-min på D06/D07 — hver serie aggregeres til timer for sig)
3. (Valgfrit) Brugeren indtaster adresse → DAWA autocomplete + Strømligning auto-detect af netselskab
4. Spotpriser hentes fra statiske JSON-filer i repo'et (genereret af GitHub Action)
5. Tarif-data slås op per CSV-time:
   - Netselskabs distribution (per hour-of-day, historiske perioder)
   - Energinets system + transmission + indfødnings + balancetariff
   - Statslig elafgift (varierer per periode)
   - Leverandørs markup (fra Strømligning, dato-aware)
6. Appen beregner per-time `netto_eksport = spot − fradrag` og viser resultater på fanerne Oversigt (søjlediagram + fordeling + månedstabel), Timer under grænse, Alle eksportimer, Månedsoversigt, Afregnings-validering og Elforbrug-validering
7. **(Valgfrit) Inverter-data → fanen "Besparelse".** Brugeren uploader en [energiflow-CSV](docs/energiflow-format.md) (PV, forbrug, batteri og net pr. 5 min–1 time). Appen beregner så den reelle besparelse ved solceller + batteri time for time: *uden anlæg* (forbrug × købspris) minus *faktisk* (køb × købspris − salg × salgspris). Besparelsen deles op i direkte selvforbrug, overskud (salgsværdi), batteri (tidsforskydning, fx natlig opladning fra nettet brugt om aftenen) og afvigelse. Fanen har også en døgnprofil pr. måned og en afstemning af inverterens net-tal mod elmåleren. eloverblik er autoritativ for net-tal hvor den findes; uden eloverblik bruger alle faner inverterens net-tal.

### Inverter-data: åbent format + separate eksportører

Appen henter **ikke** selv data fra invertere. Den importerer ét åbent format, [energiflow-CSV v1](docs/energiflow-format.md), og små separate projekter (*eksportører*) henter fra de enkelte systemer: Home Assistant (dækker SolarAssistant, Growatt, FoxESS, Huawei, SolarEdge …), inverter-clouds osv. Kendte eksportører står i `data/energiflow-kilder.json` og vises i upload-boksen. Det holder leverandør-API'er, logins og deres vedligehold ude af denne repo.

## Arkitektur

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Browseren (index.html, status.html)                                     │
│  • Læser kun statiske filer fra samme origin → ingen CORS, ingen limits   │
│  • IndexedDB-cache for spot, sessionStorage for SL-data                   │
│  • localStorage for brugerkonfiguration (adresse, supplier, produkt)      │
└─────────────────────────────────┬────────────────────────────────────────┘
                                  │
              ┌───────────────────┼───────────────────────┐
              │                   │                       │
         data/prices/         data/tariffs/         data/constants/
         {area}/{ym}.json     {GLN}.json            energinet.json
         (spotpriser)         (netselskabs nettarif) elafgift.json
                              _supplier-map.json
              │                   │                       │
              └───────────────────┼───────────────────────┘
                                  │
                       ┌──────────┴──────────┐
                       │   GitHub Actions    │
                       │  (backfiller alt)   │
                       └──────────┬──────────┘
                                  │
                       ┌──────────┴──────────┐
                       │  EDS DatahubPricelist  │  ← rate-limit + ingen CORS
                       │  DayAheadPrices         │     håndteres KUN her
                       │  + Strømligning /api/   │     (DAWA + SL kaldes
                       │  + DAWA autocomplete    │      live fra browseren)
                       └─────────────────────┘
```

Browseren rammer kun tre offentlige API'er live:
- **DAWA** (`api.dataforsyningen.dk`) — adresse-autocomplete (CORS åbent)
- **Strømligning** (`stromligning.dk/api`) — netselskab fra koordinater + elselskab/produkt + markup (CORS åbent)
- **GitHub API** — seneste commit til version-info i footer

Spotpriser og tariff-data fra Energi Data Service (EDS) er **kun** tilgængelige fra browseren via statiske filer (EDS har rate-limit + manglende CORS på fejlsvar).

## Filstruktur

```
.
├── index.html                          # hele appen
├── status.html                         # cache + tariff-data status
├── images/                             # screenshots til UI-guides
│
├── data/
│   ├── prices/{DK1,DK2}/YYYY-MM.json   # spotpriser, månedlige
│   ├── prices/manifest.json            # liste af tilgængelige måneder
│   ├── tariffs/{GLN}.json              # netselskabs nettarif (consumption + indfødning)
│   ├── tariffs/_supplier-map.json      # Strømligning supplier_id → EDS GLN + koder
│   ├── produktionsaftagere.json        # manuel liste over elhandlere der køber overskudsstrøm
│   ├── energiflow-kilder.json          # manuel liste over eksportører der skriver energiflow-CSV
│   └── constants/
│       ├── energinet.json              # system+transmission+indfødn+balance, historik
│       └── elafgift.json               # statslig elafgift, historik
│
├── scripts/
│   ├── fetch-prices.mjs                # spotpris-backfill (EDS DayAhead/Elspot)
│   ├── fetch-tariffs.mjs               # netselskabs nettariffer-backfill (DatahubPricelist)
│   └── fetch-energinet.mjs             # Energinet + elafgift (DatahubPricelist)
│
├── test/
│   ├── parse-check.mjs                 # kører den ægte CSV-parser (udtrukket fra index.html) mod test-data/
│   ├── energiflow-check.mjs            # tester energiflow-parser + pris- og besparelsesmodel (udtrukket fra index.html)
│   └── fixtures/energiflow-sample.csv  # syntetisk fixture (sommertid, 15-min, tællerfejl, natlig opladning)
├── test-data/                          # (git-ignoreret) private eloverblik-CSV'er til lokal test
├── package.json                        # kun devDep: papaparse (til parse-check.mjs)
│
├── .github/workflows/
│   ├── update-prices.yml               # daglig spotpris-backfill (14:00 UTC)
│   └── update-tariffs.yml              # månedlig tariff-backfill (1. i mdr.)
│
└── docs/
    ├── HANDOVER.md                     # projekt-state og fortsættelse
    ├── energiflow-format.md            # åben spec for inverter-import (energiflow-CSV v1)
    └── overdragelse-solcelle-analyse.md # original planlægning
```

## Lokal udvikling

Ingen build-step. Server de statiske filer over HTTP:

```sh
cd SolarProductionAnalyzer
python3 -m http.server 8080
# Åbn http://localhost:8080/  (IKKE file:// — se nedenfor)
```

> ⚠️ **Åbn ikke `index.html` direkte som en fil (`file://`).** Browseren blokerer `fetch()` af lokale filer under `file://`, så alle pris-/tarif-data fejler med "Failed to fetch", og analysen melder fejlagtigt at spotpriser mangler. Appen viser en advarselsbanner hvis den åbnes sådan. Brug altid en webserver.

### Test af CSV-parseren

`test/parse-check.mjs` kører den ægte parser — udtrukket direkte fra `index.html` mellem `==PARSE_CORE_START==`/`==PARSE_CORE_END==`-markørerne, så testen aldrig kan drive fra produktionskoden. Læg en eloverblik-CSV i `test-data/` (git-ignoreret) og kør:

```sh
npm install            # henter papaparse (eneste devDep)
npm run test:parse                      # første *.csv i test-data/
node test/parse-check.mjs sti/til.csv   # specifik fil
```

### Test af energiflow-import og besparelsesmodel

`test/energiflow-check.mjs` udtrækker blokkene `==INVERTER_PARSE_START/END==` (energiflow-parseren) og `==ANALYSIS_CORE_START/END==` (købs-/salgspris, `analyze`, `analyzeConsumption`, `analyzeSavings`) fra `index.html`. Den kører dem mod det committede, syntetiske fixture `test/fixtures/energiflow-sample.csv` med håndregnede forventede værdier: sommertidsskift, 15-min-aggregering, tællerfejl, at besparelsesposterne summerer eksakt, og at elmålerens tal overstyrer inverterens.

```sh
npm test               # = npm run test:energiflow
```

Den viser måleserier, tidsintervaller, aggregerede timetal og om "Hent spotpriser"-knappen ville aktiveres.

Backfill-scripts kører Node 18+:

```sh
# Hent spotpriser
node scripts/fetch-prices.mjs                          # alt manglende
AREAS=DK1 START_DATE=2026-01-01 END_DATE=2026-01-31 \
  node scripts/fetch-prices.mjs                        # specifik måned for testing
FORCE_UPDATE=1 node scripts/fetch-prices.mjs           # gen-fetch alt

# Hent netselskabs tariffer (alle 34 fra Strømligning)
node scripts/fetch-tariffs.mjs
ONLY_SUPPLIERS=n1_c,radius_c node scripts/fetch-tariffs.mjs   # specifik

# Hent Energinet + elafgift constants
node scripts/fetch-energinet.mjs
```

## Deploy til GitHub Pages

1. **Push til repo:** `gh repo create` eller manuel oprettelse + `git push -u origin main`
2. **Pages:** Settings → Pages → Branch `main` / folder `/` (root) → Save
3. **Workflow-rettigheder:** Settings → Actions → "Read and write permissions"
4. **Backfill prisdata:** Actions → "Update spot prices" → Run workflow (~2-3 timer for 5 år × 2 områder, committer pr. 5 filer)
5. **Backfill tariffer:** Actions → "Update tariffs" → Run workflow (~5 min for 34 netselskaber + Energinet)
6. **Crons:** Spotpriser opdateres dagligt 14:00 UTC, tariffer månedligt 1. i måneden

## Energi Data Service kolonner — gotchas

| Dataset | Periode | Tidskolonne | Priskolonne |
|---|---|---|---|
| `Elspotprices` | før 2025-10-01 | `HourDK` | `SpotPriceDKK` |
| `DayAheadPrices` | fra 2025-10-01 | `TimeDK` | `DayAheadPriceDKK` |
| `DatahubPricelist` | hele historik | (statiske rates per periode) | `Price1`..`Price24` per hour-of-day |

Spot-datasettene har dansk lokal tid i DK-kolonnerne. `DayAheadPrices` har 15-min opløsning → aggregeres til timegennemsnit. `DatahubPricelist` records har enten `ResolutionDuration=PT1H` (per hour-of-day, distribution) eller `P1D` (daglig flat, fx indfødning).

## Branchekoder (eloverblik CSV)

`målepunktstype_kode` / `Metering_point_type_Code` i CSV:

| Kode | Betydning | Brug i appen |
|---|---|---|
| **D06** | Leveret til net | auto-valgt som eksport |
| **D07** | Forbrugt fra net | auto-indlæst som forbrug |
| E17 | Forbrugsmålepunkt | hovedmåler (netto) |
| E18 | Produktionsmålepunkt | målepunktstype |

### CSV-parser — gotchas

- **Dansk + engelsk:** eloverblik eksporterer på begge sprog. `findColumn()` matcher begge navnesæt (fx `Fra`/`From_date`, `Mængde`/`Volume`, `Målepunktsid`/`Metering_point_ID`).
- **Måleserie = målepunkts-ID + typekode:** et enkelt målepunkt kan bære flere flows (D06/D07/E17) — de skelnes på typekoden, ikke kun ID.
- **Blandet opløsning per serie:** samme fil kan have time-data på ét flow og 15-min på et andet. Der bruges ikke én global opløsning; hver serie aggregeres til timer ved at summere kWh per `hourKey` (energi er additiv → korrekt for både time- og kvarterdata).
- **Minimum eksport:** timer med forsvindende lidt eksport (måle-støj mellem inverter og el-måler, fx 0,001 kWh) flagges ikke som problematiske. Grænse i UI, default 0,01 kWh.

## Privacy

- Ingen brugerdata sendes til nogen server vi kontrollerer
- CSV processeres i browseren via FileReader (både eloverblik og energiflow/inverter-data)
- Spotpriser caches i IndexedDB lokalt
- Strømligning-kald sender kun (koordinater fra DAWA, supplier_id, product_id) — ingen personlige data
- DAWA-kald sender kun adresse-query — ingen identifikatorer
- GitHub Actions sender kun datointervaller + GLN'er til EDS — ingen brugerinfo
