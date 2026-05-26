# Solcelle Eksport-Analyse

Statisk web-app der hjælper danske solcelleejere med at identificere "dårlige eksporttimer" — timer hvor strøm blev solgt til lav/negativ nettopris, og hvor selvforbrug eller batteri havde givet langt højere værdi.

Alt processeres lokalt i browseren — ingen data forlader brugerens maskine.

## Sådan virker det

1. Brugeren uploader CSV-eksport fra eloverblik.dk (én fil med både forbrug og produktion)
2. Appen detekterer automatisk hvilket målepunkt der er eksport (D06) og forbrug (D07) via `målepunktstype_kode`
3. Spotpriser hentes — først fra statiske JSON-filer i repo'et, derefter live fra Energi Data Service for nyere dage
4. Appen beregner netto-eksportpris per time, identificerer dårlige timer, og viser tabt fortjeneste ift. selvforbrug

## Filstruktur

```
.
├── index.html                          # hele appen (vanilla JS, ingen build-step)
├── images/                             # screenshots brugt i UI-guides
├── data/prices/{DK1,DK2}/YYYY-MM.json  # cachede spotpriser (genereret af GitHub Action)
├── scripts/fetch-prices.mjs            # Node-script der henter spotpriser
├── .github/workflows/update-prices.yml # dagligt cron-job + manuel trigger
└── docs/                               # planlægning og overdragelse
```

## Lokal udvikling

Ingen build-step. Server bare statiske filer:

```sh
cd SolarProductionAnalyzer
python3 -m http.server 8080
# Åbn http://localhost:8080/
```

For at teste pris-script lokalt (kræver Node 18+):

```sh
# Hent én måned for ét område (test)
AREAS=DK1 START_DATE=2025-10-01 END_DATE=2025-10-31 node scripts/fetch-prices.mjs

# Hent alt manglende fra default-start (2021-01-01) til i morgen
node scripts/fetch-prices.mjs

# Force-opdater alle filer (også gamle, komplette måneder)
FORCE_UPDATE=1 node scripts/fetch-prices.mjs
```

## Deploy til GitHub Pages

### 1. Opret repo og push

```sh
cd SolarProductionAnalyzer
git init -b main
git add .
git commit -m "Initial commit"

gh repo create solar-eksport-analyse --public --source=. --push
# eller: opret manuelt på github.com og kør:
# git remote add origin git@github.com:<bruger>/<repo>.git
# git push -u origin main
```

### 2. Slå GitHub Pages til

Settings → Pages → Source: **Deploy from a branch** → Branch: `main`, folder: `/` (root) → Save.

Sitet er live på `https://<bruger>.github.io/<repo>/` efter ~1 minut.

### 3. Slå workflow-rettigheder til

Settings → Actions → General → Workflow permissions: **Read and write permissions** → Save.
(Dette er nødvendigt for at workflow'en kan committe nye prisfiler.)

### 4. Kør første backfill

Workflow'en henter ~120 måneder (2021-01 → nu × DK1+DK2) ved første kørsel. På grund af Energi Data Services rate-limit (~1 kald per 100 sek) tager backfill **op til 10 timer**. Den committer løbende.

Actions → "Update spot prices" → **Run workflow** → lad alle felter være tomme → Run workflow.

Følg fremdriften under "Actions"-fanen. Workflow'en committer per kørsel — så hvis den timer ud efter 6 timer (GitHub Actions max-tid), kan du bare trigge igen, og den fortsætter hvor den slap (gamle, komplette måneder springes over).

### 5. Dagligt cron

Workflow'en kører automatisk **dagligt kl. 14:00 UTC** og opdaterer kun aktuel og næste måned (day-ahead-priser for i morgen publiceres ~13:00 CET). Cron'en sover ind igen efter ~30 sekunder hvis intet er ændret.

## Arkitektur — én datakilde i browseren

Browseren henter **kun** spotpriser fra statiske JSON-filer i repo'et (`data/prices/{area}/{YYYY-MM}.json`). Intet live API-kald til Energi Data Service fra klienten.

Hvorfor:
- EDS rate-limiter aggressivt (~1 kald/15 min for anonymous), og fejlsvar mangler CORS-headers → browseren ser dem som NetworkError uden mulighed for håndtering
- Statiske filer er hurtige, cacheable, versionsstyrede, og kan inspiceres direkte i repo'et
- Én datakilde gør debugging og fejlhåndtering simpel

Backfill-flowet:
1. GitHub Action (`scripts/fetch-prices.mjs`) håndterer alle EDS-kald med rate-limit-respekt
2. Den committer månedsfiler løbende (hver 5. fil) — backfill kan tage timer uden at miste arbejde
3. Cron kører dagligt kl. 14:00 UTC og opdaterer kun aktuel/næste måned

Hvis brugeren analyserer en periode hvor backfill ikke er nået endnu, vises en klar fejlbesked med præcis hvilke måneder der mangler.

## Energi Data Service kolonner — gotchas

| Dataset | Periode | Tidskolonne | Priskolonne |
|---|---|---|---|
| `Elspotprices` | før 2025-10-01 | `HourDK` | `SpotPriceDKK` |
| `DayAheadPrices` | fra 2025-10-01 | `TimeDK` | `DayAheadPriceDKK` |

Begge har dansk lokal tid i deres DK-kolonner (ingen UTC-konvertering nødvendig). `DayAheadPrices` leverer 15-min opløsning, så vi aggregerer til timegennemsnit.

## Branchekoder (målepunktstype_kode)

| Kode | Betydning | Brug |
|---|---|---|
| **D06** | Leveret til net | eksport (auto-valgt som eksport) |
| **D07** | Forbrugt fra net | forbrug (auto-indlæst) |
| E17 | Forbrugsmålepunkt | hovedmåler (netto) |
| E18 | Produktionsmålepunkt | målepunktstype |

## Privacy

- Ingen brugerdata sendes til nogen server
- CSV processeres i browseren via FileReader
- Spotpriser caches i IndexedDB lokalt
- GitHub Action sender kun datointerval + prisområde til Energinet — ingen personlige data
