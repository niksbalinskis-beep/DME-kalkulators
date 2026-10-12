/* ═══════════════════════════════════════════════════════════════
   eee-dme.js — Atjaunoto daudzdzīvokļu ēku dati (standalone versija)

   Ports no assets/js/atjaunotas.js, bet BEZ backend: viss nāk no
   data/dme.json, un visa filtrēšana/agregācija notiek pārlūkā.

   Katra agregācija tīši atkārto attiecīgo SQL no
   api/atjaunotas-analytics.php, lai skaitļi sakristu ar ekufonds.lv lapu:
   - AVG izlaiž NULL vērtības (nevis skaita tās par nulli)
   - SUM NULL vērtības pieskaita kā 0
   - €/m² pa gadiem = VIDĒJAIS no rindu attiecībām (nevis summu dalījums)
   - efektīvā platība = VZD ēkas platība, ja ir, citādi avota platība

   Grafiki: Chart.js 4 (CDN). Karte: Leaflet 1.9 (CDN).
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var DATU_FAILS = 'data/dme.json';
  var EKA_LAPA = 'https://ekufonds.lv/eka.html?cadastre_nr=';
  var REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Kopējā Latvijas daudzdzīvokļu ēku platība m² — bāze KPI "% no kopējās ēku platības".
     ⚠️ TODO: Niks iedos skaitli. Kamēr null, procentu apakšrinda netiek rādīta. */
  var KOPEJA_EKU_PLATIBA_M2 = null;

  /* Aizdevuma pieņēmumi — identiski api/atjaunotas-analytics.php konstantēm */
  var LOAN_ANNUAL_RATE = 0.039;
  var LOAN_YEARS = 20;

  var COLORS = {
    darkGreen: '#20542b',
    green: '#65bf3b',
    lightGreen: '#81b544',
    orange: '#f15025',
    subtle: '#e0f2d8',
  };

  var state = {
    visiProjekti: [],
    atlasitie: [],
    search: '', region: '', program: '', series: '',
    listPage: 1,
    listPerPage: 50,
    listSort: 'cost',
    listDir: 'desc',
  };

  var charts = {};
  var leafletMap = null;
  var mapMarkers = [];

  function $(id) { return document.getElementById(id); }

  /** Uzstāda tekstu, ja elements eksistē — lai KPI rindas var izņemt no HTML bez JS kļūdas. */
  function setText(id, teksts) {
    var el = $(id);
    if (el) el.textContent = teksts;
  }

  /* ─── Formatētāji (pārnesti no atjaunotas.js) ─── */

  function fmtInt(n) {
    if (n === null || n === undefined || n === '' || isNaN(n)) return '—';
    return Number(n).toLocaleString('lv-LV', { maximumFractionDigits: 0 });
  }

  function fmtEurShort(n) {
    if (n === null || n === undefined || n === '' || isNaN(n)) return '€0';
    n = Number(n);
    if (Math.abs(n) >= 1e6) return (n / 1e6).toLocaleString('lv-LV', { maximumFractionDigits: 1 }) + ' milj. €';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toLocaleString('lv-LV', { maximumFractionDigits: 0 }) + ' tūkst. €';
    return fmtInt(n) + ' €';
  }

  function fmtEur(n) {
    if (n === null || n === undefined || n === '' || isNaN(n)) return '—';
    return fmtInt(n) + ' €';
  }

  function fmtPercent(n) {
    if (n === null || n === undefined || n === '' || isNaN(n)) return '—';
    return Number(n).toLocaleString('lv-LV', { maximumFractionDigits: 1 }) + '%';
  }

  function fmtKwh(n) {
    if (n === null || n === undefined || n === '' || isNaN(n)) return 'nav datu';
    return Number(n).toLocaleString('lv-LV', { maximumFractionDigits: 1 }) + ' kWh/m²';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      clearTimeout(t);
      var args = arguments, ctx = this;
      t = setTimeout(function () { fn.apply(ctx, args); }, ms);
    };
  }

  function setLoading(on) {
    var el = $('eeeLoading');
    if (el) el.hidden = !on;
  }

  /* ─── Palīgfunkcijas agregācijai ─── */

  /** SQL AVG ekvivalents: izlaiž NULL, atgriež null tukšai kopai. */
  function avg(rows, lauks, decimals) {
    var summa = 0, skaits = 0;
    for (var i = 0; i < rows.length; i++) {
      var v = rows[i][lauks];
      if (v !== null && v !== undefined) { summa += v; skaits++; }
    }
    if (!skaits) return null;
    return round(summa / skaits, decimals === undefined ? 1 : decimals);
  }

  /** SQL SUM ekvivalents: NULL skaitās kā 0. */
  function sum(rows, lauks) {
    var summa = 0;
    for (var i = 0; i < rows.length; i++) {
      var v = rows[i][lauks];
      if (v !== null && v !== undefined) summa += v;
    }
    return summa;
  }

  function round(n, decimals) {
    var k = Math.pow(10, decimals);
    return Math.round(n * k) / k;
  }

  /** Efektīvā platība — api/atjaunotas-analytics.php raEffectiveArea() ekvivalents. */
  function efektivaPlatiba(p) {
    if (p.vzd_area !== null && p.vzd_area > 0) return p.vzd_area;
    if (p.area_m2 !== null && p.area_m2 > 0) return p.area_m2;
    return null;
  }

  /** Ikmēneša anuitātes maksājums — raLoanMonthlyPayment() ekvivalents. */
  function kreditaMaksajums(pamatsumma) {
    if (pamatsumma <= 0) return 0;
    var r = LOAN_ANNUAL_RATE / 12;
    var n = LOAN_YEARS * 12;
    return round(pamatsumma * r / (1 - Math.pow(1 + r, -n)), 2);
  }

  /** Diakritikas-neatkarīga, reģistrnejutīga salīdzināšana — tāpat kā MySQL utf8mb4_unicode_ci. */
  function normalize(s) {
    return String(s == null ? '' : s)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  /* ─── Datu ielāde ─── */

  function ieladetDatus() {
    setLoading(true);
    return fetch(DATU_FAILS, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (dok) {
      state.visiProjekti = dok.rindas.map(function (rinda) {
        var p = {};
        for (var i = 0; i < dok.lauki.length; i++) p[dok.lauki[i]] = rinda[i];
        /* Iepriekš sagatavotie meklēšanas lauki — lai filtrēšana nav jāatkārto katrā taustiņspiedienā */
        p._search = normalize(p.address_raw) + ' ' + normalize(p.town_raw);
        p._series = normalize(p.series);
        return p;
      });
      raditGenerets(dok.generets);
      return dok;
    });
  }

  function raditGenerets(iso) {
    var el = $('eeeGenerets');
    if (!el || !iso) return;
    var d = new Date(iso);
    if (isNaN(d)) return;
    el.textContent = d.toLocaleDateString('lv-LV', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  /* ─── Filtri ─── */

  function filtriAktivi() {
    return !!(state.search || state.region || state.program || state.series);
  }

  function filtret() {
    var s = normalize(state.search);
    var ser = normalize(state.series);

    return state.visiProjekti.filter(function (p) {
      if (state.region && p.region !== state.region) return false;
      if (state.program && p.program !== state.program) return false;
      if (ser && p._series.indexOf(ser) === -1) return false;
      if (s && p._search.indexOf(s) === -1) return false;
      return true;
    });
  }

  function aizpilditFiltrus() {
    var regioni = {}, programmas = {};
    state.visiProjekti.forEach(function (p) {
      if (p.region) regioni[p.region] = (regioni[p.region] || 0) + 1;
      if (p.program) programmas[p.program] = (programmas[p.program] || 0) + 1;
    });

    function pecSkaita(obj) {
      return Object.keys(obj).sort(function (a, b) { return obj[b] - obj[a]; });
    }

    var regionSelect = $('regionSelect');
    pecSkaita(regioni).forEach(function (r) {
      var opt = document.createElement('option');
      opt.value = r;
      opt.textContent = r.replace(' plānošanas reģions', '') + ' (' + fmtInt(regioni[r]) + ')';
      regionSelect.appendChild(opt);
    });

    var programSelect = $('programSelect');
    pecSkaita(programmas).forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p + ' (' + fmtInt(programmas[p]) + ')';
      programSelect.appendChild(opt);
    });

    setText('eeeTotalBadge', fmtInt(state.visiProjekti.length) + ' ēkas');
  }

  /* ─── KPI kopsavilkums (raActionSummary ekvivalents) ─── */

  function renderSummary(rows) {
    var totalInvestment = round(sum(rows, 'cost_total'), 0);
    var totalGrant = round(sum(rows, 'grant_amount'), 0);
    var totalArea = round(sum(rows, 'area_m2'), 0);
    var totalApartments = sum(rows, 'apartments');

    var grantShare = totalInvestment > 0 ? round(totalGrant / totalInvestment * 100, 1) : 0;
    var platibasDala = KOPEJA_EKU_PLATIBA_M2 > 0
      ? round(totalArea / KOPEJA_EKU_PLATIBA_M2 * 100, 1) : null;

    /* Bez filtriem runājam par visu kopu ("Atjaunotas 1 402 daudzdzīvokļu ēkas"),
       ar filtriem — par atlasi, papildus parādot, cik no kopskaita. */
    if (filtriAktivi()) {
      setText('kpiCountLabel', 'Atlasītās ēkas');
      setText('kpiCountSub', 'no ' + fmtInt(state.visiProjekti.length) + ' ēkām kopā');
    } else {
      setText('kpiCountLabel', 'Atjaunotas daudzdzīvokļu ēkas');
      setText('kpiCountSub', '');
    }

    setText('kpiCount', fmtInt(rows.length));
    setText('kpiAvgSavings', fmtPercent(avg(rows, 'savings_percent', 1)));
    setText('kpiAvgAfter', fmtKwh(avg(rows, 'kwh_after', 1)));
    setText('kpiAvgAfterSub', 'pirms: ' + fmtKwh(avg(rows, 'kwh_before', 1)));
    setText('kpiInvestment', fmtEurShort(totalInvestment));
    setText('kpiApartmentsSub', fmtInt(totalApartments) + ' dzīvokļi kopā');
    setText('kpiGrant', fmtEurShort(totalGrant));
    setText('kpiGrantShareSub', fmtPercent(grantShare) + ' no kopējām atjaunošanas izmaksām');
    setText('kpiArea', fmtInt(totalArea) + ' m²');
    setText('kpiAreaShareSub', platibasDala !== null
      ? fmtPercent(platibasDala) + ' no kopējās ēku platības' : '');
  }

  /* ─── Grafiki (raActionCharts ekvivalents) ─── */

  function chartDefaults() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: REDUCED_MOTION ? false : { duration: 300 },
      plugins: {
        legend: {
          labels: {
            font: { family: "'Montserrat', sans-serif", size: 12 },
            color: COLORS.darkGreen,
            usePointStyle: true,
            pointStyleWidth: 8,
          },
        },
        tooltip: {
          backgroundColor: COLORS.darkGreen,
          titleFont: { family: "'Montserrat', sans-serif" },
          bodyFont: { family: "'Montserrat', sans-serif" },
          padding: 10,
          cornerRadius: 8,
        },
      },
    };
  }

  function axisOpts(unit) {
    return {
      x: {
        grid: { display: false },
        ticks: { font: { family: "'Montserrat', sans-serif", size: 11 }, color: 'rgba(0,0,0,0.62)', maxRotation: 45 },
      },
      y: {
        beginAtZero: true,
        grid: { color: 'rgba(32,84,43,0.08)' },
        ticks: {
          font: { family: "'Montserrat', sans-serif", size: 11 },
          color: 'rgba(0,0,0,0.62)',
          callback: function (v) { return fmtInt(v) + (unit ? ' ' + unit : ''); },
        },
      },
    };
  }

  /** €/m² pa granta gadiem: rindas attiecība → vidējais gadā (nevis summu dalījums). */
  function izmaksasPaGadiem(rows) {
    var pecGada = {};
    rows.forEach(function (p) {
      if (p.grant_year === null || p.cost_total === null) return;
      var platiba = efektivaPlatiba(p);
      if (!platiba) return;
      if (!pecGada[p.grant_year]) pecGada[p.grant_year] = { summa: 0, skaits: 0 };
      pecGada[p.grant_year].summa += p.cost_total / platiba;
      pecGada[p.grant_year].skaits++;
    });

    return Object.keys(pecGada).map(Number).sort(function (a, b) { return a - b; })
      .map(function (gads) {
        return { year: gads, avg_cost_per_m2: round(pecGada[gads].summa / pecGada[gads].skaits, 2) };
      });
  }

  /** Patēriņš pa ēkas ekspluatācijas desmitgadēm. */
  function paterinsPaDesmitgadem(rows) {
    var grupas = {};
    rows.forEach(function (p) {
      if (p.commission_year === null) return;
      var desmitgade = Math.floor(p.commission_year / 10) * 10;
      if (!grupas[desmitgade]) grupas[desmitgade] = [];
      grupas[desmitgade].push(p);
    });

    return Object.keys(grupas).map(Number).sort(function (a, b) { return a - b; })
      .map(function (d) {
        return {
          decade: d,
          avg_before: avg(grupas[d], 'kwh_before', 1),
          avg_after: avg(grupas[d], 'kwh_after', 1),
        };
      });
  }

  function renderCharts(rows) {
    var defaults = chartDefaults();

    var paGadiem = izmaksasPaGadiem(rows);
    if (charts.costPerM2) charts.costPerM2.destroy();
    charts.costPerM2 = new Chart($('costPerM2Chart'), {
      type: 'bar',
      data: {
        labels: paGadiem.map(function (d) { return String(d.year); }),
        datasets: [{
          label: 'Vidējās izmaksas €/m²',
          data: paGadiem.map(function (d) { return d.avg_cost_per_m2; }),
          backgroundColor: COLORS.darkGreen,
          borderRadius: 8,
        }],
      },
      options: Object.assign({}, defaults, { scales: axisOpts('€/m²') }),
    });

    var paDesmitgadem = paterinsPaDesmitgadem(rows);
    if (charts.consumption) charts.consumption.destroy();
    charts.consumption = new Chart($('consumptionChart'), {
      type: 'line',
      data: {
        labels: paDesmitgadem.map(function (d) { return d.decade + 's'; }),
        datasets: [
          {
            label: 'Pirms atjaunošanas',
            data: paDesmitgadem.map(function (d) { return d.avg_before; }),
            borderColor: COLORS.orange,
            backgroundColor: 'rgba(241,80,37,0.15)',
            tension: 0.3, fill: true,
          },
          {
            label: 'Pēc atjaunošanas',
            data: paDesmitgadem.map(function (d) { return d.avg_after; }),
            borderColor: COLORS.green,
            backgroundColor: 'rgba(101,191,59,0.18)',
            tension: 0.3, fill: true,
          },
        ],
      },
      options: Object.assign({}, defaults, { scales: axisOpts('kWh/m²') }),
    });

    var totalInvestment = sum(rows, 'cost_total');
    var totalGrant = sum(rows, 'grant_amount');
    var ownShare = Math.max(totalInvestment - totalGrant, 0);

    if (charts.financing) charts.financing.destroy();
    charts.financing = new Chart($('financingChart'), {
      type: 'doughnut',
      data: {
        labels: ['Sniegtais atbalsts', 'Privātās investīcijas'],
        datasets: [{ data: [totalGrant, ownShare], backgroundColor: [COLORS.green, COLORS.darkGreen], borderWidth: 0 }],
      },
      options: Object.assign({}, defaults, {
        plugins: Object.assign({}, defaults.plugins, {
          legend: {
            position: 'bottom',
            labels: { color: COLORS.darkGreen, font: { family: "'Montserrat', sans-serif", size: 12 } },
          },
        }),
      }),
    });
  }

  /* ─── Karte ─── */

  function initMap() {
    if (leafletMap || typeof L === 'undefined') return;
    leafletMap = L.map('eeeMap', { center: [56.9, 24.6], zoom: 7, scrollWheelZoom: false });
    /* OpenStreetMap flīzes — bez API atslēgas. (CartoDB basemaps, ko lieto ekufonds.lv
       DME.html, kopš kāda laika atgriež attēlus ar ūdenszīmi "API KEY REQUIRED".) */
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> autori',
    }).addTo(leafletMap);
  }

  function renderMap(rows) {
    if (!leafletMap) return;

    mapMarkers.forEach(function (m) { leafletMap.removeLayer(m); });
    mapMarkers = [];

    var punkti = rows.filter(function (p) { return p.lat !== null && p.lng !== null; });

    punkti.forEach(function (p) {
      var marker = L.circleMarker([p.lat, p.lng], {
        radius: 6,
        color: '#ffffff',
        weight: 1.5,
        fillColor: COLORS.green,
        fillOpacity: 0.9,
      });
      var addr = escapeHtml(p.address_raw + (p.town_raw ? ', ' + p.town_raw : ''));
      var savings = p.savings_percent !== null ? fmtPercent(p.savings_percent) : 'nav datu';
      marker.bindPopup(
        '<div class="eee-map-popup"><strong>' + addr + '</strong>' +
        'Ietaupījums: ' + savings + '<br>' +
        'Izmaksas: ' + fmtEur(p.cost_total) + '</div>'
      );
      marker.addTo(leafletMap);
      mapMarkers.push(marker);
    });

    var noteEl = $('mapMatchNote');
    if (noteEl) {
      noteEl.textContent = fmtInt(punkti.length) + ' no ' + fmtInt(rows.length) +
        ' ēkām atrastas kadastra datubāzē un rādītas kartē';
    }

    /* Ja lapa ielādējas paslēptā konteinerī (piem. WordPress cilnē vai akordeonā),
       Leaflet nezina īsto kartes izmēru un fitBounds aizlec uz maksimālo tuvinājumu.
       invalidateSize() pārmēra konteineru pirms robežu piemērošanas. */
    leafletMap.invalidateSize(false);

    if (punkti.length && leafletMap.getSize().x > 0) {
      var bounds = L.latLngBounds(punkti.map(function (p) { return [p.lat, p.lng]; }));
      leafletMap.fitBounds(bounds, { padding: [24, 24], maxZoom: 12 });
    }
  }

  /* ─── Projektu tabula (raActionList ekvivalents) ─── */

  var KARTOJAMIE = {
    address: 'address_raw',
    region: 'region',
    year: 'commission_year',
    savings: 'savings_percent',
    cost: 'cost_total',
    grant: 'grant_amount',
    area: 'area_m2',
  };

  function kartot(rows) {
    var lauks = KARTOJAMIE[state.listSort] || 'cost_total';
    var virziens = state.listDir === 'asc' ? 1 : -1;

    return rows.slice().sort(function (a, b) {
      var x = a[lauks], y = b[lauks];
      /* MySQL kārtošanā NULL vienmēr ir pirms vērtībām augošā secībā */
      if (x === null && y === null) return 0;
      if (x === null) return -1 * virziens;
      if (y === null) return 1 * virziens;
      if (typeof x === 'string') return x.localeCompare(y, 'lv') * virziens;
      return (x - y) * virziens;
    });
  }

  /** Pārrēķinātie finanšu lauki vienai rindai — tie paši, ko PHP pievieno raActionList() ciklā. */
  function finanses(p) {
    var platiba = efektivaPlatiba(p);
    var costTotal = p.cost_total;
    var ownerCost = costTotal !== null ? Math.max(costTotal - (p.grant_amount || 0), 0) : null;
    var monthly = ownerCost !== null ? kreditaMaksajums(ownerCost) : null;

    return {
      cost_per_m2: (costTotal !== null && platiba) ? round(costTotal / platiba, 2) : null,
      monthly_payment: monthly,
      avg_apartment_payment: (monthly !== null && p.apartments > 0)
        ? round(monthly / p.apartments, 2) : null,
    };
  }

  function formatPaterins(p) {
    if (p.kwh_before === null && p.kwh_after === null) return 'nav datu';
    var pirms = p.kwh_before !== null ? fmtInt(p.kwh_before) : 'nav';
    var pec = p.kwh_after !== null ? fmtInt(p.kwh_after) : 'nav';
    return pirms + ' → ' + pec;
  }

  function renderList(rows) {
    var tbody = $('projectsTableBody');
    var kartotas = kartot(rows);
    var sakums = (state.listPage - 1) * state.listPerPage;
    var lapa = kartotas.slice(sakums, sakums + state.listPerPage);

    tbody.innerHTML = '';

    if (!lapa.length) {
      tbody.innerHTML = '<tr class="eee-empty-row"><td colspan="14">Nav projektu izvēlētajiem filtriem</td></tr>';
      return;
    }

    var html = lapa.map(function (p) {
      var f = finanses(p);
      var addr = escapeHtml(p.address_raw + (p.town_raw ? ', ' + p.town_raw : ''));
      var region = escapeHtml((p.region || '—').replace(' plānošanas reģions', ''));
      var addrCell = p.building_cadastre_nr
        ? '<a href="' + EKA_LAPA + encodeURIComponent(p.building_cadastre_nr) + '" target="_blank" rel="noopener" title="Atvērt ēkas datus ekufonds.lv">' + addr + '</a>'
        : '<span title="Ēka nav atrasta kadastra datubāzē">' + addr + '</span>';

      return '<tr>' +
        '<td class="eee-addr">' + addrCell + '</td>' +
        '<td>' + region + '</td>' +
        '<td>' + escapeHtml(p.program || '—') + '</td>' +
        '<td>' + escapeHtml(p.series || '—') + '</td>' +
        '<td class="eee-num">' + (p.commission_year || 'nav datu') + '</td>' +
        '<td class="eee-num">' + (p.savings_percent !== null ? fmtPercent(p.savings_percent) : 'nav datu') + '</td>' +
        '<td class="eee-num">' + formatPaterins(p) + '</td>' +
        '<td class="eee-num">' + (p.apartments ? fmtInt(p.apartments) : 'nav datu') + '</td>' +
        '<td class="eee-num">' + (p.area_m2 ? fmtInt(Math.round(p.area_m2)) + ' m²' : 'nav datu') + '</td>' +
        '<td class="eee-num">' + (p.cost_total ? fmtEur(p.cost_total) : 'nav datu') + '</td>' +
        '<td class="eee-num">' + (p.grant_amount ? fmtEur(p.grant_amount) : 'nav datu') + '</td>' +
        '<td class="eee-num">' + (f.cost_per_m2 ? fmtEur(f.cost_per_m2) + '/m²' : 'nav datu') + '</td>' +
        '<td class="eee-num">' + (f.monthly_payment ? fmtEur(f.monthly_payment) : 'nav datu') + '</td>' +
        '<td class="eee-num">' + (f.avg_apartment_payment ? fmtEur(f.avg_apartment_payment) : 'nav datu') + '</td>' +
      '</tr>';
    }).join('');

    tbody.innerHTML = html;
  }

  function renderPagination(kopa) {
    var el = $('projectsPagination');
    el.innerHTML = '';
    var lapuSkaits = Math.max(1, Math.ceil(kopa / state.listPerPage));

    var prev = document.createElement('button');
    prev.className = 'eee-page-btn';
    prev.type = 'button';
    prev.textContent = '← Iepriekšējā';
    prev.disabled = state.listPage <= 1;
    prev.addEventListener('click', function () { state.listPage--; parraditSarakstu(); });

    var info = document.createElement('span');
    info.textContent = state.listPage + '. lpp. no ' + fmtInt(lapuSkaits) + ' (' + fmtInt(kopa) + ' projekti)';

    var next = document.createElement('button');
    next.className = 'eee-page-btn';
    next.type = 'button';
    next.textContent = 'Nākamā →';
    next.disabled = state.listPage >= lapuSkaits;
    next.addEventListener('click', function () { state.listPage++; parraditSarakstu(); });

    el.appendChild(prev);
    el.appendChild(info);
    el.appendChild(next);
  }

  function atjaunotKartosanasGalvenes() {
    document.querySelectorAll('#projectsTable th[data-sort]').forEach(function (th) {
      var aktivs = th.getAttribute('data-sort') === state.listSort;
      th.classList.toggle('sorted', aktivs);
      th.classList.toggle('asc', aktivs && state.listDir === 'asc');
    });
  }

  /* ─── Pārzīmēšana ─── */

  function parraditSarakstu() {
    renderList(state.atlasitie);
    renderPagination(state.atlasitie.length);
    atjaunotKartosanasGalvenes();
  }

  function parradit() {
    state.atlasitie = filtret();
    renderSummary(state.atlasitie);
    renderCharts(state.atlasitie);
    renderMap(state.atlasitie);
    parraditSarakstu();
  }

  var parraditAtlikti = debounce(function () { parradit(); }, 250);

  /* ─── Notikumu sasaiste ─── */

  function sasaistitFiltrus() {
    [['searchInput', 'search'], ['regionSelect', 'region'],
     ['programSelect', 'program'], ['seriesInput', 'series']].forEach(function (sasaiste) {
      var el = $(sasaiste[0]);
      if (!el) return;
      el.addEventListener('input', function () {
        state[sasaiste[1]] = el.value;
        state.listPage = 1;
        parraditAtlikti();
      });
    });

    $('resetFiltersBtn').addEventListener('click', function () {
      state.search = ''; state.region = ''; state.program = ''; state.series = '';
      state.listPage = 1;
      $('searchInput').value = '';
      $('seriesInput').value = '';
      $('regionSelect').value = '';
      $('programSelect').value = '';
      parradit();
    });
  }

  function sasaistitKartosanu() {
    document.querySelectorAll('#projectsTable th[data-sort]').forEach(function (th) {
      th.addEventListener('click', function () {
        var kolonna = th.getAttribute('data-sort');
        if (state.listSort === kolonna) {
          state.listDir = state.listDir === 'asc' ? 'desc' : 'asc';
        } else {
          state.listSort = kolonna;
          state.listDir = 'desc';
        }
        state.listPage = 1;
        parraditSarakstu();
      });
    });
  }

  function raditKludu(kluda) {
    var el = $('eeeError');
    if (el) {
      el.hidden = false;
      el.textContent = 'Neizdevās ielādēt datus (' + kluda.message + '). ' +
        'Pārbaudi, vai fails data/dme.json ir augšupielādēts serverī.';
    }
    console.error('DME datu ielādes kļūda:', kluda);
  }

  document.addEventListener('DOMContentLoaded', function () {
    sasaistitFiltrus();
    sasaistitKartosanu();
    initMap();

    ieladetDatus().then(function () {
      aizpilditFiltrus();
      parradit();
    }).catch(raditKludu).then(function () {
      setLoading(false);
    });
  });
})();
