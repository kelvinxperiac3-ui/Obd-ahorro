import { BleTransport } from './ble.js';
import { SimTransport } from './sim.js';
import { Elm327 } from './elm327.js';
import { PIDS, decode, readSupported, parseMulti } from './obd.js';
import { DEFAULT_ENGINE, fuelLph, kmPerL, fillGap } from './fuel.js';
import { GearLearner } from './gears.js';
import { RpmStats, BUCKET, MIN_BUCKET_SECONDS } from './stats.js';
import { vehicle, DEFAULT_VEHICLE } from './vehicles.js';
import { Analyzer } from './analyzer.js';
import { parseCarScanner } from './import.js';
import { HillDetector, powerAdvice, pedalPct } from './power.js';
import { advise, gearName } from './advise.js';
import { newTank, addDriving, registerFill, undoFill, suggestedFactor } from './tank.js';
import { newLegs, legAdd, legResume, legCost, legsByDay, pricePerLiter } from './legs.js';

const $ = (id) => document.getElementById(id);
// Dentro de la app Android (APK) se usan Bluetooth, voz, GPS y segundo plano nativos.
const NATIVE = !!window.Capacitor?.isNativePlatform?.();
const nat = NATIVE ? await import('./native.js') : null;
export const APP_VERSION = '2026-11-25b';
// Si la página (HTML) es de otra versión que este código, se recarga una vez sin caché.
if (document.documentElement.dataset.v !== APP_VERSION) {
  let tried = null;
  try { tried = sessionStorage.getItem('obd.reloadFor'); sessionStorage.setItem('obd.reloadFor', APP_VERSION); } catch { /* nada */ }
  if (tried !== APP_VERSION) location.reload();
}

// ---------- persistencia (localStorage protegido) ----------
const store = {
  get(k, def) { try { const v = localStorage.getItem('obd.' + k); return v ? JSON.parse(v) : def; } catch { return def; } },
  set(k, v) { try { localStorage.setItem('obd.' + k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};

// ---------- vehículos ----------
// Cada vehículo guarda su configuración, marchas y estadísticas por separado.
(function migrate() {
  // La primera versión guardaba todo sin vehículo: eso era la MD201.
  if (store.get('cfg', null) && !store.get('cfg.md201', null)) {
    for (const k of ['cfg', 'gears', 'stats', 'idleThr', 'fullThr']) {
      const v = store.get(k, null);
      if (v != null) store.set(`${k}.md201`, v);
    }
    const old = store.get('cfg', {});
    if (old.voice != null) store.set('voice', old.voice);
  }
}());

let V; // perfil del vehículo actual
let cfg;
let gears;
let stats;
let analyzer;
let idleThrottle;
let tank; // consumo real (tanque lleno a tanque lleno)
let legs; // tramos entre paradas, con su costo
let fullThrottle; // pedal/mariposa máxima vista (la MD201 llega a ~82 %)

function loadVehicle(id) {
  V = vehicle(id);
  store.set('vehicle', V.id);
  cfg = Object.assign({
    displacement: V.displacement,
    ve: DEFAULT_ENGINE.ve,
    nGears: V.nGears,
    dfco: true,
    corr: 1,
    gearRatios: V.gearRatios,
    loaded: false,
  }, store.get(`cfg.${V.id}`, {}));
  cfg.voice = store.get('voice', true);
  // La versión anterior solo tenía la 5ª y 6ª del Homan: pasar a las 6 marchas de la caja.
  if (V.id === 'homan' && JSON.stringify(cfg.gearRatios) === '[28.5,36]') cfg.gearRatios = V.gearRatios;
  gears = new GearLearner(cfg.nGears, store.get(`gears.${V.id}`, null), cfg.gearRatios);
  stats = new RpmStats(store.get(`stats.${V.id}`, null));
  analyzer = new Analyzer(gears, stats);
  tank = Object.assign(newTank(), store.get(`tank.${V.id}`, {}));
  legs = Object.assign(newLegs(), store.get(`legs.${V.id}`, {}));
  idleThrottle = store.get(`idleThr.${V.id}`, 100);
  fullThrottle = store.get(`fullThr.${V.id}`, 0);
}

function saveVehicleCfg() {
  const { voice, ...rest } = cfg;
  store.set(`cfg.${V.id}`, rest);
  store.set('voice', voice);
}

loadVehicle(store.get('vehicle', DEFAULT_VEHICLE));
const hill = new HillDetector();

// ---------- estado ----------
let transport = null;
let elm = null;
let running = false;
let pollList = [];
let slowList = [];
let supported = new Set();   // PIDs que la ECU dijo tener (para rearmar la lista)
let fastBest = { multi: false, suffix: false }; // lo mejor que funcionó en testFast
let engineBack = false;      // el motor volvió tras estar apagado: rearmar la lectura
let cycle = 0;
let noData = {};
let lastTs = 0;
let lastRead = null; // última lectura (velocidad y consumo), para rellenar cortes de conexión
let lastSave = 0;
let lastSpoken = { msg: '', at: 0 };
let wakeLock = null;
const gps = { speed: null, at: 0, watch: null };
let useGps = false;
let speedSrc = 'OBD';
let zeroSpeedSince = null;
let noRpm = 0;
let lastNotif = 0;
let reconnecting = false;
let hiddenAt = null;
let multi = false; // varias PIDs por consulta (CAN)
let suffix = false;
let aggressive = false; // ATAT2 // atajo "1": no esperar más respuestas
let rate = { n: 0, q: 0, ms: 0, since: performance.now() };
const live = {};
const liveAt = {};
const trip = newTrip();
const tripLog = [];

function newTrip() { return { km: 0, l: 0, t: 0, green: 0, start: Date.now() }; }
let pendingReload = false;
let lastDataAt = 0; // última lectura con motor encendido (para separar viajes)
let prevTripLog = []; // el viaje anterior, para poder exportarlo después de empezar otro
// Más de 1 hora sin motor (aunque la app siga conectada toda la noche): es otro viaje.
// Las paradas de venta (10–20 min con el motor apagado) quedan dentro del mismo viaje.
// Los contadores y el CSV no mezclan viajes; el anterior queda guardado para exportarlo.
function newTripIfIdle() {
  if (!lastDataAt || Date.now() - lastDataAt <= 60 * 60 * 1000) return;
  if (tripLog.length) prevTripLog = tripLog.splice(0);
  Object.assign(trip, newTrip());
  log('Viaje nuevo');
}

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
function friendlyError(e) {
  const m = `${e.name || ''} ${e.message || e}`;
  if (/cancel/i.test(m)) return 'Conexión cancelada.';
  if (/not available|adapter|Bluetooth is off|disabled/i.test(m)) return 'El Bluetooth del teléfono está apagado o sin permiso. Actívalo (y la ubicación) y vuelve a intentar.';
  if (/NotFoundError/i.test(m)) return 'No apareció el adaptador. Revisa que el KONNWEI tenga la luz encendida (botón de encendido), que el contacto esté en ON y que el teléfono tenga Bluetooth y ubicación activados.';
  if (/GATT|NetworkError|connect|disconnected/i.test(m)) return 'El adaptador no aceptó la conexión. Cierra Car Scanner u otras apps OBD (el adaptador atiende a una sola), apaga y prende el KONNWEI y vuelve a intentar.';
  if (/Sin respuesta a ATZ/i.test(m)) return 'El adaptador se conectó pero no responde. Desenchúfalo 5 segundos del puerto OBD y vuelve a intentar.';
  if (/Sin respuesta a 0100|no logra hablar|UNABLE/i.test(m)) return 'El adaptador responde, pero la camioneta no. Pon el contacto en ON (o enciende el motor) y vuelve a intentar.';
  return 'No pude conectar: ' + (e.message || e);
}

async function start(kind) {
  if (running) { await stop(); return; }
  try {
    if (kind === 'ble' && nat) {
      transport = new nat.NativeBleTransport();
    } else if (kind === 'ble') {
      if (!BleTransport.available()) {
        toast('Este navegador no tiene Web Bluetooth. Abre la app en Chrome para Android, con Bluetooth y ubicación activados.', 8000);
        return;
      }
      transport = new BleTransport();
    } else {
      transport = new SimTransport(V.id);
    }
    setConn('busy', 'Conectando…');
    await transport.connect(log);
    transport.onDisconnect = () => { if (running && !reconnecting) reconnect(); };
    elm = new Elm327(transport, log);
    setConn('busy', 'Iniciando ELM327…');
    const info = await elm.init();
    $('dElm').textContent = info.version || '?';
    $('dProto').textContent = protoName(info.protocol);
    log(`ELM listo: ${info.version} protocolo ${info.protocol}`);

    const sup = await readSupported(elm);
    log(`PIDs soportados: ${[...sup].join(' ') || '(no informó)'}`);
    buildPollList(sup);
    await testFast();
    setConn('on', transport.name);
    $('btnConnect').textContent = 'Desconectar';
    $('btnDemo').hidden = true;
    running = true;
    lastTs = 0;
    useGps = !!V.gpsSpeed;
    zeroSpeedSince = null;
    startGps();
    keepAwake();
    if (nat) {
      const ok = await nat.background.start(`Conectado a ${transport.name}`);
      log(ok ? 'Segundo plano activo: sigue leyendo con la pantalla apagada' : 'No pude activar el segundo plano');
    }
    loop();
  } catch (e) {
    log('ERROR: ' + (e.name ? e.name + ': ' : '') + (e.message || e));
    if (e.name !== 'NotFoundError' || !/cancel/i.test(e.message)) toast(friendlyError(e), 12000);
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
  if (nat) { nat.background.stop(); nat.background.keepScreenOn(false); }
  stopGps();
  multi = false;
  renderNoEngine();
  $('advice').textContent = 'Desconectado';
  save(true);
  if (pendingReload) location.reload();
}

const PROTOCOLS = {
  1: 'SAE J1850 PWM', 2: 'SAE J1850 VPW', 3: 'ISO 9141-2 (K-Line, lento)', 4: 'ISO 14230-4 KWP (K-Line, lento)',
  5: 'ISO 14230-4 KWP rápido (K-Line, lento)', 6: 'CAN 11 bit 500k', 7: 'CAN 29 bit 500k', 8: 'CAN 11 bit 250k',
  9: 'CAN 29 bit 250k', A: 'SAE J1939 (CAN)',
};
function protoName(code = '') {
  const c = code.replace(/^A/, '');
  const name = PROTOCOLS[c.toUpperCase()];
  return name ? `${code} · ${name}` : code || '?';
}

function setConn(state, name) {
  $('dot').className = 'dot ' + state;
  $('connName').textContent = name;
}

function buildPollList(sup) {
  supported = sup;
  const has = (p) => sup.size === 0 || sup.has(p);
  pollList = V.gpsSpeed ? ['0C'] : ['0C', '0D']; // el Homan informa velocidad 0: se usa GPS
  slowList = [];
  if (sup.has('5E')) pollList.push('5E');
  if (V.fuel === 'diesel') {
    // Diésel: consumo directo (015E). El MAF y la mariposa del Homan dan valores fijos, no sirven.
    if (!sup.has('5E')) log('La ECU no informa consumo (015E): sin km/L, solo consejos por RPM');
    if (sup.has('49')) pollList.push('49'); else if (has('11')) pollList.push('11');
  } else {
    if (sup.has('10')) pollList.push('10');
    else if (has('0B')) { pollList.push('0B'); slowList.push('0F'); } // la MD201 no tiene MAF: usa MAP
    if (has('11')) pollList.push('11');
    if (sup.has('03')) pollList.push('03');
  }
  if (has('04')) slowList.push('04');
  noData = {};
  showPids();
}

// Al conectar, prueba qué acelera la lectura en este vehículo:
//  1) varias PIDs en una consulta (solo CAN)
//  2) el atajo "1" al final (el ELM327 no espera respuestas de otras computadoras)
// Se queda con lo que funcione y responda correcto. Si algo falla después, vuelve atrás solo.
async function timed(cmd, pids, isMulti) {
  const t0 = performance.now();
  const lines = await elm.send(cmd, 3000);
  const ms = performance.now() - t0;
  const vals = isMulti ? parseMulti(lines, pids) : { [pids[0]]: decode(lines, pids[0]) };
  return { ok: pids.every((p) => vals[p] != null), ms, lines };
}

async function testFast() {
  multi = false;
  suffix = false;
  aggressive = false;
  const probe = [...pollList, ...slowList].slice(0, 3);
  try {
    if (probe.length >= 2) {
      const r = await timed('01' + probe.join(''), probe, true);
      multi = r.ok;
      log(`Consulta múltiple 01${probe.join('')}: ${r.ok ? 'sí' : 'no'} (${Math.round(r.ms)} ms) → ${r.lines.join(' | ')}`);
    }
    const pids = multi ? probe : ['0C'];
    const base = await timed('01' + pids.join(''), pids, multi);
    const fast = await timed('01' + pids.join('') + '1', pids, multi);
    suffix = fast.ok && fast.ms <= base.ms + 20;
    log(`Atajo "1": ${fast.ok ? `${Math.round(base.ms)} → ${Math.round(fast.ms)} ms` : 'no lo acepta'} → ${suffix ? 'lo uso' : 'no lo uso'}`);
    // Tiempos adaptativos agresivos (ATAT2): el ELM espera menos a la ECU. Se queda solo si
    // responde bien y más rápido.
    const avg = async () => {
      let ms = 0;
      for (let i = 0; i < 3; i++) {
        const r = await timed(cmdFor(pids), pids, multi);
        if (!r.ok) return Infinity;
        ms += r.ms;
      }
      return ms / 3;
    };
    const t1 = await avg();
    const at2 = (await elm.send('ATAT2')).join('');
    const t2 = /OK/.test(at2) ? await avg() : Infinity;
    aggressive = t2 < t1 - 5;
    if (!aggressive && /OK/.test(at2)) await elm.send('ATAT1');
    log(`ATAT2: ${/OK/.test(at2) ? `${Math.round(t1)} → ${Math.round(t2)} ms` : 'no lo acepta'} → ${aggressive ? 'lo uso' : 'no lo uso'}`);
  } catch (e) {
    log('Prueba de lectura rápida: ' + e.message);
  }
  fastBest = { multi, suffix };
  showFast();
}

function showFast() {
  $('dMulti').textContent = [
    multi ? 'varias PIDs por consulta' : 'una PID por consulta',
    suffix ? 'atajo "1" activo' : 'sin atajo',
    ...(aggressive ? ['tiempos agresivos'] : []),
  ].join(' · ');
}

function dropPid(pid) {
  pollList = pollList.filter((p) => p !== pid);
  slowList = slowList.filter((p) => p !== pid);
  log(`01${pid} no responde, lo dejo de pedir`);
  if (pid === '10' && V.fuel !== 'diesel' && !pollList.includes('0B')) {
    pollList.push('0B');
    slowList.push('0F');
    log('Sin MAF: calculo con MAP + temperatura de admisión');
  }
  showPids();
}

// Al volver el motor o tras reconectar: otra vez la lista completa y la lectura más rápida
// que funcionó. Si algo de eso de verdad no responde, las vueltas siguientes lo quitan solas.
function restorePolling(why) {
  const before = pollList.length + slowList.length;
  buildPollList(supported);
  if (pollList.length + slowList.length > before) log(`${why}: vuelvo a pedir todos los datos`);
  multi = fastBest.multi;
  suffix = fastBest.suffix;
  showFast();
}

function showPids() {
  $('dPids').textContent = pollList.map((p) => '01' + p).join(' ') + (slowList.length ? ' · lentos: ' + slowList.map((p) => '01' + p).join(' ') : '');
}

// ---------- GPS (para vehículos que no informan velocidad por OBD) ----------
function startGps() {
  if (transport?.gpsSpeed || gps.watch != null) return;
  if (nat) {
    gps.watch = 'pendiente';
    nat.watchGps(
      (kmh) => { gps.speed = kmh; gps.at = performance.now(); },
      (err) => { log('GPS: ' + (err?.message || err)); if (V.gpsSpeed) toast('Activa la ubicación: este vehículo necesita el GPS para la velocidad', 7000); },
    ).then((id) => { gps.watch = id; }).catch((e) => { gps.watch = null; log('GPS: ' + e.message); });
    return;
  }
  if (!navigator.geolocation) return;
  gps.watch = navigator.geolocation.watchPosition(
    (p) => { if (p.coords.speed != null) { gps.speed = p.coords.speed * 3.6; gps.at = performance.now(); } },
    (err) => { log('GPS: ' + err.message); if (V.gpsSpeed) toast('Activa la ubicación: este vehículo necesita el GPS para la velocidad', 7000); },
    { enableHighAccuracy: true, maximumAge: 1000 },
  );
}
function stopGps() {
  if (nat) nat.clearGps(gps.watch);
  else if (gps.watch != null) navigator.geolocation?.clearWatch(gps.watch);
  gps.watch = null;
  gps.speed = null;
}
function gpsNow() {
  if (transport?.gpsSpeed) return transport.gpsSpeed();
  return performance.now() - gps.at < 4000 ? gps.speed : null;
}

async function keepAwake() {
  if (nat) { nat.background.keepScreenOn(true); return; }
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* opcional */ }
}
document.addEventListener('visibilitychange', () => {
  if (!running) return;
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    log(nat ? 'App en segundo plano: sigue leyendo' : 'App en segundo plano: Chrome puede pausar la lectura');
    return;
  }
  keepAwake();
  if (hiddenAt) log(`De vuelta en primer plano tras ${Math.round((Date.now() - hiddenAt) / 1000)} s`);
  hiddenAt = null;
  // Si el Bluetooth se cortó mientras estaba en segundo plano, reconectar solo.
  if (transport?.connected === false && !reconnecting) reconnect();
});

// ---------- reconexión automática ----------
// Si el adaptador se desconecta (corte de Bluetooth, se duerme con el motor apagado, segundo
// plano), intenta volver a conectar al mismo adaptador sin pedir nada. El viaje sigue donde iba.
// Primero rápido; después cada 20 s, hasta 90 min (una parada larga de venta). Si el Bluetooth
// conecta pero el contacto está apagado, la camioneta no contesta: también se sigue esperando.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RECONNECT_FOR = 90 * 60 * 1000;
async function reconnect() {
  if (!transport?.reconnect) { toast('Se perdió la conexión con el adaptador'); stop(); return; }
  reconnecting = true;
  setConn('busy', 'Reconectando…');
  renderNoEngine();
  $('advice').textContent = 'Reconectando con el adaptador…';
  const since = Date.now();
  for (let i = 1; running && Date.now() - since < RECONNECT_FOR; i++) {
    const say = i <= 6 || i % 10 === 0; // sin llenar el registro en una parada larga
    try {
      if (say) log(`Reconectando (intento ${i})…`);
      // Si el Bluetooth sigue conectado (solo faltó la camioneta), no hace falta rehacerlo.
      if (!transport.connected || i % 3 === 0) await transport.reconnect(say ? log : () => {});
      // Que termine (o se dé por perdida) la pregunta que iba en el aire antes del corte, para
      // que su respuesta atrasada no se confunda con las nuevas.
      const old = elm;
      await Promise.race([old?.queue, sleep(3000)]);
      elm = new Elm327(transport, say ? log : () => {});
      elm.draining = !!old?.draining;
      await elm.init();
      elm.log = log;
      buildPollList(supported); // otra vez todos los datos (con el motor apagado se pudo perder alguno)
      await testFast();
      reconnecting = false;
      setConn('on', transport.name);
      toast('Reconectado');
      log('Reconectado');
      return;
    } catch (e) {
      if (say) log(`Reconexión ${i}: ${e.message}`);
      if (i === 6) { setConn('busy', 'Esperando al adaptador…'); $('advice').textContent = 'Esperando al adaptador: se conecta solo al dar el contacto'; }
      await sleep(i < 6 ? 1500 * i : 20000);
    }
  }
  reconnecting = false;
  if (running) { toast('No pude reconectar con el adaptador'); stop(); }
}

// ---------- ciclo de lectura ----------
// Qué pedir en cada vuelta: RPM y velocidad siempre (es lo que se ve cambiar al manejar);
// consumo y pedal una vuelta por medio; temperatura y carga cada 8 vueltas.
const FAST = new Set(['0C', '0D']);
const FUEL = new Set(['0B', '10', '5E']); // datos para calcular el consumo
function cycleList(n) {
  if (multi) {
    // CAN: varias PIDs por consulta, cuesta casi lo mismo pedir 2 que 6.
    const fast = pollList.filter((p) => FAST.has(p));
    const mid = pollList.filter((p) => !FAST.has(p));
    return [...fast, ...(n % 2 === 0 ? mid : []), ...(n % 8 === 0 ? slowList : [])];
  }
  // Una PID por consulta (K-Line, como la MD201): cada pregunta cuesta, así que en cada
  // vuelta van las RPM y UNA cosa más, alternando velocidad y consumo. Así las RPM se
  // actualizan unas 2 veces por segundo en vez de una vez cada 1.5 s.
  const speed = pollList.filter((p) => p === '0D');
  const fuel = pollList.filter((p) => FUEL.has(p));
  const other = pollList.filter((p) => !FAST.has(p) && !FUEL.has(p));
  const second = n % 2 === 1 && speed.length ? speed : fuel;
  return ['0C', ...second, ...(n % 4 === 0 ? other : []), ...(n % 16 === 0 ? slowList : [])].filter((p, i, a) => a.indexOf(p) === i && (p !== '0C' || pollList.includes('0C')));
}

// Comando OBD para una o varias PIDs. Con `suffix`, se agrega "1": el ELM327 contesta apenas
// llega la primera respuesta en vez de esperar por si responde otra computadora del vehículo.
const cmdFor = (pids) => '01' + pids.join('') + (suffix ? '1' : '');

async function loop() {
  while (running) {
    if (reconnecting) { await sleep(300); continue; }
    if (engineBack) { engineBack = false; restorePolling('Motor encendido de nuevo'); }
    const s = {};
    const list = cycleList(cycle++);
    const t0 = performance.now();
    if (multi) {
      // Hasta 6 PIDs por consulta: una sola ida y vuelta por Bluetooth.
      for (let i = 0; i < list.length && running && !reconnecting; i += 6) {
        const chunk = list.slice(i, i + 6);
        try {
          const vals = parseMulti(await elm.send(cmdFor(chunk), 2500), chunk);
          for (const pid of chunk) {
            if (vals[pid] != null) { s[PIDS[pid].key] = vals[pid]; noData[pid] = 0; }
            else if (pid === '0C' || vals['0C'] != null) noData[pid] = (noData[pid] || 0) + 1; // motor apagado no cuenta
          }
          rate.q++;
        } catch (e) {
          log(`multi ${chunk.join(',')}: ${e.message}`);
        }
      }
      if (s.rpm == null && (noData['0C'] || 0) >= 3) {
        multi = false;
        suffix = false;
        log('Las consultas múltiples dejaron de responder: vuelvo a una PID por consulta');
        showFast();
      }
    } else {
      for (const pid of list) {
        if (!running) return;
        if (reconnecting) break;
        try {
          const lines = await elm.send(cmdFor([pid]), 2000);
          const v = decode(lines, pid);
          if (v != null) { s[PIDS[pid].key] = v; noData[pid] = 0; } else if (pid === '0C' || s.rpm != null) {
            // Si las RPM tampoco contestan, el motor está apagado: la ECU no responde nada y eso
            // no quiere decir que el dato no exista (antes se dejaban de pedir y el km/L quedaba en --).
            noData[pid] = (noData[pid] || 0) + 1;
            if (noData[pid] >= 6 && !FAST.has(pid)) dropPid(pid);
            if (suffix && pid === '0C' && noData[pid] >= 3) {
              suffix = false;
              log('Sin respuesta con el atajo "1": lo desactivo');
              showFast();
            }
          }
          rate.q++;
        } catch (e) {
          log(`01${pid}: ${e.message}`);
        }
      }
    }
    if (!running) return;
    if (reconnecting) continue;
    rate.ms += performance.now() - t0;
    rate.n++;
    process(s);
  }
}

function process(s) {
  const now = performance.now();
  const dt = lastTs ? (now - lastTs) / 1000 : 0;
  lastTs = now;
  Object.assign(live, s);
  if (s.rpm == null) {
    // Sin RPM: motor apagado o la ECU no responde. No se cuenta ni se graba.
    if (++noRpm >= 3) renderNoEngine();
    lastTs = 0;
    return;
  }
  if (noRpm >= 3) engineBack = true;
  noRpm = 0;
  const done = legResume(legs, Date.now(), tank.price);
  if (done) {
    log(`Tramo terminado: ${done.km.toFixed(1)} km, ${done.l.toFixed(2)} L`);
    if ($('tab-cost').classList.contains('active')) renderCostTab();
  }
  newTripIfIdle();
  lastDataAt = Date.now();
  // Los PIDs lentos (temperatura, carga) se leen cada pocos ciclos: usar el último valor.
  // Los datos que no se piden en cada vuelta (consumo, pedal, temperatura…) usan el último valor
  // leído, si es reciente.
  for (const k of Object.keys(s)) liveAt[k] = now;
  // La temperatura y la carga se leen cada 16 vueltas en K-Line (~6 s): se les da más margen
  // para que no queden huecos justo antes de la siguiente lectura.
  for (const k of ['speed', 'map', 'maf', 'throttle', 'pedalD', 'fuelRate', 'fuelSys', 'iat', 'load']) {
    const maxAge = k === 'iat' || k === 'load' ? 15000 : 6000;
    if (s[k] == null && live[k] != null && now - (liveAt[k] || 0) < maxAge) s[k] = live[k];
  }

  // Velocidad: OBD, o GPS si el vehículo no la informa (o informa 0 andando).
  const g = gpsNow();
  if (!useGps && s.speed === 0 && g != null && g > 10 && (s.rpm ?? 0) > V.idleRpm + 400) {
    zeroSpeedSince ??= now;
    if (now - zeroSpeedSince > 5000) { useGps = true; log('La ECU informa velocidad 0 andando: uso la del GPS'); }
  } else if (!useGps) zeroSpeedSince = null;
  if (useGps) s.speed = g != null ? Math.round(g) : null;
  speedSrc = useGps ? 'GPS' : 'OBD';

  // Pedal: en el Homan el pedal D (0149); en la MD201 la mariposa (0111).
  const pedalRaw = V.pedalPid === '49' ? (s.pedalD ?? (V.fuel === 'diesel' ? null : s.throttle)) : s.throttle;
  if (pedalRaw != null && s.rpm != null && s.rpm < V.idleRpm + 300 && (s.speed ?? 0) < 3) {
    idleThrottle = Math.min(idleThrottle, pedalRaw);
  }
  if (pedalRaw != null && (s.rpm ?? 0) > V.idleRpm + 700) fullThrottle = Math.max(fullThrottle, pedalRaw);
  const pedal = pedalPct(pedalRaw, idleThrottle, fullThrottle);

  const f = fuelLph(s, { ...DEFAULT_ENGINE, fuel: V.fuel, displacement: cfg.displacement, ve: cfg.ve });
  let lph = f ? f.lph * cfg.corr : null;
  let fuelCut = false;
  if (cfg.dfco && f && f.method !== 'ECU (015E)' && (s.speed ?? 0) > 10 && (s.rpm ?? 0) > 1100) {
    // Corte de inyección: la ECU lo informa en 0103 (= 4) o, si no, acelerador en reposo.
    const thrIdle = pedalRaw != null && idleThrottle < 100 && pedalRaw <= idleThrottle + 1.5;
    if ((s.fuelSys === 4 && (pedalRaw == null || thrIdle)) || (s.fuelSys == null && thrIdle && s.rpm > V.idleRpm + 500)) {
      lph = 0; fuelCut = true;
    }
  }
  if (f) $('dMethod').textContent = f.method + (cfg.corr !== 1 ? ` ×${cfg.corr}` : '');

  // En subida o cargado el km/L no es comparable con el plano: no se usa para la zona de ahorro.
  const { gear, accel } = analyzer.feed({ t: now / 1000, rpm: s.rpm, speed: s.speed, lph, fuelCut, skip: hill.active });
  const climbing = hill.update({ t: now / 1000, pedal, accel, speed: s.speed, loaded: cfg.loaded });
  let zone = zoneFor(gear);
  let adv = null;
  if (climbing) {
    adv = powerAdvice({ ...s, gear }, gears, cfg.nGears, cfg.loaded, V.power);
    if (adv) zone = { min: cfg.loaded ? V.power.minLoaded : V.power.min, max: V.power.max, power: true };
  }
  if (!adv && (s.rpm ?? 0) > V.power.max) adv = powerAdvice({ ...s, gear }, gears, cfg.nGears, cfg.loaded, V.power);
  if (!adv) {
    adv = advise({ ...s, throttle: pedal, lph, gear, fuelCut }, zone, gears, cfg.nGears, {
      lugRpm: V.lugRpm, upMinRpm: V.upMinRpm, idleRpm: V.idleRpm,
      redMargin: V.fuel === 'diesel' ? 400 : 600, redMarginTop: V.fuel === 'diesel' ? 600 : 1200, topMax: V.ecoTop.max,
      topHint: gear === cfg.nGears ? topGearHint(s.speed) : null,
    });
  }

  // Para el consumo real: km y litros estimados SIN el factor de corrección.
  const rawLph = f ? (fuelCut ? 0 : f.lph) : null;
  if (dt > 0 && dt < 5) {
    if (s.speed != null && rawLph != null) addDriving(tank, (s.speed * dt) / 3600, (rawLph * dt) / 3600);
    if (s.speed != null) trip.km += (s.speed * dt) / 3600;
    if (lph != null) trip.l += (lph * dt) / 3600;
    trip.t += dt;
    if (adv.color === 'green') trip.green += dt;
    legAdd(legs, s.speed != null ? (s.speed * dt) / 3600 : 0, lph != null ? (lph * dt) / 3600 : 0, Date.now());
  } else {
    const gap = fillGap(lastRead, { speed: s.speed, lph, rawLph }, dt);
    if (gap) {
      if (gap.rawL != null) addDriving(tank, gap.km, gap.rawL);
      trip.km += gap.km;
      trip.l += gap.l;
      trip.t += dt;
      legAdd(legs, gap.km, gap.l, Date.now());
      log(`Corte de ${Math.round(dt)} s andando: estimo ${gap.km.toFixed(2)} km y ${gap.l.toFixed(2)} L`);
    }
  }
  lastRead = { speed: s.speed, lph, rawLph };

  const kml = kmPerL(s.speed, lph);
  if (tripLog.length < 30000) {
    tripLog.push([new Date().toISOString(), r1(s.rpm), s.speed, r2(s.maf), r2(s.map), r2(lph), r2(kml), gear ?? '', r1(pedal), r1(s.load), adv.color, climbing ? 1 : 0, speedSrc]);
  }

  render(s, { lph, kml, gear, zone, adv, method: f?.method, pedal, climbing });
  if (nat && now - lastNotif > 5000) {
    lastNotif = now;
    nat.background.update(`${Math.round(s.rpm / 10) * 10} rpm · ${s.speed ?? '--'} km/h · ${kml != null ? (kml >= 99 ? '∞' : kml.toFixed(1)) + ' km/L' : 'detenido'} · ${adv.msg}`);
  }
  speak(adv);
  if (now - lastSave > 10000) save();
}

// Zona para aconsejar: la aprendida de esa marcha (si es confiable) o la de fábrica.
// La zona "general" (todas las marchas juntas) solo se muestra: mezclar marchas confunde
// RPM con velocidad.
function defaultZone(gear) {
  return gear && gear === cfg.nGears ? V.ecoTop : V.eco;
}
// En la última marcha: cuánto mejor rendiste a menor velocidad (según lo aprendido).
function topGearHint(speed) {
  if (speed == null) return null;
  const top = stats.bySpeed(60)
    .map((b) => ({ band: b.band, g: b.gears.find((x) => x.gear === cfg.nGears) }))
    .filter((b) => b.g);
  const cur = top.find((b) => b.band === Math.floor(speed / 10) * 10);
  if (!cur) return null;
  const best = top.reduce((a, b) => (b.g.kmL > a.g.kmL ? b : a));
  const gain = best.g.kmL / cur.g.kmL - 1;
  if (best.band >= cur.band || gain < 0.08) return null;
  return `A ${best.band}–${best.band + 10} km/h rindes ${Math.round(gain * 100)} % más`;
}

function zoneFor(gear) {
  const gz = gear ? stats.zone(gear, 0.9, defaultZone(gear)) : null;
  return gz?.learned ? gz : { ...defaultZone(gear), learned: false };
}

const r1 = (v) => (v == null ? '' : Math.round(v * 10) / 10);
const r2 = (v) => (v == null ? '' : Math.round(v * 100) / 100);

function save(force) {
  lastSave = performance.now();
  store.set(`gears.${V.id}`, gears.toJSON());
  store.set(`stats.${V.id}`, stats.toJSON());
  store.set(`tank.${V.id}`, tank);
  store.set(`legs.${V.id}`, legs);
  store.set(`idleThr.${V.id}`, idleThrottle);
  store.set(`fullThr.${V.id}`, fullThrottle);
  if (force) renderZoneTab();
}

// ---------- voz ----------
function say(text) {
  if (nat) { nat.speak(text); return; }
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'es-ES';
  speechSynthesis.speak(u);
}
function hush() {
  if (nat) nat.stopSpeaking();
  else if ('speechSynthesis' in window) speechSynthesis.cancel();
}
function speak(adv) {
  if (!cfg.voice || !adv.shift || (!nat && !('speechSynthesis' in window))) return;
  const now = Date.now();
  if (adv.msg === lastSpoken.msg && now - lastSpoken.at < (adv.power ? 10000 : 20000)) return;
  if (now - lastSpoken.at < (adv.power ? 3000 : 6000)) return;
  lastSpoken = { msg: adv.msg, at: now };
  const ORD = ['', 'primera', 'segunda', 'tercera', 'cuarta', 'quinta', 'sexta'];
  const m = /(Sube|Baja|sube|baja) a (\d)/.exec(adv.msg);
  const text = m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} a ${ORD[m[2]]}` : adv.msg;
  say(text);
}

// ---------- pintar ----------
function render(s, d) {
  const lamp = $('lamp');
  lamp.className = 'lamp ' + d.adv.color;
  $('modeBadge').hidden = !d.climbing;
  $('rpmZone').classList.toggle('power', !!d.zone.power);
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

  animTo('rpm', s.rpm);
  animTo('speed', s.speed);
  $('speedLbl').textContent = speedSrc === 'GPS' ? 'km/h (GPS)' : 'km/h';
  $('gear').textContent = d.gear ? gearName(d.gear) : (s.speed > 3 ? 'N' : '-');

  const pct = (v) => `${Math.max(0, Math.min(100, (v / V.gaugeMax) * 100))}%`;
  $('rpmZone').style.left = pct(d.zone.min);
  $('rpmZone').style.width = `calc(${pct(d.zone.max)} - ${pct(d.zone.min)})`;
  if (d.zone.power) $('zoneCap').textContent = `Zona de fuerza: ${d.zone.min}–${d.zone.max} rpm${cfg.loaded ? ' (cargado)' : ''}`;
  else $('zoneCap').textContent = `Zona verde${d.gear && d.zone.learned ? ' en ' + gearName(d.gear) : ''}: ${d.zone.min}–${d.zone.max} rpm` +
    (d.zone.learned ? ` (aprendida, mejor ${d.zone.best.toFixed(1)} km/L)` : ' (inicial, aprendiendo)');

  $('tripKm').textContent = trip.km.toFixed(1);
  $('tripL').textContent = trip.l.toFixed(2);
  $('tripAvg').textContent = trip.l > 0.01 ? (trip.km / trip.l).toFixed(1) : '--';
  $('tripGreen').textContent = trip.t > 5 ? Math.round((trip.green / trip.t) * 100) : '--';
  $('tripCost').textContent = tank.price
    ? `Este viaje: ${money(legCost(trip.l, tank.price))}` + (legs.cur ? ` · Desde la última parada: ${money(legCost(legs.cur.l, tank.price))}` : '')
    : 'Anota cuánto pagas al cargar bencina (pestaña Tanque) para ver el costo';
  $('mini').textContent = `Carga ${fmt(s.load)}% · Pedal ${fmt(d.pedal)}% · ${d.lph != null ? d.lph.toFixed(2) : '--'} L/h · ${d.method || '--'}`;

  const el = (performance.now() - rate.since) / 1000;
  if (el > 3) {
    $('dRate').textContent = rate.n
      ? `${(rate.n / el).toFixed(1)} por segundo · ${Math.round(rate.ms / rate.n)} ms por vuelta · ${(rate.q / el).toFixed(1)} consultas/s`
      : '--';
    rate = { n: 0, q: 0, ms: 0, since: performance.now() };
  }
}
const fmt = (v) => (v == null ? '--' : Math.round(v));

// ---------- animación suave de RPM, velocidad y aguja ----------
// Entre una lectura y la siguiente los números avanzan de a poco, así no se ven saltos.
const anim = { rpm: { cur: null }, speed: { cur: null } };
let animFrame = null;
function drawAnim(key) {
  const a = anim[key];
  if (key === 'rpm') {
    $('rpm').textContent = a.cur == null ? '--' : Math.round(a.cur / 10) * 10;
    $('rpmNeedle').style.left = `${Math.max(0, Math.min(100, ((a.cur ?? 0) / V.gaugeMax) * 100))}%`;
  } else {
    $('speed').textContent = a.cur == null ? '--' : Math.round(a.cur);
  }
}
function animTo(key, val) {
  const a = anim[key];
  if (val == null || a.cur == null) { a.cur = val ?? null; a.to = a.cur; drawAnim(key); return; }
  a.from = a.cur;
  a.to = val;
  a.t0 = performance.now();
  // Dura lo mismo que una vuelta de lectura: llega al valor justo cuando llega el siguiente.
  a.dur = Math.min(800, Math.max(100, rate.n ? rate.ms / rate.n : 300));
  if (!animFrame) animFrame = requestAnimationFrame(stepAnim);
}
function stepAnim(now) {
  let more = false;
  for (const key of Object.keys(anim)) {
    const a = anim[key];
    if (a.cur == null || a.t0 == null) continue;
    const p = Math.min(1, (now - a.t0) / a.dur);
    a.cur = a.from + (a.to - a.from) * p;
    drawAnim(key);
    if (p < 1) more = true;
  }
  animFrame = more ? requestAnimationFrame(stepAnim) : null;
}

function renderNoEngine() {
  $('lamp').className = 'lamp off';
  $('kmL').textContent = '--';
  $('kmLUnit').textContent = 'km/L';
  $('advice').textContent = 'Motor apagado o sin respuesta';
  $('advice').className = 'advice';
  animTo('rpm', null);
  animTo('speed', null);
  $('gear').textContent = '-';
  $('modeBadge').hidden = true;
}

function renderZoneTab() {
  const rows = stats.rows(0).filter((r) => r.rpm >= 500 && r.rpm < 5500 && r.kmL);
  const z = stats.zone(0, 0.9, V.eco);
  const mins = Math.round(stats.totalSeconds() / 60);
  const used = stats.rows(0).filter((r) => r.t >= MIN_BUCKET_SECONDS && r.kmL);
  const span = used.length ? `${used[0].rpm}–${used[used.length - 1].rpm + BUCKET} rpm` : '';
  const why = {
    pocos: `Maneja normal: necesito al menos ${MIN_BUCKET_SECONDS} s a velocidad pareja en 4 rangos de RPM distintos.`,
    rango: `Hasta ahora casi todo fue en ${span}. Para comparar necesito datos en más rangos (ciudad, caminos a 60–80 km/h).`,
    parejo: `En los rangos que manejaste (${span}) el rendimiento fue parecido (±10 %), así que los datos todavía no muestran una zona mejor.`,
    borde: `El mejor rendimiento quedó en el rango más alto medido (${span}): el óptimo podría estar fuera, necesito más datos.`,
  }[z.reason] || '';
  $('zoneSummary').innerHTML = z.learned
    ? `Tu ${V.short} rinde mejor entre <b>${z.min} y ${z.max} rpm</b>. El mejor rango fue ${z.bestRpm}–${z.bestRpm + BUCKET} rpm con <b>${z.best.toFixed(1)} km/L</b>. (${mins} min de datos)`
    : `Aún aprendiendo (${mins} min de datos). Mientras tanto uso la zona recomendada: <b>${V.eco.min}–${V.eco.max} rpm</b> (en ${gearName(cfg.nGears)} hasta ${V.ecoTop.max}). ${why}`;

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
  if (nat) {
    nat.shareFile(name, text).catch((e) => toast('No pude compartir: ' + e.message));
    return;
  }
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$('btnCsv').onclick = () => {
  let rows = tripLog;
  if (prevTripLog.length && (!tripLog.length || confirm('Hay un viaje anterior guardado. ¿Exportar ese en vez del actual?'))) rows = prevTripLog;
  if (!rows.length) { toast('No hay datos de este viaje todavía'); return; }
  const head = 'hora,rpm,kmh,maf_gs,map_kpa,l_h,km_l,marcha,pedal,carga,color,modo_fuerza,fuente_velocidad';
  // El nombre lleva la hora en que empezó el viaje (no la de exportar).
  download(`viaje-${String(rows[0][0]).slice(0, 16).replace(':', '')}.csv`, [head, ...rows.map((r) => r.join(','))].join('\n'), 'text/csv');
};
// Respaldo completo (los dos vehículos): sirve para pasar los datos de Chrome a la app
// Android, o a otro teléfono.
const DATA_KEYS = ['cfg', 'gears', 'stats', 'tank', 'idleThr', 'fullThr', 'legs']; // legs = tramos y gastos por día
$('btnJson').onclick = () => {
  save();
  const vehicles = {};
  for (const id of ['md201', 'homan']) {
    const v = {};
    for (const k of DATA_KEYS) { const x = store.get(`${k}.${id}`, null); if (x != null) v[k] = x; }
    if (Object.keys(v).length) vehicles[id] = v;
  }
  const data = { app: 'obd-ahorro', format: 2, version: APP_VERSION, date: new Date().toISOString(), voice: cfg.voice, vehicle: V.id, vehicles };
  download(`obd-ahorro-datos-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
};
$('fileData').onchange = async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (running) { toast('Desconecta antes de importar datos'); return; }
  try {
    const d = JSON.parse(await file.text());
    let vehicles = d.vehicles;
    if (!vehicles && d.vehicle && d.stats) vehicles = { [d.vehicle]: { cfg: d.cfg, gears: d.gears, stats: d.stats } }; // formato antiguo
    if (!vehicles || !Object.keys(vehicles).length) throw new Error('el archivo no trae datos de la app');
    const names = Object.keys(vehicles).join(' y ');
    if (!confirm(`¿Reemplazar los datos de ${names} con los del archivo?`)) return;
    for (const [id, v] of Object.entries(vehicles)) {
      for (const k of DATA_KEYS) if (v[k] != null) store.set(`${k}.${id}`, v[k]);
    }
    if (d.voice != null) store.set('voice', d.voice);
    loadVehicle(d.vehicle && vehicles[d.vehicle] ? d.vehicle : V.id);
    setGauge();
    loadCfgForm();
    showLoaded();
    showVoice();
    renderZoneTab();
    renderTankTab();
    toast(`Datos importados: ${names}`);
  } catch (err) {
    toast('No pude importar: ' + err.message, 7000);
  }
};
$('btnWipe').onclick = () => {
  if (!confirm('¿Borrar todo lo aprendido (zonas y marchas)?')) return;
  gears = new GearLearner(cfg.nGears, null, cfg.gearRatios);
  stats = new RpmStats();
  analyzer = new Analyzer(gears, stats);
  save(true);
  toast('Datos borrados');
};
$('btnMd201').onclick = () => { $('cfgRatios').value = V.gearRatios.join(', '); saveCfg(); toast(`Marchas medidas del ${V.short} cargadas`); };
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

// ---------- tanque: consumo real ----------
const fmtDate = (iso) => new Date(iso).toLocaleDateString('es', { day: 'numeric', month: 'short' });
const WARN_TEXT = {
  litros: 'Faltan los litros cargados.',
  corto: 'Tramo corto (menos de 50 km): el corte de la bomba tiene ±1 L de error, así que el resultado puede variar mucho. Mejor esperar medio estanque.',
  cobertura: 'La app midió solo parte de los km (manejaste un tramo sin conectarla). El km/L real es correcto, pero el factor es menos confiable.',
  sinDatos: 'La app no registró consumo en este período, así que no hay con qué comparar.',
};

function renderTankTab() {
  const p = tank.period;
  if (!p) {
    $('tankStatus').innerHTML = `<b>Paso 1:</b> llena el estanque del ${V.short} hasta el corte y toca <b>Registrar carga</b>. La primera vez no hace falta poner litros.`;
  } else {
    const est = p.rawL > 0.05 ? ` (${(p.km / p.rawL).toFixed(1)} km/L estimado sin corrección)` : '';
    $('tankStatus').innerHTML = `Midiendo desde el <b>${fmtDate(p.start)}</b>${p.odoStart != null ? ` (odómetro ${p.odoStart} km)` : ''}: ` +
      `<b>${p.km.toFixed(1)} km</b> con la app y <b>${p.rawL.toFixed(2)} L</b> estimados${est}.` +
      (tank.pendingL ? ` Cargas parciales: ${tank.pendingL.toFixed(2)} L.` : '') +
      ' Cuando vuelvas a llenar hasta el corte, anota los litros de la bomba.';
  }
  $('fillL').placeholder = p ? 'ej. 32.5' : 'no hace falta la primera vez';
  $('btnUndoFill').hidden = !tank.undo;

  const sf = suggestedFactor(tank.history);
  if (sf) {
    $('factorInfo').innerHTML = `Factor sugerido: <b>${sf.factor.toFixed(3)}</b> (promedio de ${sf.n} carga${sf.n > 1 ? 's' : ''}). ` +
      `Factor actual: <b>${cfg.corr}</b>. ${sf.factor > 1 ? 'La app estaba marcando menos consumo del real.' : 'La app estaba marcando más consumo del real.'}`;
    $('btnApplyFactor').hidden = Math.abs(sf.factor - cfg.corr) < 0.005;
    $('btnApplyFactor').textContent = `Aplicar factor ${sf.factor.toFixed(3)}`;
    $('btnApplyFactor').dataset.f = sf.factor;
  } else {
    $('factorInfo').textContent = `Factor actual: ${cfg.corr}. Se calculará con tu primera carga completa confiable (50 km o más).`;
    $('btnApplyFactor').hidden = true;
  }

  const tb = $('fillRows');
  tb.innerHTML = tank.history.length ? '' : '<tr><td colspan="6">Sin cargas completas todavía.</td></tr>';
  for (const h of tank.history) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${fmtDate(h.date)}</td><td>${h.km}${h.odoKm ? '' : '*'}</td><td>${h.liters}</td>` +
      `<td><b>${h.realKmL ?? '—'}</b></td><td>${h.appKmL ?? '—'}</td><td>${h.factor ?? '—'}${h.warnings.length ? ' ⚠' : ''}</td>`;
    tb.appendChild(tr);
  }
}

function showFillResult(r) {
  const box = $('fillResult');
  if (r.type === 'start') {
    box.innerHTML = '<div class="result"><big>¡Listo!</big><p>Empecé a medir. Maneja normal con la app conectada y registra la próxima carga hasta el corte.</p></div>';
    return;
  }
  if (r.type === 'partial') {
    box.innerHTML = r.ignored
      ? '<div class="result warn"><p>Carga parcial ignorada: todavía no hay una carga hasta el corte para empezar a medir.</p></div>'
      : `<div class="result"><p>Carga parcial anotada: ${r.liters} L. Se sumarán a la próxima carga completa (pendiente: ${r.pendingL.toFixed(2)} L).</p></div>`;
    return;
  }
  const warn = r.warnings.map((w) => `<p>⚠ ${WARN_TEXT[w]}</p>`).join('');
  const diff = r.factor ? Math.round((r.factor - 1) * 100) : null;
  box.innerHTML = `<div class="result${r.warnings.length ? ' warn' : ''}">
    <p>Consumo real del ${V.short}</p>
    <big>${r.realKmL ?? '—'} km/L</big>
    <p>${r.km} km${r.odoKm ? ' (odómetro)' : ' (medidos por la app)'} con ${r.liters} L.</p>
    ${r.factor ? `<p>La app estimó ${r.rawL} L para ${r.appKm} km (${r.appKmL} km/L): ${diff === 0 ? 'casi exacto' : `${Math.abs(diff)} % ${diff > 0 ? 'menos' : 'más'} de lo real`}. Factor de esta carga: <b>${r.factor}</b>.</p>` : ''}
    ${warn}
  </div>`;
}

$('btnFill').onclick = () => {
  const liters = $('fillL').value;
  const full = $('fillFull').checked;
  if (tank.period && !(Number(liters) > 0)) { toast('Anota los litros que cargaste (los marca la bomba)'); return; }
  const paid = $('fillPaid').value;
  if (Number(paid) > 0 && !(Number(liters) > 0)) { toast('Para sacar el precio por litro anota también los litros'); return; }
  const r = registerFill(tank, { liters, odo: $('fillOdo').value, full });
  const price = pricePerLiter(paid, liters);
  if (price) { tank.price = price; tank.priceDate = new Date().toISOString(); }
  save();
  $('fillL').value = '';
  $('fillPaid').value = '';
  $('fillOdo').value = '';
  $('fillFull').checked = true;
  showFillResult(r);
  renderTankTab();
  log(`Carga registrada: ${r.type}${r.liters ? ` ${r.liters} L` : ''}${r.realKmL ? ` → ${r.realKmL} km/L real, factor ${r.factor}` : ''}`);
};
$('btnUndoFill').onclick = () => {
  if (!confirm('¿Deshacer la última carga registrada?')) return;
  if (undoFill(tank)) { save(); $('fillResult').innerHTML = ''; renderTankTab(); toast('Carga deshecha'); }
};
$('btnApplyFactor').onclick = () => {
  cfg.corr = Number($('btnApplyFactor').dataset.f);
  saveVehicleCfg();
  loadCfgForm();
  renderTankTab();
  toast(`Factor ${cfg.corr} aplicado: desde ahora los km/L se muestran corregidos`);
};

function showVoice() {
  const b = $('btnVoice');
  b.textContent = cfg.voice ? '🔊' : '🔇';
  b.classList.toggle('on', cfg.voice);
  b.setAttribute('aria-label', cfg.voice ? 'Voz activada: tocar para silenciar' : 'Voz silenciada: tocar para activar');
  $('cfgVoice').checked = cfg.voice;
}
$('btnVoice').onclick = () => {
  cfg.voice = !cfg.voice;
  saveVehicleCfg();
  showVoice();
  hush(); // corta de inmediato si estaba hablando
  if (cfg.voice) say('Avisos de voz activados');
  toast(cfg.voice ? 'Avisos por voz activados' : 'Avisos por voz silenciados', 2000);
};

function showLoaded() {
  const b = $('btnLoaded');
  b.classList.toggle('on', cfg.loaded);
  b.textContent = cfg.loaded ? 'Voy cargado ✓' : 'Voy cargado';
}
$('btnLoaded').onclick = () => {
  cfg.loaded = !cfg.loaded;
  saveVehicleCfg();
  showLoaded();
  toast(cfg.loaded ? 'Modo cargado: aviso para bajar de marcha antes en las subidas' : 'Modo normal');
};
showLoaded();
showVoice();

function setGauge() {
  const step = V.gaugeMax > 4000 ? 1000 : 500;
  const ticks = [];
  for (let r = 0; r <= V.gaugeMax; r += step) ticks.push(`<span>${r}</span>`);
  $('rpmTicks').innerHTML = ticks.join('');
  $('vehicleSel').value = V.id;
}

$('vehicleSel').onchange = (e) => {
  if (running) {
    e.target.value = V.id;
    toast('Desconecta antes de cambiar de vehículo');
    return;
  }
  save(true);
  loadVehicle(e.target.value);
  Object.assign(trip, newTrip());
  tripLog.length = 0;
  setGauge();
  loadCfgForm();
  showLoaded();
  renderZoneTab();
  renderTankTab();
  $('fillResult').innerHTML = '';
  toast(`Vehículo: ${V.name}`);
};

$('btnTripReset').onclick = () => { Object.assign(trip, newTrip()); tripLog.length = 0; };

// ---------- ajustes ----------
function loadCfgForm() {
  const gas = V.fuel !== 'diesel';
  $('engineWrap').hidden = !gas;
  $('veWrap').hidden = !gas;
  $('dfcoWrap').hidden = !gas;
  $('cfgVehicleInfo').textContent = `${V.name} · ${gas ? 'gasolina' : 'diésel'} · ${V.nGears} marchas` +
    (V.gpsSpeed ? ' · velocidad por GPS' : '');
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
  if (!cfg.voice) hush();
  setTimeout(showVoice);
  cfg.dfco = $('cfgDfco').checked;
  cfg.ve = Number($('cfgVe').value) || DEFAULT_ENGINE.ve;
  cfg.corr = Number($('cfgCorr').value) || 1;
  const ratios = $('cfgRatios').value.split(/[,;\s]+/).map(Number).filter((x) => x > 1 && x < 80);
  cfg.gearRatios = ratios.length ? ratios : null;
  gears.preset = cfg.gearRatios ? [...cfg.gearRatios].sort((a, b) => a - b) : null;
  gears._recompute();
  saveVehicleCfg();
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

// ---------- gastos (costo por tramo) ----------
const money = (v) => (v == null ? '$ --' : '$' + Math.round(v).toLocaleString('es-CL'));
const fmtTime = (ms) => new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Tramos guardados antes de anotar un precio usan el precio actual.
const legPrice = (l) => l.price ?? tank.price;

function renderCostTab() {
  $('costPrice').innerHTML = tank.price
    ? `Bencina a <b>${money(tank.price)}</b> el litro${tank.priceDate ? ` (carga del ${fmtDate(tank.priceDate)})` : ''}.`
    : 'Todavía no sé el precio de la bencina. Al cargar, anota en la pestaña <b>Tanque</b> cuánto pagaste.';
  const c = legs.cur;
  $('costNow').innerHTML = c
    ? `<b>Tramo en curso</b> desde las ${fmtTime(c.start)}: ${c.km.toFixed(1)} km, ${c.l.toFixed(2)} L → <b>${money(legCost(c.l, tank.price))}</b>`
    : 'Sin tramo en curso.';
  const box = $('legDays');
  const days = legsByDay(legs.list);
  if (!days.length) { box.innerHTML = '<p class="hint">Todavía no hay tramos. Se guardan solos cada vez que apagas el motor en una parada.</p>'; return; }
  box.innerHTML = days.map((d) => {
    const cost = tank.price || d.legs.some((l) => l.price) ? d.legs.reduce((s, l) => s + (legCost(l.l, legPrice(l)) ?? 0), 0) : null;
    const rows = d.legs.map((l, i) => {
      const from = d.legs[i + 1]?.to; // el tramo anterior del mismo día terminó donde empieza este
      const where = from || l.to ? `${esc(from || '…')} → ${esc(l.to || '…')}` : '';
      return `<tr data-i="${legs.list.indexOf(l)}"><td>${fmtTime(l.start)}–${fmtTime(l.end)}${where ? `<br><small>${where}</small>` : ''}</td>` +
        `<td>${l.km.toFixed(1)} km</td><td>${l.l.toFixed(2)} L</td><td><b>${money(legCost(l.l, legPrice(l)))}</b></td></tr>`;
    }).join('');
    return `<h3>${fmtDate(d.date)}: ${d.km.toFixed(1)} km · ${money(cost)}</h3>` +
      `<table class="gtable legs"><thead><tr><th>Hora</th><th>km</th><th>Litros</th><th>Costo</th></tr></thead><tbody>${rows}</tbody></table>`;
  }).join('');
}

$('legDays').onclick = (e) => {
  const tr = e.target.closest('tr[data-i]');
  if (!tr) return;
  const leg = legs.list[Number(tr.dataset.i)];
  const name = prompt('¿A dónde llegaste en este tramo? (ej. Almacén Don Juan)', leg.to || '');
  if (name == null) return;
  leg.to = name.trim().slice(0, 40);
  save();
  renderCostTab();
};

// ---------- pestañas ----------
document.querySelectorAll('.tabs button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'zone') renderZoneTab();
    if (b.dataset.tab === 'tank') renderTankTab();
    if (b.dataset.tab === 'cost') renderCostTab();
  };
});

$('btnConnect').onclick = () => start('ble');
$('btnDemo').onclick = () => start('sim');

$('dVersion').textContent = APP_VERSION + (NATIVE ? ' (app Android)' : ' (navegador)');
if (nat) {
  nat.checkApkUpdate(APP_VERSION).then((u) => {
    if (!u) return;
    const box = $('apkUpdate');
    box.innerHTML = `Hay una versión nueva de la app (<b>${u.version}</b>). <a href="${u.url}" target="_blank" rel="noopener">Descargar APK</a>`;
    box.hidden = false;
    toast(`Hay una versión nueva de la app (${u.version}): está en Ajustes`, 6000);
  });
}
loadCfgForm();
setGauge();
renderZoneTab();
renderTankTab();
if (!BleTransport.available()) log('Web Bluetooth no disponible en este navegador. Usa Chrome en Android.');

if (!NATIVE && 'serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').then((reg) => reg.update()).catch(() => {});
  // Si llega una versión nueva, recargar (solo si no está conectado, para no cortar un viaje).
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    if (running) { toast('Hay una versión nueva: se aplicará al desconectar'); pendingReload = true; return; }
    reloaded = true;
    location.reload();
  });
}

// Para pruebas automáticas
window.__obd = { live, trip, stats: () => stats, gears: () => gears, sim: () => transport };

// Cualquier error inesperado se muestra en pantalla y en el registro (antes podía dejar
// botones sin responder sin ningún aviso).
window.addEventListener('error', (e) => {
  log('ERROR inesperado: ' + e.message);
  toast('Error en la app: ' + e.message + '. Cierra y vuelve a abrir la app.', 10000);
});
window.addEventListener('unhandledrejection', (e) => {
  log('ERROR inesperado: ' + (e.reason?.message || e.reason));
});
