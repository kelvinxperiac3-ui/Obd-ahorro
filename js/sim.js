// Simulador: se comporta como un ELM327 conectado al vehículo elegido.
// - MD201: gasolina 1.2, sin MAF (informa MAP), 5 marchas.
// - Homan: diésel 2.8 turbo, informa consumo (015E) y pedal (0149), velocidad OBD = 0
//   (como el camión real), 6 marchas. Entrega velocidad "GPS" simulada.
// Sirve para probar la app sin estar en el vehículo.

import { mafFromMap } from './fuel.js';
import { VEHICLES } from './vehicles.js';

const PROFILE = [ // [segundos, fracción de la velocidad máxima del recorrido]
  [0, 0], [4, 0], [20, 0.53], [40, 0.59], [55, 0.94], [85, 1], [100, 0.41], [120, 0.47], [132, 0], [138, 0],
];
const T = 138;

const MODELS = {
  md201: {
    ratios: VEHICLES.md201.gearRatios,
    vmax: 85, m: 1650, cda: 0.95, crr: 0.013, idle: 800, cut: 1200,
    torque: (rpm) => Math.max(70, 119 * (1 - ((rpm - 4800) / 4500) ** 2)), // N·m
    shift: [1900, 3700], downFull: 2200,
    bsfc: (rpm, frac) => 255 * (1 + 0.18 * ((rpm - 1900) / 1000) ** 2 + 0.9 * (1 - frac) ** 2),
    friction: (rpm) => (rpm / 1000) * 0.9,
    density: 740,
    pids: ['01', '03', '04', '05', '06', '07', '0B', '0C', '0D', '0E', '0F', '11', '13', '14', '15', '20', '21', '31', '40', '41', '42', '43', '44', '45', '46', '47', '49', '4C', '56'],
  },
  homan: {
    ratios: VEHICLES.homan.gearRatios, // caja WLY6T40
    vmax: 82, m: 5500, cda: 3.6, crr: 0.008, idle: 750, cut: 1000,
    torque: (rpm) => (rpm < 1800 ? 190 + (95 * (rpm - 900)) / 900 : rpm <= 2200 ? 285 : Math.max(200, 285 - ((rpm - 2200) / 1600) * 72)), // JE493ZLQ5
    shift: [1800, 2400], downFull: 1450,
    bsfc: (rpm, frac) => 212 * (1 + 0.12 * ((rpm - 1600) / 1000) ** 2 + 0.7 * (1 - frac) ** 2),
    friction: (rpm) => (rpm / 1000) * 1.8,
    density: 835,
    pids: ['01', '04', '05', '0B', '0C', '0D', '0F', '20', '21', '31', '33', '40', '42', '46', '49', '4A', '5E'],
  },
};

function mask(base, pids) {
  const b = parseInt(base, 16);
  const bytes = [0, 0, 0, 0];
  for (const p of pids) {
    const n = parseInt(p, 16) - b - 1;
    if (n >= 0 && n < 32) bytes[n >> 3] |= 0x80 >> (n & 7);
  }
  return '41' + base + bytes.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join('');
}

export class SimTransport {
  constructor(vehicleId = 'md201') {
    this.vid = MODELS[vehicleId] ? vehicleId : 'md201';
    this.kline = this.vid === 'md201'; // la MD201 real usa K-Line (protocolo A4)
    this.M = MODELS[this.vid];
    this.onData = null;
    this.onDisconnect = null;
    this.name = `Simulador (${VEHICLES[this.vid].short})`;
    this.t = 0;
    this.v = 0; // km/h
    this.gear = 1;
    this.rpm = this.M.idle;
    this.maf = 2.5;
    this.fuelLph = 1;
    this.thr = 6.7;
    this.pedal = 0;
    this.load = 20;
    this.shiftAt = (this.M.shift[0] + this.M.shift[1]) / 2;
    this.last = performance.now();
  }

  async connect() {}
  async disconnect() { this.closed = true; }
  get connected() { return !this.closed; }
  /** Para probar la reconexión automática. */
  async reconnect() { this.closed = false; this.last = performance.now(); }

  /** Velocidad "GPS" simulada (km/h), para vehículos que no la informan por OBD. */
  gpsSpeed() { return this.v; }

  target(t) {
    const x = t % T;
    for (let i = 1; i < PROFILE.length; i++) {
      const [t1, v1] = PROFILE[i];
      const [t0, v0] = PROFILE[i - 1];
      if (x <= t1) return this.M.vmax * (v0 + ((v1 - v0) * (x - t0)) / (t1 - t0 || 1));
    }
    return 0;
  }

  step() {
    const M = this.M;
    const now = performance.now();
    const dt = Math.min(1, (now - this.last) / 1000) * (this.speedUp || 1);
    this.last = now;
    if (dt <= 0) return;
    const prevT = this.t;
    this.t += dt;
    if (Math.floor(prevT / T) !== Math.floor(this.t / T)) this.shiftAt = M.shift[0] + Math.random() * (M.shift[1] - M.shift[0]);

    const x = this.t % T;
    const grade = x > 50 && x < 95 ? 0.06 : 0; // cuesta en la parte de carretera
    const ms0 = Math.max(0.5, this.v / 3.6);
    const resist = 0.5 * 1.2 * M.cda * ms0 ** 2 + M.m * 9.81 * (M.crr + grade); // N

    const rpm0 = Math.max(900, this.rpm);
    const Pmax = (M.torque(rpm0) * rpm0) / 9549; // kW

    const tv = this.target(this.t);
    let a = Math.max(-2.5, Math.min(1.4, (tv - this.v) / 3.6 / 1.5)); // m/s² deseada
    const aMax = (Pmax * 900 / ms0 - resist) / M.m; // 90 % de eficiencia de transmisión
    if (this.gear > 1 || this.v > 10) a = Math.min(a, aMax);
    this.v = Math.max(0, this.v + a * 3.6 * dt);

    // cambios de marcha del "conductor" (algo perezoso en las subidas)
    const R = M.ratios;
    let rpm = (this.v * 1000) / R[this.gear - 1];
    const fullPower = a >= aMax - 0.01 && tv > this.v + 1;
    if (rpm > this.shiftAt && this.gear < R.length && !fullPower) this.gear++;
    else if ((rpm < M.idle + 300 || (fullPower && rpm < M.downFull)) && this.gear > 1) this.gear--;
    rpm = (this.v * 1000) / R[this.gear - 1];
    const clutch = rpm < M.idle + 50;
    this.rpm = clutch ? M.idle + Math.min(700, Math.max(0, a) * 400) * (this.v > 0 ? 1 : 0) : rpm;

    const ms = this.v / 3.6;
    const P = (resist * ms + M.m * a * ms) / 900; // kW en el motor
    const frac = Math.max(0, Math.min(1, P / ((M.torque(Math.max(900, this.rpm)) * Math.max(900, this.rpm)) / 9549)));
    let fuelGs;
    if (P < 0 && this.rpm > M.cut && !clutch) {
      fuelGs = 0; // corte de inyección
      this.cut = true;
      this.pedal = 0;
    } else {
      this.cut = false;
      fuelGs = ((Math.max(0, P) + M.friction(this.rpm)) * M.bsfc(this.rpm, frac)) / 3600;
      this.pedal = frac * 100;
    }
    this.thr = 6.7 + this.pedal * 0.75; // MD201: ~6.7 % suelto, ~82 % a fondo
    this.load = Math.min(100, 18 + frac * 85);
    this.maf = Math.max(0.6, fuelGs * 14.7);
    this.fuelLph = (fuelGs * 3600) / M.density;
  }

  async write(str) {
    const cmd = str.trim().toUpperCase();
    this.step();
    // Atajo "1" al final: el ELM contesta sin esperar a otras computadoras (más rápido).
    let c = cmd;
    let wait = 25;
    if (c.startsWith('01') && this.kline) wait += this.at2 ? 70 : 110; // K-Line: línea lenta
    if (/^01([0-9A-F]{2})+[1-9]$/.test(c)) c = c.slice(0, -1);
    else if (c.startsWith('01')) wait += this.at2 ? 40 : 90; // espera del ELM por más respuestas
    const reply = this.answer(c);
    setTimeout(() => this.onData?.(reply + '\r\r>'), wait);
  }

  /** Respuesta CAN a varias PIDs, en tramas numeradas como un ELM327 real. */
  multi(pids) {
    if (this.kline) return this.answer('01' + pids[0]); // K-Line: la ECU solo contesta la primera
    let data = '41';
    for (const p of pids) {
      const r = this.answer('01' + p);
      if (r.startsWith('41')) data += r.slice(2);
    }
    if (data.length <= 14) return data; // cabe en una trama
    const bytes = data.length / 2;
    const frames = [bytes.toString(16).toUpperCase().padStart(3, '0')];
    frames.push('0:' + data.slice(0, 12));
    for (let i = 12, n = 1; i < data.length; i += 14, n++) frames.push(`${(n % 16).toString(16).toUpperCase()}:` + data.slice(i, i + 14));
    return frames.join('\r');
  }

  answer(cmd) {
    const hex = (n, w = 2) => Math.round(Math.max(0, n)).toString(16).toUpperCase().padStart(w, '0');
    const diesel = this.vid === 'homan';
    if (cmd === 'ATZ') return '\r\rELM327 v1.5 (simulador)';
    if (cmd === 'ATDPN') return this.kline ? 'A4' : 'A6';
    if (cmd === 'ATAT2') { this.at2 = true; return 'OK'; }
    if (cmd === 'ATAT1') { this.at2 = false; return 'OK'; }
    if (cmd.startsWith('AT')) return 'OK';
    if (/^01(00|20|40)$/.test(cmd)) return mask(cmd.slice(2), this.M.pids);
    if (/^01([0-9A-F]{2}){2,6}$/.test(cmd)) return this.multi(cmd.slice(2).match(/../g));
    const pid = cmd.slice(2);
    if (cmd.startsWith('01') && !this.M.pids.includes(pid)) return 'NO DATA';
    switch (cmd) {
      case '010C': return '410C' + hex(this.rpm * 4, 4);
      case '010D': return '410D' + hex(diesel ? 0 : this.v); // el camión informa 0
      case '0110': return '4110' + hex(this.maf * 100, 4);
      case '0104': return '4104' + hex((this.load * 255) / 100);
      case '0111': return '4111' + hex((this.thr * 255) / 100);
      case '0149': return '4149' + hex(((14.5 + this.pedal * 0.65) * 255) / 100);
      case '015E': return '415E' + hex(this.fuelLph * 20, 4);
      case '010F': return '410F' + hex(32 + 40);
      case '010B': {
        if (diesel) return '410B' + hex(96 + this.load * 1.1); // turbo
        const per = mafFromMap(this.rpm, 1, 32, 1.243, 0.85); // MAP coherente con el aire que entra
        return '410B' + hex(Math.min(101, Math.max(18, this.maf / per)));
      }
      case '0103': return '4103' + (this.cut ? '04' : '02') + '00';
      case '0105': return '4105' + hex(85 + 40);
      default: return 'NO DATA';
    }
  }
}
