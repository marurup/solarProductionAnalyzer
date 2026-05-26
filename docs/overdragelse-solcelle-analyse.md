# Solcelle Eksport-Analyse — Projektoverdragelse

**Status:** Planlægningsfase afsluttet, klar til POC/implementering
**Dato:** Maj 2026
**Næste session:** Desktop app (Claude Code eller længere chat)

---

## 1. Projektets formål

Bygge et statisk website (GitHub Pages) til danske solcelleejere, der:

1. Importerer **forbrugs- og eksport-data** fra eloverblik.dk (CSV-upload i MVP)
2. Sammenholder med **spotpriser** fra Energi Data Service
3. Anvender **tariffer og gebyrer** for korrekt nettopris-beregning
4. **Identificerer "dårlige eksporttimer"** — timer hvor strøm blev solgt til lav/negativ nettopris, og hvor selvforbrug eller batterilagring kunne have givet langt højere værdi

**Primær værdi:** Vise solcelleejere den reelle økonomiske forskel mellem eksport og selvforbrug — en forskel der typisk er en faktor 4-10x, men som de fleste flyver blindt mht.

---

## 2. Afklarede scope-beslutninger

| Beslutning | Valg | Begrundelse |
|---|---|---|
| Datatilgang (MVP) | CSV-upload fra eloverblik | Holder det rent statisk på Pages, ingen secrets-håndtering nødvendig |
| Målgruppe | Start personligt, åbn for alle senere | Designet skal være single-user, men skalerbart |
| Primær analyse | Tabt fortjeneste / dårlige eksporttimer | Andre features (batteri-sim, leverandør-sammenligning) er parkeret til senere |
| Tariff-håndtering | Strømligning-lookup som validering + manuel indtastning som hovedinput | Indfødnings-tariffer er små stabile tal — kurateret tabel slår fragilt API-opslag |

---

## 3. Teknisk arkitektur

### Stack
- **Hosting:** GitHub Pages (statisk)
- **Frontend:** Vanilla JS eller Svelte (begge fungerer — vælg ud fra om du gider build-step)
- **CSV-parsing:** PapaParse (kommer-separator + dansk decimal-komma)
- **Charts:** uPlot (anbefalet for 8760+ datapunkter/år, langt hurtigere end Chart.js)
- **Lokal cache:** IndexedDB direkte eller via Dexie.js (så data ikke skal genuploades)
- **Dato-håndtering:** Luxon eller date-fns med eksplicit format-parsing (UNDGÅ `new Date()`)

### Privacy-vinkel (salgspoint)
Alt processeres lokalt i browseren — ingen data forlader brugerens maskine. Vigtig differentiator vs. kommercielle alternativer.

### Skaleringssti (når MVP åbnes for andre)
- Hold al state i URL params eller localStorage — ingen backend
- Adresseopslag via postnummer → netselskab (Strømligning API)
- Brugerprofil (netselskab, leverandør, aftaler) eksporteres/importeres som JSON
- Fase 3 muligheder: Cloudflare Workers + D1 for anonymiseret benchmarking
- DataHub API direkte (ikke CSV) kræver serverless proxy pga. token-secret

---

## 4. Datakilder — verificeret status

### 4.1 Eloverblik.dk (DataHub)
- **MVP:** Manuel CSV-eksport fra browser
- **Format-fælder at håndtere fra start:**
  - Resolution kan være time eller kvarter (efter overgang til 15-min afregning) — detektér automatisk
  - Decimal-separator er komma (dansk locale)
  - Dato-format varierer — parse eksplicit
  - To separate CSV'er: forbrug og eksport (produktion)
- **Senere:** Third-party API kræver refresh tokens via egen profil + serverless backend

### 4.2 Energi Data Service (spotpriser)
- **Endpoint:** `api.energidataservice.dk/dataset/DayAheadPrices`
- **VIGTIGT:** `Elspotprices` blev udfaset efter 2025-09-30 — brug `DayAheadPrices` med fallback for historiske data før denne dato
- CORS åbent — kan kaldes direkte fra browseren
- Gratis, ingen auth
- **Sommertid-håndtering:** Brug `HourDK`/`TimeDK` felter — ellers får du fejl ved DST-overgangene (23 eller 25 timer på et døgn to gange årligt)

### 4.3 Strømligning.dk
- **Endpoint base:** `stromligning.dk/api/...` (Swagger på `/api/docs` men SPA-baseret)
- **Funktioner:**
  - Postnummer/GPS → netselskab-opslag
  - Komplette forbrugspriser inkl. transport, elafgift, systemtariffer
  - Elselskaber/produkter med Strømligning Score, tillæg, abonnementer
- **Begrænsning:** Fokus er forbrugssiden — ikke en direkte kilde til indfødningstariffer
- **Anvendelse i MVP:** Krydstjek/validering af brugerens manuelt indtastede produktions-gebyrer

---

## 5. Det centrale regnestykke

### Pr. eksporteret kWh i time t:

```
netto_eksport_pris(t) = spotpris(t)
                       − energinets_balancetarif
                       − energinets_indfødningstarif
                       − netselskabets_indfødningstarif
                       − leverandørens_balancetarif/gebyr
```

### Reference-tal (DK2, Andel Energi som produktionsleverandør, Radius som netselskab):
- Energinets balancetarif: 0,65 øre/kWh
- Energinets indfødningstarif: 0,50 øre/kWh
- Netselskabets indfødningstarif (Radius): 0,47 øre/kWh
- Andel Energis balancetarif: 3,00 øre/kWh
- **Total fradrag: ~4,62 øre/kWh**

### Vigtigt forbehold — aftagepligt-fritagelse
Mange ældre husstandssolceller er omfattet af VE-lovens aftagepligt og **fritaget for indfødningstariffer**. Andre netselskabers tariffer er også lave (fx 0,3 øre/kWh).

**UI-konsekvens:** Skal være tydelig checkbox: *"Mit anlæg er omfattet af aftagepligt (typisk anlæg installeret før 2023)"*

### Sammenligning til selvforbrug
Selvforbrug sparer: `spotpris + nettarif + elafgift` (~2,80 kr/kWh totalt for typisk husstand)
vs. eksport: `spotpris − ~5 øre`

→ **Faktor 4-10x forskel.** Det er denne forskel hele værktøjet handler om at synliggøre.

---

## 6. UI-design for tariff-håndtering

Tre niveauer:

### Quick mode (default)
- Postnummer + produktionsleverandør fra dropdown
- Hardcoded tabel med Energinets tariffer + leverandørens gebyrer
- "God nok"-præcision til hovedanalysen
- Aftagepligt-checkbox

### Manual mode
Fire eksplicitte felter:
- Energinets balancetarif (øre/kWh)
- Energinets indfødningstarif (øre/kWh)
- Netselskabets indfødningstarif (øre/kWh)
- Leverandørens gebyr/balancetarif (øre/kWh)
- Plus aftagepligt-checkbox

### Strømligning-lookup
- Sekundær validering af manuelt indtastede tal
- Postnummer → netselskab → sanity check

---

## 7. "Dårlig eksport"-detektion

En time markeres som problematisk hvis:

1. **`netto_eksport_pris(t) < 0`** — du betalte for at give strøm væk (særligt om sommeren midt på dagen)
2. **`netto_eksport_pris(t) < tærskel`** (fx 10 øre) — strømmen var næsten gratis at eksportere, og fleksibelt forbrug (varmtvandsbeholder, EV-ladning, batteri) kunne have undgået senere dyrere indkøbstimer

Punkt 2 er den interessante — den kobler sig direkte til automatisering via Home Assistant / SolarAssistant.

---

## 8. Visualiseringer (prioriteret rækkefølge for MVP)

1. **Kalender-heatmap** (år × time-på-døgnet), farvet efter netto eksport-pris — viser mønstre øjeblikkeligt
2. **Top-20 dårligste eksporttimer** som sorterbar tabel: dato, kWh eksporteret, spotpris, netto-pris, tabt værdi vs. selvforbrug
3. **Akkumuleret graf:** hvad du fik vs. hvad du *kunne have sparet* ved selvforbrug
4. **Månedsoversigt:** total eksport, total indtægt, gennemsnitlig netto-pris pr. kWh

---

## 9. Næste skridt — to forslag

### Variant A: Proof-of-concept artifact først
Single-file HTML der parser eloverblik-CSV (kræver eksempel-fil), henter spotpris fra Energi Data Service, og laver "tabt fortjeneste"-analysen.

**Fordel:** Hurtig validering af at datakildernes formater spiller sammen i praksis, før investering i build-pipeline.

### Variant B: Repo-struktur og deploy-pipeline først
Definer filstruktur, JS-framework-valg, GitHub Actions til Pages-deploy, derefter bygge funktionalitet.

**Fordel:** Solidt fundament for fortsat udvikling.

**Anbefaling:** Variant A først — datakilder er den største usikkerhed, og en POC afslører hurtigt om CSV-formatet kræver special-håndtering.

---

## 10. Åbne spørgsmål til næste session

- [ ] Skaf et eksempel-CSV fra eloverblik (både forbrug og eksport) til format-verifikation
- [ ] Tjek CORS-headers på Strømligning API fra browseren (kritisk for statisk hosting)
- [ ] Beslut JS-framework: vanilla vs. Svelte vs. andet
- [ ] Beslut om POC skal være embedded artifact eller direkte GitHub repo fra start
- [ ] Identificer evt. eksisterende open-source projekter at lære af / forke (energi-relaterede DK-projekter)

---

## 11. Reference-kilder konsulteret under planlægning

- Energi Data Service dokumentation (DayAheadPrices)
- Strømligning API artikel + Swagger-side
- FLOW Elnet — indfødningstarif-information og aftagepligt
- Andel Energi — produktionsaftale-vilkår og tariff-eksempler
- N1, KONSTANT, Forsyningen.dk — netselskabers tariff-information
- Modstrøm, EasyGreen — produktionsaftale-sammenligninger

---

*Dokument klar til genoptagelse i desktop session. Læs fra top — alle scope-beslutninger og tekniske valg er allerede truffet, så næste session kan gå direkte til implementering.*
