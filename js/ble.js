// Transporte Bluetooth LE (Web Bluetooth) para adaptadores ELM327 BLE.
// Los adaptadores chinos usan distintos servicios GATT; probamos los conocidos
// y elegimos una característica de notificación y otra de escritura.

const KNOWN_SERVICES = [
  0xfff0, // muy común (KONNWEI, Vgate BLE genéricos)
  0xffe0, // HM-10 y clones
  0x18f0, // algunos ELM327 BLE
  0xfee0,
  0xae30,
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // Vgate iCar Pro
  '0000ffe5-0000-1000-8000-00805f9b34fb',
];

export class BleTransport {
  constructor() {
    this.onData = null;
    this.onDisconnect = null;
    this.name = '';
    this.decoder = new TextDecoder();
    this.encoder = new TextEncoder();
  }

  static available() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  async connect(log = () => {}) {
    this.device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: KNOWN_SERVICES,
    });
    this.name = this.device.name || 'Adaptador BLE';
    this.device.addEventListener('gattserverdisconnected', () => this.onDisconnect?.());
    await this._setup(log);
  }

  get connected() { return !!this.device?.gatt?.connected; }

  /** Vuelve a conectar al mismo adaptador, sin mostrar la lista de dispositivos. */
  async reconnect(log = () => {}) {
    if (!this.device) throw new Error('No hay adaptador elegido');
    await this._setup(log, true);
  }

  async _setup(log, quiet = false) {
    if (!quiet) log(`Conectando a ${this.name}…`);
    const server = await this.device.gatt.connect();
    const services = await server.getPrimaryServices();
    if (!services.length) throw new Error('El adaptador no expone servicios conocidos. ¿Es Bluetooth clásico?');

    let pick = null;
    let anyNotify = null;
    let anyWrite = null;
    for (const s of services) {
      const chars = await s.getCharacteristics();
      let n = null;
      let w = null;
      for (const c of chars) {
        const p = c.properties;
        if (!quiet) log(`  servicio ${short(s.uuid)} car. ${short(c.uuid)} ${p.notify ? 'N' : ''}${p.indicate ? 'I' : ''}${p.write ? 'W' : ''}${p.writeWithoutResponse ? 'w' : ''}`);
        if (!n && (p.notify || p.indicate)) n = c;
        if (!w && (p.write || p.writeWithoutResponse)) w = c;
      }
      anyNotify ||= n;
      anyWrite ||= w;
      if (n && w && !pick) pick = { n, w };
    }
    pick ||= anyNotify && anyWrite ? { n: anyNotify, w: anyWrite } : null;
    if (!pick) throw new Error('No encontré características de lectura/escritura en el adaptador.');

    this.notifyChar = pick.n;
    this.writeChar = pick.w;
    this.notifyChar.addEventListener('characteristicvaluechanged', (e) => {
      this.onData?.(this.decoder.decode(e.target.value));
    });
    await this.notifyChar.startNotifications();
    log(`Usando notificación ${short(pick.n.uuid)} y escritura ${short(pick.w.uuid)}`);
  }

  async write(str) {
    const bytes = this.encoder.encode(str);
    const noResp = this.writeChar.properties.writeWithoutResponse;
    for (let i = 0; i < bytes.length; i += 20) {
      const chunk = bytes.slice(i, i + 20);
      if (noResp && this.writeChar.writeValueWithoutResponse) await this.writeChar.writeValueWithoutResponse(chunk);
      else if (this.writeChar.writeValueWithResponse) await this.writeChar.writeValueWithResponse(chunk);
      else await this.writeChar.writeValue(chunk);
    }
  }

  async disconnect() {
    try { this.device?.gatt?.disconnect(); } catch { /* nada */ }
  }
}

function short(uuid) {
  const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.exec(uuid);
  return m ? m[1].toUpperCase() : uuid.slice(0, 8);
}
