# Solcelle Eksport-Analyse

Statisk web-app der hjælper danske solcelleejere med at identificere "dårlige eksporttimer" — timer hvor strøm blev solgt til lav/negativ nettopris, og hvor selvforbrug eller batteri havde givet langt højere værdi.

Alt processeres lokalt i browseren — ingen data forlader brugerens maskine.

**Live:** https://marurup.github.io/solarProductionAnalyzer/

## Sådan virker det

1. Brugeren uploader CSV-eksport fra eloverblik.dk (én fil med både forbrug og produktion)
2. Appen detekterer automatisk eksport (D06) og forbrug (D07) via `målepunktstype_kode`
3. (Valgfrit) Brugeren indtaster adresse → DAWA autocomplete + Strømligning auto-detect af netselskab
4. Spotpriser hentes fra statiske JSON-filer i repo'et (genereret af GitHub Action)
5. Tarif-data slås op per CSV-time:
   - Netselskabs distribution (per hour-of-day, historiske perioder)
   - Energinets system + transmission + indfødnings + balancetariff
   - Statslig elafgift (varierer per periode)
   - Leverandørs markup (fra Strømligning, dato-aware)
6. Appen beregner per-time `consumer_price = spot × 1,25 + tariffer × 1,25` og `netto_eksport = spot − fradrag`, finder dårlige timer, viser tabt fortjeneste

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
│   └── constants/
│       ├── energinet.json              # system+transmission+indfødn+balance, historik
│       └── elafgift.json               # statslig elafgift, historik
│
├── scripts/
│   ├── fetch-prices.mjs                # spotpris-backfill (EDS DayAhead/Elspot)
│   ├── fetch-tariffs.mjs               # netselskabs nettariffer-backfill (DatahubPricelist)
│   └── fetch-energinet.mjs             # Energinet + elafgift (DatahubPricelist)
│
├── .github/workflows/
│   ├── update-prices.yml               # daglig spotpris-backfill (14:00 UTC)
│   └── update-tariffs.yml              # månedlig tariff-backfill (1. i mdr.)
│
└── docs/
    ├── HANDOVER.md                     # projekt-state og fortsættelse
    └── overdragelse-solcelle-analyse.md # original planlægning
```

## Lokal udvikling

Ingen build-step. Server bare statiske filer:

```sh
cd SolarProductionAnalyzer
python3 -m http.server 8080
# Åbn http://localhost:8080/
```

Scripts kører Node 18+:

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

`målepunktstype_kode` i CSV:

| Kode | Betydning | Brug i appen |
|---|---|---|
| **D06** | Leveret til net | auto-valgt som eksport |
| **D07** | Forbrugt fra net | auto-indlæst som forbrug |
| E17 | Forbrugsmålepunkt | hovedmåler (netto) |
| E18 | Produktionsmålepunkt | målepunktstype |

## Privacy

- Ingen brugerdata sendes til nogen server vi kontrollerer
- CSV processeres i browseren via FileReader
- Spotpriser caches i IndexedDB lokalt
- Strømligning-kald sender kun (koordinater fra DAWA, supplier_id, product_id) — ingen personlige data
- DAWA-kald sender kun adresse-query — ingen identifikatorer
- GitHub Actions sender kun datointervaller + GLN'er til EDS — ingen brugerinfo
