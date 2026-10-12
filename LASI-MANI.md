# energoefektivakaeka/ — DME lapas standalone versija

Patstāvīga (statiska) `DME.html` alternatīva energoefektivakaeka.lv dizainā.
**Nav vajadzīgs ne PHP, ne datubāze** — visi dati nāk no `data/dme.json`,
filtrēšana un agregācija notiek pārlūkā.

## Mapes saturs

```
index.html                 lapa
assets/css/eee-dme.css     dizains (energoefektivakaeka.lv tokeni)
assets/js/eee-dme.js       dati + filtri + KPI + grafiki + karte + tabula
assets/img/                logo un ilustrācijas (izvilktas no energoefektivakaeka.lv)
data/dme.json              ko lasa lapa (1402 projekti)
data/DME_dati.xlsx         cilvēklasāms eksports (lejupielādes poga lapā)
```

## Datu atjaunošana

```bash
python3 tools/export_dme.py
```

Skripts pieslēdzas VZD MySQL (`.env`), nolasa `dme_projects` + `buildings.building_area`
un pārraksta **abus** failus `data/` mapē. Pēc tam abi faili jāaugšupielādē serverī.

⚠️ Excel fails ir eksporta **rezultāts**, nevis avots — ar roku labots `DME_dati.xlsx`
lapā neparādīsies. Lapa lasa tikai `dme.json`.

## Publicēšana

Mape ir pilnībā patstāvīga — nav nevienas atsauces uz ekufonds.lv failiem vai API.
Vienīgās ārējās atsauces: CDN bibliotēkas (Bootstrap, Chart.js, Leaflet, Google Fonts),
OpenStreetMap kartes flīzes un saites uz energoefektivakaeka.lv / ekufonds.lv.

1. **Testēšanai:** visa mape ar FTP uz ekufonds.lv → `https://ekufonds.lv/energoefektivakaeka/`
2. **Vēlāk:** tā pati mape ar FTP uz energoefektivakaeka.lv (WordPress instalācijas saknē,
   blakus `wp-content/`). WordPress statiskas apakšmapes neaiztiek.

Pēc katras datu atjaunošanas pietiek augšupielādēt tikai `data/` mapi.

## Piezīmes

- **Karte:** lieto OpenStreetMap flīzes. `DME.html` uz ekufonds.lv joprojām lieto
  CartoDB flīzes, kas kopš kāda laika atgriež attēlus ar ūdenszīmi "API KEY REQUIRED" —
  to vajadzētu izlabot arī tur.
- **Skaitļu paritāte:** visas agregācijas pārbaudītas pret `api/atjaunotas-analytics.php`
  (KPI bez filtriem, pa reģioniem, pa programmām, abi grafiki, tabulas finanšu kolonnas) —
  sakrīt līdz pēdējam ciparam.
- **Kas atšķiras no `DME.html`:** nav izvēršamās dzīvokļu detalizācijas rindas (tai vajadzīga
  VZD `premise_groups` tabula — 46 227 rindas). Kolonna “Vidēji/dzīvoklim” strādā.
- **Tumšās tēmas nav** — energoefektivakaeka.lv strādā tikai gaišajā.
