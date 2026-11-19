# Handover-dokument — Solcelle Eksport-Analyse

**Sidst opdateret:** 2026-11-12
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
  - Eksport-formel: `netto_eksport = spot − (Energinet balance + indfødning + netselskab indfødning) × 1,25 − t4`
  - Forbrug-formel (til Elforbrug-validering): `forbrugspris = spot × 1,25 + tariffer × 1,25`
  - Fallback til manuelle felter (`t1`..`t4`, `selfConsumpOverhead`) hvis tariff-data ikke tilgængelig for valgt supplier
- **Analyse-resultater — 5 faner:**
  - **Oversigt** (default): søjlediagram over månedlig eksport-indkomst, fordelt på 4 kategorier (god/lav/dårlig/negativ pris), månedstabel med indkomst + timerfordeling + "Betalt for eksport", KPI-grid med nøgletal
  - **Timer under grænse**: filtreret tabel med kun timer under grænseværdien (sortérbar)
  - **Alle eksportimer**: komplet tabel over alle eksportimer, nyeste øverst, farvekodet
  - **Månedsoversigt**: aggregeret månedstabel
  - **Afregnings-validering** + **Elforbrug-validering**: se eksisterende beskrivelse
- **4-delt kategori-system** i oversigten: god pris (grøn) · lav pris/advarsel (amber) · dårlig men positiv (orange) · negativ pris (rød). Hver har eget badge + tabel-farve. Baggrund: negativ pris = man *betaler* for at eksportere; dårlig = man tjener lidt, men under grænseværdien. Kæmpe praktisk forskel.
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

### Korrekthed
- **✅ Produktionsafregning fuldt verificeret over 20 måneder (2026-07-07).** Afstemt mod ALLE brugerens rigtige Vindstød-afregninger (N1, DK1) fra 2024-10 til 2026-05:
  - **kWh matcher eksakt** alle 20 måneder (bekræfter CSV-parsing, per-serie aggregering og time-opslag).
  - **Beregnet netto matcher inden for ±0,02 kr/måned** (ren øre-afrunding). Total over 20 mdr: app 3284,60 kr vs. opgørelse 3284,61 kr → −0,01 kr.
  - **Delvis første måned håndteret korrekt:** 2024-10 dækker kun 28.–31. okt (25 kWh); verifikationen filtrerede appens eksport til den faktiske periode.
  - **Metode:** `pdftotext -layout` udtræk af hver afregnings-PDF (periode, kWh, produktions-beløb, tarif-beløb), sammenlignet med appens netto = spot − (Energinet balance + Energinet indfødning + N1 netselskab-indfødning) × 1,25 − `t4`. PDF'erne ligger i `test-data/afregninger/` (git-ignoreret).
  - **Nøglekonklusioner:** tarifferne (EDS) er korrekte; **moms ×1,25 er korrekt** (kun på tarifferne, ikke på salget); **`t4`-default rettet 3,00 → 0**; **Vindstød tager et fast spread på 1,00 øre/kWh** (spot − 1 øre) → modelleres med `t4 = 1,0`. `t4` dækker både gebyr OG spread; default 0 fordi det er handler-specifikt.

### Næste skridt (planlagt)
- **Første eksportør er lavet: `solarProductionAnalyzer-exporter-solarAssistant`** (separat repo, ligger lokalt som `C:\Projects\solarProductionAnalyzer-exporter-solarAssistant`).
  - Læser SolarAssistants backup-zip, som er en InfluxDB 1.8 portable backup med TSM-shards. Det sker i browseren uden afhængigheder, og der er også en Node-CLI.
  - Bruger SA's egne timemålinger (`PV/Load/Battery in/out/Grid in/out power hourly`, gennemsnits-W = Wh) og SOC.
  - Verificeret mod HA inden for 0,3 % (jun og nov 2026).
  - Posten i `data/energiflow-kilder.json` er sat til `klar` med GitHub Pages-URL. Push begge repos samtidig og slå Pages til på det nye.
- **Næste eksportør: Home Assistant** (separat repo, navn ikke endeligt). Statisk side, der via HA-websocket (`recorder/statistics_during_period`, period `hour`) med URL + long-lived token henter energitællerne og skriver energiflow-CSV. Entiteter foreslås ud fra `device_class: energy` og mappes af brugeren. Dertil en Node-CLI med samme kode til HA på lokal http (https-sider må ikke åbne `ws://`). Dækker alt med en HA-integration, også SolarAssistant via MQTT. Ret posten i `data/energiflow-kilder.json` til `status: "klar"` + `url`, når den er ude. Senere: FoxESS Open API og Growatt (uofficiel) som egne eksportører.
- **Leverandørtillæg pr. periode (produkthistorik).** Appen bruger i dag ét tillæg, nemlig det valgte Strømligning-produkt, for hele perioden. Brugere skifter produkt.
  - Eksempel: Vindstød "Elforbundet fællesaftale" har tillæg 0, "TimeEl" ca. 31,2 øre/kWh ekskl. moms. Brugeren havde TimeEl jan–feb 2026, og det kommer igen fra 1. jan 2027.
  - Forslag: en lille liste "fra dato → tillæg (øre/kWh) eller produkt" i Køb-panelet, gemt i konfigurationen og slået op pr. time i `lookupHourlyComponents` (feltet `markup.ranges` findes allerede).
  - Påvirker "Elforbrug-validering" og besparelsen (tillæg × kWh dækket af sol/batteri). På brugerens data giver det +108 kr for jan–feb 2026.
- ~~**Verificér elforbrug-regninger**~~ **Gjort 2026-11-19** for de variable dele (se "Verifikation af besparelsestallene"): kWh, tariffer, elafgift og tillæg passer på øret i 4 kvartaler. **Mangler:** faste abonnementer (Vindstød, N1 rådighed og abonnement, Energinet), som ikke indgår i besparelsen. Mangler også Elforbrug-validering-fanens månedstal stillet direkte mod regningerne, ikke kun via det uafhængige script.
### Data-fuldstændighed
- **Videbæk Elnet** kunne ikke auto-matches til EDS (kun 34 af 38 Strømligning suppliers er backfillet). Skal undersøges hvor de findes i EDS.
- **8 netselskaber har ingen indfødningskode** (`null` i supplier-map): N1 (har faktisk `C INDF` nu — fix kom efter), Aal El-Net, Cerius, Dinel, El-net Kongerslev, Elektrus, Elinor, Elnet Midt, m.fl. — disse netselskaber har enten reelt ingen separat C-indfødning, eller auto-discovery missede det. Verificér mod Strømlignings UI eller netselskabernes egne sider. **Note:** N1 fik faktisk `C INDF` ved seneste run; lokalt vises 26/34 med kode efter merge fra eksisterende filer.
- **Energinet 2019 og tidligere** mangler i `data/constants/energinet.json`. EDS har historik længere tilbage — udvid `fetch-energinet.mjs` til at hente mere.

### Nye features (implementeret)
- ✅ **Inverter-import + fanen "Besparelse" (2026-11-12).** Ny valgfri drop-zone i trin 1 for **energiflow-CSV v1** (`docs/energiflow-format.md`): PV, forbrug, batteri ind/ud, net ind/ud pr. 5 min–1 time, ISO-tid med offset. Appen henter **ikke** selv fra invertere. Separate eksportører skriver formatet og listes fra `data/energiflow-kilder.json` (samme mønster som produktionsaftagere).
  - **Parser** (`==INVERTER_PARSE_START/END==`): aggregerer til danske timenøgler via `Intl` (Europe/Copenhagen). Sommertidstimen i oktober lægges sammen, ligesom spotpriser/eloverblik. Tomme celler bliver null (ukendt), negative værdier (tællerfejl) ignoreres, og huller samt energibalance rapporteres.
  - **Pris pr. time udtrukket** til `buyPriceOere()`/`sellPriceOere()`, som `analyze`, `analyzeConsumption` og `analyzeSavings` alle bruger. Refaktoreringen er bevist neutral på de rigtige data (2021–2026, 417 tal, maks. afvigelse 6·10⁻¹⁴).
  - **`analyzeSavings()`** fordeler hver time: PV→hus, PV→batteri, PV→net, net→batteri, batteri→hus, batteri→net. Besparelse = forbrug × købspris − (køb × købspris − salg × salgspris), opdelt i *direkte selvforbrug*, *overskud (salgsværdi)*, *batteri (tidsforskydning)* og *afvigelse* (omdøbt 2026-11-19, se nedenfor). Posterne summerer eksakt. Net-tal tages fra eloverblik, hvor **både** D06 og D07 dækker timen, ellers fra inverteren.
  - **UI:** KPI'er, månedligt stablet søjlediagram (divergerende), døgnprofil pr. måned (forbrug dækket af sol/batteri/net over aksen, batteriopladning under) med købspris-kurve på samme timeakse, og månedstabel med afstemning inverter mod elmåler. Uden eloverblik-fil bruger eksport- og forbrugsfanerne inverterens net-tal.
  - **Verificeret på brugerens data** (Growatt via SolarAssistant → HA): nov 1.–11. 2026 viser net→batteri kl. 02–05 (~2,33 kr/kWh) og batteri→hus kl. 16–20 (3,80–4,66 kr/kWh). Batteri +177 kr, besparelse 538 kr. Jun 2026 mod eloverblik: inverterens eksport −0,9 %, import −13 % (små tal, 36 mod 41,5 kWh). Afvigelse 34 kr af 1866 kr.
  - **Test:** `npm test` (`test/energiflow-check.mjs`, 58 assertions mod syntetisk fixture).
- ✅ **Besparelse: forklaringer, dagsgennemgang og usete køb (2026-11-19).**
  - **Nye navne:** *Solstrøm brugt direkte*, *Solstrømmens salgsværdi*, *Batteriets merværdi* og *Måleafvigelse og tab*. Der er en læsevejledning øverst, KPI'er med kWh × kr/kWh og en omskrevet formelboks.
  - **"Gennemgang af et døgn"** (`renderSavingsDay`, data i `analyzeSavings().days`: 24 buckets pr. dag med `soc`/`batMissing`). Den viser:
    - trin 1 (uden anlæg mod faktisk) og trin 2 (de fire poster, hvor batteriet er splittet i + brugt / − ladet)
    - automatiske noter (SOC ved start/slut, negative timer, huller, usete køb)
    - besparelse pr. time, flow-graf, pris og en timetabel
  - Dag vælges med datovælger eller ‹ ›, og klik på en måned i månedsgrafen springer dertil. `renderFlowCharts` deles med døgnprofilen (`mode: 'avg'|'sum'`).
  - **Usete køb (`unseenLoad`):** køber elmåleren mere end inverteren i en time, lægges differencen til forbruget i begge regninger. Det påvirker ikke besparelsen og holder differencen ude af afvigelsen.
    - Fundet på brugerens data: okt–dec 2025 rapporterede Growatt'en 0 W for net og forbrug, når batteriet var på minimum (10–11 %) og der ikke var sol. Inverteren sov, mens huset (inkl. elbil kl. 02–03) fik strøm direkte fra nettet. SolarAssistant samplede hele tiden (~390/time), men fik nuller. SA logger effekt ("forbrug nu") og integrerer, så energien i dvale-perioder går tabt.
    - **Skiftet skete 18. dec 2025 ~kl. 13**, ikke ved Growatts firmwareopdatering 6. jan 2026, som var brugerens første hypotese. Tidslinje:
      - 11. dec: første natteopladning fra nettet (test).
      - 12.–17. dec: batteriet holdes på ~32 % uden afladning, og inverteren sover stadig om natten. Den melder SOC 0 % og alle effekter 0 W, når den sover.
      - 18. dec kl. 13: normal afladning til 10 %, og inverteren forbliver vågen.
      - Fra 19. dec: natteopladning hver nat (~18 kWh).
    - Før skiftet sov inverteren i 72 % af timerne med tomt batteri og ingen sol. Elmåleren viste 1.215 kWh, inverteren 225 kWh.
    - Fra 19. dec til 5. jan, altså før firmwaren, var der 37 timer med tomt batteri og ingen sol uden dvale. Efter 10. jan er der 268 sådanne timer uden dvale, og inverteren ser 99 % af elmålerens køb.
    - Sandsynlig årsag: indstillingerne for natteopladning (AC-opladning/tidsplan) holder inverteren aktiv. SolarAssistants hul 6.–9. jan 2026 (77 t) er selve firmwareopdateringen.
    - Effekt i alt: 1.363 kWh lagt til forbruget. Afvigelsen gik fra −2.085 kr til +535 kr, og nov/dec 2025 gik fra negativ til positiv besparelse.
- ✅ **Afstemning mod regning og salg i Besparelse-fanen (2026-11-19)** (`renderReconciliation`). Pr. måned, kvartal eller år vises kæden *køb − salg = faktisk*, *− uden for besparelsen*, *+ besparelse = uden anlæg* og forbruget i kWh.
  - Køb og salg regnes over hele måneder fra elmåler-data, som i Elforbrug- og Afregnings-validering, men uden abonnementer.
  - "Uden for besparelsen" er timer med elmåler-data, men uden inverter-data (minus), eller omvendt (plus).
  - Brugeren kan taste regningens variable del ekskl. moms og udbetalingen pr. periode. De gemmes i `solar-reconcile-v1`, og forskellen vises med ✓.
  - Er alle måneder i perioden udfyldt i valideringsfanerne, bruges summen derfra (regning − abonnement, udbetaling + abonnement).
  - På brugerens data passer 4 kvartaler inden for 3 øre for både køb og salg. Kun "uden anlæg", altså forbruget i kWh fra inverteren, kan ikke afstemmes mod et dokument.
- ✅ **Verifikation af besparelsestallene (2026-11-19)** på brugerens data, feb 2025–nov 2026.
  - **Koden:** et uafhængigt script med egen parsing af SA-CSV, eloverblik, spot og tariffer gav samme resultat som `analyzeSavings` i alle 22 måneder (maks. 5·10⁻¹³ kr, total 29.112,24 kr).
  - **Salg end-to-end:** elmålerens D06 × salgspris mod Vindstøds afregninger for 24 måneder (okt 2024–sep 2026) gav 5.980,42 mod 5.980,38 kr (±0,02 kr/md). Det verificerer spotpriser (også timesnit af 15-min-priser fra okt 2025), Energinet og N1-indfødning, moms og t4.
  - **Køb end-to-end:** D07 (= E17, som regningerne afregnes på) mod Vindstøds 4 kvartalsregninger for forbrug (okt 2025–sep 2026, `test-data/regninger/`).
    - **Tariffer** (N1-nettarif time for time + Energinet system + transmission) og **elafgift** (0,72 kr i 2025, 0,008 kr i 2026) passer på øret i alle 4 kvartaler.
    - **Strøm** er ren spotpris på produktet *Elforbundet fællesaftale* (Q4 2025, mar–sep 2026: tillæg 0,00 øre).
    - Jan–feb 2026 var brugeren på *TimeEl*. Det implicitte tillæg er **31,2 øre/kWh ekskl. moms** (726 kr over 2.328 kWh).
    - Kontrakten overgår til TimeEl igen 1. jan 2027.
    - Appen regner med ét leverandørtillæg ad gangen (Strømligning-produktet). Med TimeEl-tillægget i jan–feb 2026 stiger besparelsen 108 kr (29.112 → 29.220 kr).
    - **Idé:** tillæg pr. periode (produkthistorik).
  - **Stikprøver** af spotpris mod EDS (15. jun 2025, 20. jan 2026) gav 0,0000 øre i forskel.
  - **Kendt usikkerhed: SA's "forbrug" er udregnet, ikke målt.** Energibalancen går op til 0,0 % hver måned, så inverterens konverteringstab og standby ligger i "forbrug" og dermed i "uden anlæg". Det overvurderer besparelsen med tab × købspris, men tabet kan ikke måles med de nuværende data.
    - E18 er identisk med D06 og dermed ikke en brutto-produktionsmåler.
    - Ved 3 % tab af sol + batteri ud (~32 MWh) bliver det ca. 1.000 kWh ≈ 2.000 kr af 29.112 kr.
    - Batteri ud/ind er 100,7 % over perioden og 110–115 % i maj–jul 2025, så batterimålingerne er indbyrdes lidt skæve. SOC-hældning viser ~96 % virkningsgrad og ~19–20 kWh pr. 100 %.
    - Til sammenligning lå husets forbrug i 2024 (E17, før anlægget) på samme niveau (±15 %) som SA's forbrug i 2025–26.
  - **Huller:** timer uden inverter-data er ikke med i besparelsen. Det er 108 timer i alt, bl.a. 6.–9. jan 2026 (firmwareopdatering), så jan 2026 mangler ~1,24 kr salg og tilsvarende besparelse.
- ✅ **Produktionsaftager-dropdown** — i Salg-panelet en `<select id="aftagerSelect">` over kendte elhandlere der køber overskudsstrøm; valg udfylder `t4` og viser note med abonnement, kilde, link og tjek-dato. "— Indtast selv —" lader brugeren skrive selv.
  - **Listen er en separat datafil: `data/produktionsaftagere.json`** (hentes med `fetch(..., {cache:'no-cache'})`). Felter pr. post: `navn`, `kategori` (`"alene"` = tegnes uanset elselskab, `"elkunde"` = kræver kundeforhold), `spread` (øre/kWh = t4; `null` = ukendt), `abonnement` (kr/md; 0 = gratis), `note`, `kilde`, `url`, `opdateret`.
  - **Dropdown opdelt i to `<optgroup>`:** "Produktionsaftale alene" og "Kræver/forudsætter elkunde hos selskabet".
  - **20 selskaber verificeret (2026-08):** Vindstød, Norlys, Modstrøm, Andel, SEF, NRGi, Green Power Energy, Jysk Energi, nef Strøm, Energy Nordic, Energi Fyn, Nordisk Energi — de fleste med både elkunde- og ren-produktions-variant. Nettopower udeladt (konkurs).
  - **Status-siden** (`status.html`) viser hele listen som en tabel opdelt i de to kategorier.
  - **Kun kilde-bakkede tal.** Se vedligeholdelses-procedure i afsnit 3.
- ✅ **Trin-omstrukturering (1, 1½, 2 → 1, 2, 3)** — det tidligere ulogiske "trin 1½" (adresse-quick-konfig som eget kort) er fjernet. Ny inddeling: **1 Importér data · 2 Sæt tariffer (køb + salg) · 3 Analysér.** Trin 2 er internt delt i **tre parallelle paneler** (`.config-part`): **(1) Netselskab & område** — fælles for køb og salg (netselskabet står for transporten og opkræver tariffer begge veje; udfyldes via adresse; prisområde flyttet herind da det følger postnummeret), **(2) Køb** — selvforbrugs-overhead, **(3) Salg** — eksport-fradrag (EDS + leverandørgebyr). Grænseværdier ligger som afsluttende analyse-indstillinger under de tre. Rene DOM-flytninger + én CSS-klasse, ingen JS-ændringer, alle element-ID'er bevaret.
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

**Når produktionsaftagerlisten skal opdateres (`data/produktionsaftagere.json`):**
- Listen er **100% manuel** — ingen automatik. Vilkår ændres hos elhandlerne uden varsel.
- **Tilføj kun selskaber med verificeret URL og kilde** — brug `"spread": null` hvis øre/kWh ikke er bekræftet (vises i dropdown men auto-udfylder ikke t4; brugeren ser en note om at verificere).
- Procedure pr. ny post:
  1. Find selskabets officielle prisside for produktionsaftale
  2. Notér `spread` (øre/kWh), abonnementspris og evt. betingelser (som elkunde/kun produktion)
  3. Udfyld `navn`, `spread`, `note` (vilkår + betingelser), `kilde` (domænenavn), `url` (direkte link til prissiden), `opdateret` (YYYY-MM)
  4. Ret global `opdateret`-dato øverst i filen
  5. Commit + push (ingen workflow — bare rediger filen direkte)
- **Bekræft altid mod en faktisk afregning** inden `spread` sættes til en konkret værdi.
- Selskaber der er gået konkurs eller ophørt: fjern fra listen.

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
- **Per-time analyse via lookup, ikke ved aggregeret gennemsnit** — distribution varierer fra 11 til 79 øre over døgnet (4-7×), så gennemsnit ville give forkerte resultater
- **Markup beholdes i sessionStorage** — det er per produkt og kunne ændre sig, men hentes friskt fra Strømligning ved hver page-load via `cachedJson()` med 24t TTL
- **Spot fra EDS, ikke fra Strømligning** — vi vil ikke blande spot fra flere kilder; én autoritativ kilde (Nord Pool via EDS)
- **Ingen elafgift hardcoded** — EDS er autoritativ (vi fandt fejl i vores oprindelige hardcoded historik for 2022/2023)
- **Selvforbrugsværdi og "tabt fortjeneste" fjernet (2026-08)** — eloverblik viser kun netto-import (D07) og netto-eksport (D06), ikke hvad der faktisk blev forbrugt bag måleren. En bruger med batteri + elbil har allerede optimeret selvforbrug; det eksporterede er ægte overskud. "Tabt fortjeneste" (= hvad man kunne have tjent ved selvforbrug) var et skyggetal baseret på en forkert antagelse og er fjernet helt. Actionabelt fokus: *negativ pris* (man betaler for at eksportere) er det eneste reelt handlebare.
- **Selvforbrugsværdi genindført, nu på målte data (2026-11)**: punktet ovenfor fjernede den, fordi den byggede på en antagelse om hvad der skete bag måleren. Med inverter-data *måles* flows bag måleren, så besparelsen (inkl. batteri) beregnes nu på reelle tal. Uden inverter-data vises den stadig ikke.
- **Inverter-import = åbent format + separate eksportører (2026-11)**: appen importerer kun energiflow-CSV. Hentning fra Growatt/FoxESS/HA/SolarAssistant m.fl. ligger i separate projekter (linkes fra `data/energiflow-kilder.json`). Det holder leverandør-API'er, logins og CORS-problemer ude af appen og bevarer "alt lokalt i browseren". Home Assistant er valgt som første eksportør, fordi den dækker næsten alle mærker.
- **eloverblik er autoritativ for net-tal (2026-11)**: besparelsen bruger elmålerens import/eksport (det der afregnes) og inverteren til PV/forbrug/batteri. Forskellen vises som "afvigelse" og i afstemningskolonnen.
- **Køb kun elmåleren så = forbrug (2026-11-19)**: elmåler-import over inverterens net-import lægges til forbruget (`unseenLoad`) i stedet for at ende som afvigelse. Begrundelse: strømmen er købt og brugt, uanset om inverteren så den, og den koster det samme med og uden anlæg. Den modsatte retning (måler < inverter) forbliver afvigelse, fordi den ikke har en lige så entydig forklaring.
- **Batteriets merværdi beholder marginal-fordelingen (2026-11-19)**: sol→batteri tælles til salgspris under solstrømmens salgsværdi og trækkes fra i batteriet. Batteriet får altså kun forskellen (købspris ved brug − salgspris). Alternativet, hvor batteriet får hele værdien af lagret sol, er lettere at forstå, men overvurderer batteriet. Det er valgt at forklare bedre i stedet for at ændre matematikken.
- **Positiv-framing af analyse (2026-08)** — bruger lander nu på "Oversigt"-fanen med søjlediagram og fordeling af alle eksportimer. "Problematiske timer" omdøbt til "Timer under grænse". 4 kategorier (god/lav/dårlig/negativ) i stedet for binær god/dårlig.

## 7. Kontakt-info

- Repo: https://github.com/marurup/solarProductionAnalyzer
- Issues: brug GitHub issues
- Live site: https://marurup.github.io/solarProductionAnalyzer/
- Status: https://marurup.github.io/solarProductionAnalyzer/status.html
