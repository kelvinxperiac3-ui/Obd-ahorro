// Puente con Android (solo se carga dentro de la app instalada, no en el navegador).
// - Bluetooth LE nativo (el navegador interno de Android no tiene Web Bluetooth)
// - Voz nativa (el navegador interno no tiene speechSynthesis)
// - GPS nativo y servicio en primer plano para seguir funcionando con la pantalla apagada

import { registerPlugin, Capacitor } from './vendor/capacitor-core.js';

const Ble = registerPlugin('BluetoothLe');
const Tts = registerPlugin('TextToSpeech');
const Geo = registerPlugin('Geolocation');
const KeepAlive = registerPlugin('KeepAlive');

export const isNative = () => Capacitor.isNativePlatform();

const enc = new TextEncoder();
const dec = new TextDecoder();
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
function fromHex(hex = '') {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

const shortUuid = (u) => {
  const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.exec(u);
  return m ? m[1].toUpperCase() : u.slice(0, 8);
};

export class NativeBleTransport {
  constructor() {
    this.onData = null;
    this.onDisconnect = null;
    this.name = '';
    this._connected = false;
  }

  static available() { return isNative(); }

  async connect(log = () => {}) {
    await Ble.initialize({ androidNeverForLocation: true });
    const enabled = await Ble.isEnabled().catch(() => ({ value: true }));
    if (!enabled.value) {
      try { await Ble.requestEnable(); } catch { throw new Error('Bluetooth is off'); }
    }
    const d = await Ble.requestDevice({});
    this.deviceId = d.deviceId;
    this.name = d.name || 'Adaptador BLE';
    await this._setup(log);
  }

  get connected() { return this._connected; }

  async reconnect(log = () => {}) {
    if (!this.deviceId) throw new Error('No hay adaptador elegido');
    await this._setup(log, true);
  }

  async _setup(log, quiet = false) {
    const id = this.deviceId;
    await this.discL?.remove();
    this.discL = await Ble.addListener(`disconnected|${id}`, () => {
      this._connected = false;
      this.onDisconnect?.();
    });
    if (!quiet) log(`Conectando a ${this.name}…`);
    for (let i = 1; ; i++) {
      try {
        await Ble.connect({ deviceId: id, timeout: 10000 });
        break;
      } catch (e) {
        log(`  intento ${i} de conexión falló: ${e.message}`);
        if (i >= 3) throw e;
        try { await Ble.disconnect({ deviceId: id }); } catch { /* nada */ }
        await new Promise((r) => setTimeout(r, 800 * i));
      }
    }
    this._connected = true;
    // Prioridad alta: menos espera entre paquetes Bluetooth (respuestas más rápidas).
    try { await Ble.requestConnectionPriority({ deviceId: id, connectionPriority: 1 }); } catch { /* opcional */ }

    const { services } = await Ble.getServices({ deviceId: id });
    let pick = null;
    let anyN = null;
    let anyW = null;
    for (const s of services) {
      let n = null;
      let w = null;
      for (const c of s.characteristics) {
        const p = c.properties || {};
        if (!quiet) log(`  servicio ${shortUuid(s.uuid)} car. ${shortUuid(c.uuid)} ${p.notify ? 'N' : ''}${p.indicate ? 'I' : ''}${p.write ? 'W' : ''}${p.writeWithoutResponse ? 'w' : ''}`);
        if (!n && (p.notify || p.indicate)) n = c;
        if (!w && (p.write || p.writeWithoutResponse)) w = c;
      }
      anyN ||= n && { s, c: n };
      anyW ||= w && { s, c: w };
      if (n && w && !pick) pick = { n: { s, c: n }, w: { s, c: w } };
    }
    pick ||= anyN && anyW ? { n: anyN, w: anyW } : null;
    if (!pick) throw new Error('No encontré características de lectura/escritura en el adaptador.');
    this.notify = { service: pick.n.s.uuid, characteristic: pick.n.c.uuid };
    this.writeTo = { service: pick.w.s.uuid, characteristic: pick.w.c.uuid };
    this.noResp = !!pick.w.c.properties?.writeWithoutResponse;

    await this.notL?.remove();
    this.notL = await Ble.addListener(
      `notification|${id}|${this.notify.service}|${this.notify.characteristic}`,
      (e) => this.onData?.(dec.decode(fromHex(e?.value))),
    );
    await Ble.startNotifications({ deviceId: id, ...this.notify });
    log(`Usando notificación ${shortUuid(this.notify.characteristic)} y escritura ${shortUuid(this.writeTo.characteristic)}`);
  }

  async write(str) {
    const bytes = enc.encode(str);
    for (let i = 0; i < bytes.length; i += 20) {
      const value = toHex(bytes.slice(i, i + 20));
      const args = { deviceId: this.deviceId, ...this.writeTo, value };
      if (this.noResp) await Ble.writeWithoutResponse(args);
      else await Ble.write(args);
    }
  }

  async disconnect() {
    this._connected = false;
    try { await Ble.disconnect({ deviceId: this.deviceId }); } catch { /* nada */ }
  }
}

// ---------- voz ----------
export async function speak(text) {
  try {
    await Tts.stop();
    await Tts.speak({ text, lang: 'es-ES', rate: 1.0, pitch: 1.0, volume: 1.0, category: 'playback' });
  } catch { /* sin motor de voz */ }
}
export async function stopSpeaking() {
  try { await Tts.stop(); } catch { /* nada */ }
}

// ---------- GPS ----------
export async function watchGps(onSpeedKmh, onError) {
  try {
    const perm = await Geo.checkPermissions();
    if (perm.location !== 'granted') await Geo.requestPermissions({ permissions: ['location'] });
  } catch { /* se pedirá al iniciar */ }
  return Geo.watchPosition({ enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }, (pos, err) => {
    if (err) { onError?.(err); return; }
    if (pos?.coords?.speed != null) onSpeedKmh(pos.coords.speed * 3.6);
  });
}
export async function clearGps(id) {
  if (id) { try { await Geo.clearWatch({ id }); } catch { /* nada */ } }
}

// ---------- segundo plano ----------
// Servicio en primer plano con notificación fija: Android no pausa la app ni corta el
// Bluetooth con la pantalla apagada o usando otra app (Waze, Maps…).
export const background = {
  async start(text) {
    try { await KeepAlive.start({ title: 'OBD Ahorro activo', text }); return true; } catch { return false; }
  },
  async update(text) {
    try { await KeepAlive.update({ title: 'OBD Ahorro activo', text }); } catch { /* nada */ }
  },
  async stop() {
    try { await KeepAlive.stop(); } catch { /* nada */ }
  },
  async keepScreenOn(on) {
    try { await KeepAlive.keepScreenOn({ on }); } catch { /* nada */ }
  },
};

// ---------- actualizaciones del APK ----------
const RELEASES = 'https://api.github.com/repos/kelvinxperiac3-ui/Obd-ahorro/releases/latest';
export async function checkApkUpdate(current) {
  try {
    const r = await fetch(RELEASES, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) return null;
    const rel = await r.json();
    const asset = rel.assets?.find((a) => a.name.endsWith('.apk'));
    const latest = (rel.name || rel.tag_name || '').replace(/^.*?(\d{4}-\d{2}-\d{2}\w*).*$/, '$1');
    if (!asset || !latest || latest <= current) return null;
    return { version: latest, url: asset.browser_download_url, page: rel.html_url };
  } catch {
    return null;
  }
}

// ---------- compartir archivos (exportar CSV/JSON) ----------
// El navegador interno de Android no descarga archivos: se guardan y se abre "Compartir"
// (WhatsApp, Drive, correo…).
const Fs = registerPlugin('Filesystem');
const Share = registerPlugin('Share');
export async function shareFile(name, text) {
  const { uri } = await Fs.writeFile({ path: name, data: text, directory: 'CACHE', encoding: 'utf8' });
  await Share.share({ title: name, files: [uri], dialogTitle: 'Guardar o enviar' });
}
