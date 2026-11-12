# energiflow-CSV v1

Et simpelt, åbent filformat til **energiflows bag elmåleren**: solcelleproduktion, husets forbrug, batteri og net. Det er formatet [Solcelle-analysen](https://marurup.github.io/solarProductionAnalyzer/) importerer for at beregne den reelle besparelse ved solceller og batteri.

Appen henter **ikke** selv data fra invertere. Det gør separate *eksportører*: små projekter der henter data fra én kilde (Home Assistant, en inverter-cloud, SolarAssistant …) og skriver denne fil. Kendte eksportører er listet i [`data/energiflow-kilder.json`](../data/energiflow-kilder.json) og vises i appen. Vil du skrive en eksportør til dit system, er denne side hele kontrakten.

## Eksempel

```csv
# energiflow v1; source=ha-energiflow-export 0.1; site=Hjemme
timestamp,pv_kwh,load_kwh,battery_charge_kwh,battery_discharge_kwh,grid_import_kwh,grid_export_kwh,battery_soc_pct
2026-11-03T02:00:00+01:00,0,0.41,2.10,0,2.51,0,38
2026-11-03T03:00:00+01:00,0,0.39,2.05,0,2.44,0,61
2026-11-03T12:00:00+01:00,1.20,0.95,0.20,0,0,0.05,92
2026-11-03T17:00:00+01:00,0,1.85,0,1.80,0.05,0,40
```

## Regler

### Fil
- UTF-8, første linje med kolonnenavne, komma som separator og punktum som decimaltegn. Semikolon som separator med decimalkomma accepteres også (dansk Excel-eksport), men skriv helst komma/punktum.
- Linjer der starter med `#` er kommentarer. Den **første** kommentarlinje bør være `# energiflow v1`, eventuelt efterfulgt af `; nøgle=værdi`-par (`source`, `site`, …). Appen viser `source` i upload-boksen.
- Rækkerne må komme i vilkårlig rækkefølge. Dubletter (samme tidsstempel) bliver lagt sammen, så undgå dem.

### `timestamp`
- **Intervallets start** i ISO 8601 **med tidszone-offset**, fx `2026-10-25T02:00:00+02:00` eller `2026-10-25T00:00:00Z`.
- Offset gør sommertidsskiftet entydigt. Et tidsstempel uden offset tolkes som dansk lokaltid. Det virker, men timen 02:00–03:00 den sidste søndag i oktober kan så ikke skelnes.
- Opløsning: **5 minutter til 1 time**, og den må gerne variere i samme fil. Appen lægger alle intervaller sammen til hele timer i dansk tid, så de passer med spotpriser og eloverblik.

### Energikolonner
Alle værdier er **energi i kWh for intervallet**, altid ≥ 0. De er ikke kumulative tællere og ikke effekt i W. En eksportør der læser tællere, skal selv tage differencen mellem intervaller.

| Kolonne | Påkrævet | Betydning |
|---|---|---|
| `pv_kwh` | ja | Solcelleproduktion (DC→AC, det inverteren leverer) |
| `load_kwh` | ja | Husets samlede forbrug |
| `battery_charge_kwh` | nej | Energi ind i batteriet |
| `battery_discharge_kwh` | nej | Energi ud af batteriet |
| `grid_import_kwh` | nej | Købt fra nettet (inverterens egen måling) |
| `grid_export_kwh` | nej | Solgt til nettet (inverterens egen måling) |
| `battery_charge_from_grid_kwh` | nej | Den del af `battery_charge_kwh` der kom fra nettet, hvis kilden kender den |
| `battery_soc_pct` | nej | Batteriets ladetilstand ved intervallets **slutning**, 0–100 (kun til visning) |

- **Tom celle = ukendt**, ikke 0. Skriv `0` når der reelt ikke var noget flow.
- Negative værdier betragtes som målefejl (fx en tæller der er nulstillet midt i et interval). Appen ignorerer dem og skriver en advarsel.
- Ukendte ekstra kolonner ignoreres, så formatet kan udvides uden at gamle filer går i stykker.

### Hvad appen bruger kolonnerne til
- **Net-tal:** elmålerens D06/D07 fra eloverblik er autoritative, fordi det er dem der afregnes efter. Inverterens `grid_*` bruges hvor der ikke er eloverblik-data, og til en afstemning mellem de to.
- **Fordeling pr. time:** solcellestrøm går først til huset, derefter til batteriet og til sidst til nettet. Batteriet dækker huset før nettet gør. Opladning ud over solcelleoverskuddet regnes som opladning fra nettet, medmindre `battery_charge_from_grid_kwh` angiver andet.
- Energibalancen `pv + discharge + import − load − charge − export` bør være tæt på 0 (inverter- og batteritab). Appen viser den samlede afvigelse som en datakvalitetsindikator.

## Versionering
Formatet hedder `energiflow v1`. Nye **valgfrie** kolonner kan komme til uden versionsskift. Ændrer en eksisterende kolonne betydning, eller bliver en ny kolonne påkrævet, bliver det `v2`.
