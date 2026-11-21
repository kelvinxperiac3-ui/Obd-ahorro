import { BleTransport } from './ble.js';
import { SimTransport } from './sim.js';
import { Elm327 } from './elm327.js';
import { PIDS, decode, readSupported } from './obd.js';
import { DEFAULT_ENGINE, fuelLph, kmPerL } from './fuel.js';
import { GearLearner, MD201_RATIOS } from './gears.js';
import { RpmStats, BUCKET, MIN_BUCKET_SECONDS, DEFAULT_TOP_ZONE } from './stats.js';
import { Analyzer } from './analyzer.js';
import { parseCarScanner } from './import.js';
import { advise, gearName } from './advise.js';

const $ = (id) => document.getElementById(id);

// ---------- persistencia (localStorage protegido) ----------
const store = {
  get(k, def) { try { const v = localStorage.getItem('obd.' + k); return v ? JSON.parse(v) : def; } catch { return def; } },
  set(k, v) { try { localStorage.setItem('obd.' + k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};

const cfg = Object.assign({
  displacement: DEFAULT_ENGINE.displacement,
  ve: DEFAULT_ENGINE.ve,
  nGears: 5,
  voice: true,
  dfco: true,
  corr: 1,
  gearRatios: MD201_RATIOS,
}, store.get('cfg', {}));

let gears = new GearLearner(cfg.nGears, store.get('gears', null), cfg.gearRatios);
let stats = new RpmStats(store.get('stats', null));
let analyzer = new Analyzer(gears, stats);
let idleThrottle = store.get('idleThr', 100);

// ---------- estado ----------
let transport = null;
let elm = null;
let running = false;
let pollList = [];
let slowList = [];
let cycle = 0;
let noData = {};
let lastTs = 0;
let lastSave = 0;
let lastSpoken = { msg: '', at: 0 };
let wakeLock = null;
let rate = { n: 0, since: performance.now() };
const live = {};
const trip = newTrip();
const tripLog = [];

function newTrip() { return { km: 0, l: 0, t: 0, green: 0, start: Date.now() }; }

// ---------- log ----------
const logLines = [];
function log(msg) {
  const ts = new Date().toLocaleTimeString('es', { hour12: false });
  logLines.push(`${ts} ${msg}`);
  if (logLines.length > 300) logLines.shift();
  const el = $('log');
  el.textContent = logLines.join('\n');
  el.scrollTop = el.scrollHeight;
}

function toast(msg, ms = 4000) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- conexión ----------
async function start(kind) {
  if (running) { await stop(); return; }
  try {
    if (kind === 'ble') {
      if (!BleTransport.available()) {
        toast('Este navegador no tiene Web Bluetooth. Abre la app en Chrome para Android, con Bluetooth y ubicación activados.', 8000);
        return;
      }
      transport = new BleTransport();
    } else {
      transport = new SimTransport();
    }
    setConn('busy', 'Conectando…');
    await transport.connect(log);
    transport.onDisconnect = () => { if (running) { toast('Se perdió la conexión con el adaptador'); stop(); } };
    elm = new Elm327(transport, log);
    setConn('busy', 'Iniciando ELM327…');
    const info = await elm.init();
    $('dElm').textContent = info.version || '?';
    $('dProto').textContent = info.protocol || '?';
    log(`ELM listo: ${info.version} protocolo ${info.protocol}`);

    const sup = await readSupported(elm);
    log(`PIDs soportados: ${[...sup].join(' ') || '(no informó)'}`);
    buildPollList(sup);
    setConn('on', transport.name);
    $('btnConnect').textContent = 'Desconectar';
    $('btnDemo').hidden = true;
    running = true;
    lastTs = 0;
    keepAwake();
    loop();
  } catch (e) {
    log('ERROR: ' + (e.message || e));
    if (e.name !== 'NotFoundError') toast(e.message || String(e), 7000);
    await stop();
  }
}

async function stop() {
  running = false;
  try { await transport?.disconnect(); } catch { /* nada */ }
  transport = null;
  elm = null;
  setConn('', 'Sin conectar');
  $('btnConnect').textContent = 'Conectar';
  $('btnDemo').hidden = false;
  try { await wakeLock?.release(); } catch { /* nada */ }
  wakeLock = null;
  save(true);
}

function setConn(state, name) {
  $('dot').className = 'dot ' + state;
  $('connName').textContent = name;
}

function buildPollList(sup) {
  const has = (p) => sup.size === 0 || sup.has(p);
  pollList = ['0C', '0D'];
  slowList = [];
  if (sup.has('5E')) pollList.push('5E');
  if (sup.has('10')) pollList.push('10');
  else if (has('0B')) { pollList.push('0B'); slowList.push('0F'); } // la MD201 no tiene MAF: usa MAP
  if (has('11')) pollList.push('11');
  if (sup.has('03')) pollList.push('03');
  if (has('04')) slowList.push('04');
  noData = {};
  showPids();
}

function dropPid(pid) {
  pollList = pollList.filter((p) => p !== pid);
  slowList = slowList.filter((p) => p !== pid);
  log(`01${pid} no responde, lo dejo de pedir`);
  if (pid === '10' && !pollList.includes('0B')) {
    pollList.push('0B');
    slowList.push('0F');
    log('Sin MAF: calculo con MAP + temperatura de admisión');
  }
  showPids();
}

function showPids() {
  $('dPids').textContent = pollList.map((p) => '01' + p).join(' ') + (slowList.length ? ' · lentos: ' + slowList.map((p) => '01' + p).join(' ') : '');
}

async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* opcional */ }
}
document.addEventListener('visibilitychange', () => { if (running && document.visibilityState === 'visible') keepAwake(); });

// ---------- ciclo de lectura ----------
async function loop() {
  while (running) {
    const s = {};
    const list = cycle++ % 8 === 0 ? [...pollList, ...slowList] : [...pollList];
    for (const pid of list) {
      if (!running) return;
      try {
        const lines = await elm.send('01' + pid, 2000);
        const v = decode(lines, pid);
        if (v != null) { s[PIDS[pid].key] = v; noData[pid] = 0; } else {
          noData[pid] = (noData[pid] || 0) + 1;
          if (noData[pid] >= 6 && pid !== '0C' && pid !== '0D') dropPid(pid);
        }
        rate.n++;
      } catch (e) {
        log(`01${pid}: ${e.message}`);
      }
    }
    if (!running) return;
    process(s);
  }
}

function process(s) {
  const now = performance.now();
  const dt = lastTs ? (now - lastTs) / 1000 : 0;
  lastTs = now;
  Object.assign(live, s);
  // Los PIDs lentos (temperatura, carga) se leen cada pocos ciclos: usar el último valor.
  for (const k of ['iat', 'load', 'fuelSys']) if (s[k] == null && live[k] != null) s[k] = live[k];

  if (s.throttle != null && s.rpm != null && s.rpm < 1100 && (s.speed ?? 0) < 3) {
    idleThrottle = Math.min(idleThrottle, s.throttle);
  }

  const f = fuelLph(s, { ...DEFAULT_ENGINE, displacement: cfg.displacement, ve: cfg.ve });
  let lph = f ? f.lph * cfg.corr : null;
  let fuelCut = false;
  if (cfg.dfco && f && f.method !== 'ECU (015E)' && (s.speed ?? 0) > 10 && (s.rpm ?? 0) > 1100) {
    // Corte de inyección: la ECU lo informa en 0103 (= 4) o, si no, acelerador en reposo.
    const thrIdle = s.throttle != null && idleThrottle < 100 && s.throttle <= idleThrottle + 1.5;
    if ((s.fuelSys === 4 && (s.throttle == null || thrIdle)) || (s.fuelSys == null && thrIdle && s.rpm > 1300)) {
      lph = 0; fuelCut = true;
    }
  }
  if (f) $('dMethod').textContent = f.method + (cfg.corr !== 1 ? ` ×${cfg.corr}` : '');

  const { gear } = analyzer.feed({ t: now / 1000, rpm: s.rpm, speed: s.speed, lph, fuelCut });
  const zone = zoneFor(gear);
  const adv = advise({ ...s, lph, gear, fuelCut }, zone, gears, cfg.nGears);

  if (dt > 0 && dt < 5) {
    if (s.speed != null) trip.km += (s.speed * dt) / 3600;
    if (lph != null) trip.l += (lph * dt) / 3600;
    trip.t += dt;
    if (adv.color === 'green') trip.green += dt;
  }

  const kml = kmPerL(s.speed, lph);
  if (tripLog.length < 30000) {
    tripLog.push([new Date().toISOString(), r1(s.rpm), s.speed, r2(s.maf), r2(s.map), r2(lph), r2(kml), gear ?? '', r1(s.throttle), r1(s.load), adv.color]);
  }

  render(s, { lph, kml, gear, zone, adv, method: f?.method });
  speak(adv);
  if (now - lastSave > 10000) save();
}

function zoneFor(gear) {
  const gz = gear ? stats.zone(gear) : null;
  if (gz?.learned) return gz;
  if (gear && gear === cfg.nGears) return { ...DEFAULT_TOP_ZONE };
  return stats.zone(0);
}

const r1 = (v) => (v == null ? '' : Math.round(v * 10) / 10);
const r2 = (v) => (v == null ? '' : Math.round(v * 100) / 100);

function save(force) {
  lastSave = performance.now();
  store.set('gears', gears.toJSON());
  store.set('stats', stats.toJSON());
  store.set('idleThr', idleThrottle);
  if (force) renderZoneTab();
}

// ---------- voz ----------
function speak(adv) {
  if (!cfg.voice || !adv.shift || !('speechSynthesis' in window)) return;
  const now = Date.now();
  if (adv.msg === lastSpoken.msg && now - lastSpoken.at < 20000) return;
  if (now - lastSpoken.at < 6000) return;
  lastSpoken = { msg: adv.msg, at: now };
  const u = new SpeechSynthesisUtterance(adv.msg.replace('ª', ''));
  u.lang = 'es-ES';
  speechSynthesis.speak(u);
}

// ---------- pintar ----------
const RPM_MAX = 5000;
function render(s, d) {
  const lamp = $('lamp');
  lamp.className = 'lamp ' + d.adv.color;
  if (d.kml != null) {
    $('kmL').textContent = d.kml >= 99 ? '∞' : d.kml.toFixed(1);
    $('kmLUnit').textContent = 'km/L';
  } else {
    $('kmL').textContent = d.lph != null ? d.lph.toFixed(1) : '--';
    $('kmLUnit').textContent = 'L/h (detenido)';
  }
  const adv = $('advice');
  adv.textContent = d.adv.msg;
  adv.className = 'advice ' + d.adv.color;

  $('rpm').textContent = s.rpm != null ? Math.round(s.rpm / 10) * 10 : '--';
  $('speed').textContent = s.speed ?? '--';
  $('gear').textContent = d.gear ? gearName(d.gear) : (s.speed > 3 ? 'N' : '-');

  const pct = (v) => `${Math.max(0, Math.min(100, (v / RPM_MAX) * 100))}%`;
  $('rpmNeedle').style.left = pct(s.rpm ?? 0);
  $('rpmZone').style.left = pct(d.zone.min);
  $('rpmZone').style.width = `calc(${pct(d.zone.max)} - ${pct(d.zone.min)})`;
  $('zoneCap').textContent = `Zona verde${d.gear && d.zone.learned ? ' en ' + gearName(d.gear) : ''}: ${d.zone.min}–${d.zone.max} rpm` +
    (d.zone.learned ? ` (aprendida, mejor ${d.zone.best.toFixed(1)} km/L)` : ' (inicial, aprendiendo)');

  $('tripKm').textContent = trip.km.toFixed(1);
  $('tripL').textContent = trip.l.toFixed(2);
  $('tripAvg').textContent = trip.l > 0.01 ? (trip.km / trip.l).toFixed(1) : '--';
  $('tripGreen').textContent = trip.t > 5 ? Math.round((trip.green / trip.t) * 100) : '--';
  $('mini').textContent = `Carga ${fmt(s.load)}% · Acelerador ${fmt(s.throttle)}% · ${d.lph != null ? d.lph.toFixed(2) : '--'} L/h · ${d.method || '--'}`;

  const el = (performance.now() - rate.since) / 1000;
  if (el > 3) { $('dRate').textContent = (rate.n / el).toFixed(1); rate = { n: 0, since: performance.now() }; }
}
const fmt = (v) => (v == null ? '--' : Math.round(v));

function renderZoneTab() {
  const rows = stats.rows(0).filter((r) => r.rpm >= 500 && r.rpm < 5500 && r.kmL);
  const z = stats.zone(0);
  const mins = Math.round(stats.totalSeconds() / 60);
  $('zoneSummary').innerHTML = z.learned
    ? `Tu camioneta rinde mejor entre <b>${z.min} y ${z.max} rpm</b>. El mejor rango fue ${z.bestRpm}–${z.bestRpm + BUCKET} rpm con <b>${z.best.toFixed(1)} km/L</b>. (${mins} min de datos)`
    : `Aún aprendiendo (${mins} min de datos). Mientras tanto uso 1500–2500 rpm. Maneja normal: necesito al menos ${MIN_BUCKET_SECONDS} s en 3 rangos distintos.`;

  const chart = $('chart');
  chart.innerHTML = '';
  const max = Math.max(1, ...rows.map((r) => r.kmL));
  for (const r of rows) {
    const col = document.createElement('div');
    col.className = 'col';
    const inZone = z.learned && r.rpm >= z.min && r.rpm < z.max;
    const lowData = r.t < MIN_BUCKET_SECONDS;
    col.innerHTML = `<div class="val">${r.kmL.toFixed(0)}</div>` +
      `<div class="barv${inZone ? ' in' : ''}${lowData ? ' low' : ''}" style="height:${(r.kmL / max) * 100}%"></div>` +
      `<div class="lbl">${(r.rpm / 1000).toFixed(r.rpm % 1000 ? 2 : 0)}k</div>`;
    col.title = `${r.rpm}–${r.rpm + BUCKET} rpm: ${r.kmL.toFixed(1)} km/L, ${Math.round(r.t)} s`;
    chart.appendChild(col);
  }
  if (!rows.length) chart.innerHTML = '<p class="hint">Sin datos todavía.</p>';
  renderSpeedTab();

  const tb = $('gearRows');
  tb.innerHTML = '';
  if (!gears.learned) { tb.innerHTML = '<tr><td colspan="4">Aprendiendo las marchas… maneja unos minutos.</td></tr>'; return; }
  for (let g = 1; g <= cfg.nGears; g++) {
    const p = gears.ratioOf(g);
    if (p == null) continue;
    const gz = stats.zone(g);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${gearName(g)}</td><td>${p.toFixed(1)}</td><td>${gz.learned ? `${gz.min}–${gz.max}` : '—'}</td><td>${gz.learned ? gz.best.toFixed(1) : '—'}</td>`;
    tb.appendChild(tr);
  }
}

function renderSpeedTab() {
  const tb = $('speedRows');
  const rows = stats.bySpeed();
  tb.innerHTML = rows.length ? '' : '<tr><td colspan="2">Sin datos todavía.</td></tr>';
  for (const r of rows) {
    const best = r.gears.reduce((a, b) => (b.kmL > a.kmL ? b : a));
    const tr = document.createElement('tr');
    const cells = r.gears.map((g) => {
      const rpm = gears.rpmInGear(r.band + 5, g.gear);
      const txt = `${gearName(g.gear)}: ${g.kmL.toFixed(1)} km/L${rpm ? ` <small>(~${Math.round(rpm / 50) * 50} rpm)</small>` : ''}`;
      return g === best && r.gears.length > 1 ? `<b class="ok">${txt}</b>` : txt;
    });
    tr.innerHTML = `<td>${r.band}–${r.band + 10}</td><td>${cells.join('<br>')}</td>`;
    tb.appendChild(tr);
  }
}

// ---------- exportar ----------
function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$('btnCsv').onclick = () => {
  if (!tripLog.length) { toast('No hay datos de este viaje todavía'); return; }
  const head = 'hora,rpm,kmh,maf_gs,map_kpa,l_h,km_l,marcha,acelerador,carga,color';
  download(`viaje-${new Date().toISOString().slice(0, 16).replace(':', '')}.csv`, [head, ...tripLog.map((r) => r.join(','))].join('\n'), 'text/csv');
};
$('btnJson').onclick = () => {
  download('obd-ahorro-datos.json', JSON.stringify({ cfg, gears: gears.toJSON(), peaks: gears.peaks, stats: stats.toJSON() }, null, 1), 'application/json');
};
$('btnWipe').onclick = () => {
  if (!confirm('¿Borrar todo lo aprendido (zonas y marchas)?')) return;
  gears = new GearLearner(cfg.nGears, null, cfg.gearRatios);
  stats = new RpmStats();
  analyzer = new Analyzer(gears, stats);
  save(true);
  toast('Datos borrados');
};
$('btnMd201').onclick = () => { $('cfgRatios').value = MD201_RATIOS.join(', '); saveCfg(); toast('Marchas de la MD201 cargadas'); };
$('btnLearned').onclick = () => {
  const d = gears.detect();
  if (d.length < 3) { toast('Todavía no hay suficientes datos para detectar las marchas'); return; }
  $('cfgRatios').value = d.map((x) => x.toFixed(1)).join(', ');
  saveCfg();
  toast(`Marchas detectadas: ${d.length}`);
};

// ---------- importar Car Scanner ----------
$('fileImport').onchange = async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    toast('Leyendo archivo…', 20000);
    const rows = parseCarScanner(await file.text());
    const an = new Analyzer(gears, stats);
    let n = 0; let km = 0; let l = 0;
    for (const r of rows) {
      const fuelCut = r.eco === 0 || r.lph === 0;
      const lph = r.lph != null ? r.lph * cfg.corr : null;
      const { dt } = an.feed({ t: r.t, rpm: r.rpm, speed: r.speed, lph, fuelCut });
      if (dt > 0 && dt < 5 && r.speed != null && lph != null) { km += (r.speed * dt) / 3600; l += (lph * dt) / 3600; n++; }
    }
    save(true);
    toast(`Importado: ${rows.length} lecturas, ${km.toFixed(1)} km, ${l.toFixed(2)} L (${(km / l).toFixed(1)} km/L)`, 7000);
    log(`Importado ${file.name}: ${rows.length} lecturas, ${km.toFixed(1)} km, ${l.toFixed(2)} L`);
  } catch (err) {
    toast('No pude importar: ' + err.message, 7000);
  }
};

$('btnTripReset').onclick = () => { Object.assign(trip, newTrip()); tripLog.length = 0; };

// ---------- ajustes ----------
function loadCfgForm() {
  const preset = ['1.243', '1.493'].includes(String(cfg.displacement)) ? String(cfg.displacement) : 'custom';
  $('cfgEngine').value = preset;
  $('customDispWrap').hidden = preset !== 'custom';
  $('cfgDisp').value = cfg.displacement;
  $('cfgGears').value = cfg.nGears;
  $('cfgVoice').checked = cfg.voice;
  $('cfgDfco').checked = cfg.dfco;
  $('cfgVe').value = cfg.ve;
  $('cfgCorr').value = cfg.corr;
  $('cfgRatios').value = (cfg.gearRatios || []).join(', ');
}
function saveCfg() {
  const eng = $('cfgEngine').value;
  $('customDispWrap').hidden = eng !== 'custom';
  cfg.displacement = eng === 'custom' ? Number($('cfgDisp').value) || cfg.displacement : Number(eng);
  const ng = Math.min(6, Math.max(4, Number($('cfgGears').value) || 5));
  if (ng !== cfg.nGears) { cfg.nGears = ng; gears.nGears = ng; gears._recompute(); }
  cfg.voice = $('cfgVoice').checked;
  cfg.dfco = $('cfgDfco').checked;
  cfg.ve = Number($('cfgVe').value) || DEFAULT_ENGINE.ve;
  cfg.corr = Number($('cfgCorr').value) || 1;
  const ratios = $('cfgRatios').value.split(/[,;\s]+/).map(Number).filter((x) => x > 1 && x < 80);
  cfg.gearRatios = ratios.length ? ratios : null;
  gears.preset = cfg.gearRatios ? [...cfg.gearRatios].sort((a, b) => a - b) : null;
  gears._recompute();
  store.set('cfg', cfg);
}
for (const id of ['cfgEngine', 'cfgDisp', 'cfgGears', 'cfgVoice', 'cfgDfco', 'cfgVe', 'cfgCorr', 'cfgRatios']) $(id).addEventListener('change', saveCfg);

$('cmdForm').onsubmit = async (e) => {
  e.preventDefault();
  const cmd = $('cmdIn').value.trim().toUpperCase();
  if (!cmd) return;
  if (!elm) { toast('Primero conecta el adaptador'); return; }
  try { log(`> ${cmd} → ${(await elm.send(cmd, 5000)).join(' | ')}`); } catch (err) { log(`> ${cmd}: ${err.message}`); }
  $('cmdIn').value = '';
};

// ---------- pestañas ----------
document.querySelectorAll('.tabs button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'zone') renderZoneTab();
  };
});

$('btnConnect').onclick = () => start('ble');
$('btnDemo').onclick = () => start('sim');

loadCfgForm();
renderZoneTab();
if (!BleTransport.available()) log('Web Bluetooth no disponible en este navegador. Usa Chrome en Android.');

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Para pruebas automáticas
window.__obd = { live, trip, stats: () => stats, gears: () => gears, sim: () => transport };
