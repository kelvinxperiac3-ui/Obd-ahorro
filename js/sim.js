// Simulador: se comporta como un ELM327 conectado a una camioneta 1.2 manual de 5 marchas.
// Sirve para probar la app sin estar en el vehículo.

const RATIOS = [7.2, 12.8, 19.5, 26.5, 33.0]; // km/h por 1000 rpm en cada marcha
const PROFILE = [ // [segundos, velocidad objetivo km/h]
  [0, 0], [4, 0], [20, 45], [40, 50], [55, 80], [85, 85], [100, 35], [120, 40], [132, 0], [138, 0],
];

export class SimTransport {
  constructor() {
    this.onData = null;
    this.onDisconnect = null;
    this.name = 'Simulador';
    this.t = 0;
    this.v = 0; // km/h
    this.gear = 1;
    this.rpm = 800;
    this.maf = 2.5;
    this.thr = 12;
    this.load = 20;
    this.shiftAt = 2500;
    this.last = performance.now();
  }

  async connect() {}
  async disconnect() { this.onDisconnect?.(); }

  target(t) {
    const T = PROFILE[PROFILE.length - 1][0];
    const x = t % T;
    for (let i = 1; i < PROFILE.length; i++) {
      const [t1, v1] = PROFILE[i];
      const [t0, v0] = PROFILE[i - 1];
      if (x <= t1) return v0 + ((v1 - v0) * (x - t0)) / (t1 - t0 || 1);
    }
    return 0;
  }

  step() {
    const now = performance.now();
    const dt = Math.min(1, (now - this.last) / 1000) * (this.speedUp || 1);
    this.last = now;
    if (dt <= 0) return;
    const prevT = this.t;
    this.t += dt;
    if (Math.floor(prevT / 138) !== Math.floor(this.t / 138)) this.shiftAt = 1900 + Math.random() * 1800;

    const tv = this.target(this.t);
    const a = Math.max(-2.5, Math.min(1.6, (tv - this.v) / 3.6 / 1.5)); // m/s²
    this.v = Math.max(0, this.v + a * 3.6 * dt);

    // cambios de marcha del "conductor"
    let rpm = (this.v * 1000) / RATIOS[this.gear - 1];
    if (rpm > this.shiftAt && this.gear < 5) this.gear++;
    else if (rpm < 1100 && this.gear > 1) this.gear--;
    rpm = (this.v * 1000) / RATIOS[this.gear - 1];
    const clutch = rpm < 850;
    this.rpm = clutch ? 800 + Math.min(700, a * 400) * (this.v > 0 ? 1 : 0) : rpm;

    // potencia necesaria
    const ms = this.v / 3.6;
    const m = 1350;
    const P = (0.5 * 1.2 * 0.95 * ms ** 3 + m * 9.81 * 0.013 * ms + m * a * ms) / 1000; // kW
    const Pmax = Math.max(8, 70 * Math.min(1, this.rpm / 5500));
    const frac = Math.max(0, Math.min(1, P / Pmax));
    let fuelGs;
    if (P < 0 && this.rpm > 1200 && !clutch) {
      fuelGs = 0; // corte de inyección
      this.thr = 11;
    } else {
      const r = (this.rpm - 1900) / 1000;
      const bsfc = 255 * (1 + 0.18 * r * r + 0.9 * (1 - frac) ** 2); // g/kWh
      const friction = (this.rpm / 1000) * 0.9; // kW de pérdidas
      fuelGs = (Math.max(0, P) + friction) * bsfc / 3600;
      this.thr = 11 + frac * 80;
    }
    this.load = Math.min(100, 18 + frac * 85);
    this.maf = Math.max(0.6, fuelGs * 14.7);
  }

  async write(str) {
    const cmd = str.trim().toUpperCase();
    this.step();
    const reply = this.answer(cmd);
    setTimeout(() => this.onData?.(reply + '\r\r>'), 25);
  }

  answer(cmd) {
    const hex = (n, w = 2) => Math.round(Math.max(0, n)).toString(16).toUpperCase().padStart(w, '0');
    if (cmd === 'ATZ') return '\r\rELM327 v1.5 (simulador)';
    if (cmd === 'ATDPN') return 'A6';
    if (cmd.startsWith('AT')) return 'OK';
    switch (cmd) {
      case '0100': return '4100BE3FB813';
      case '0120': return '412080018001';
      case '0140': return '4140FED00400';
      case '010C': return '410C' + hex(this.rpm * 4, 4);
      case '010D': return '410D' + hex(this.v);
      case '0110': return '4110' + hex(this.maf * 100, 4);
      case '0104': return '4104' + hex((this.load * 255) / 100);
      case '0111': return '4111' + hex((this.thr * 255) / 100);
      case '010F': return '410F' + hex(32 + 40);
      case '010B': return '410B' + hex(35 + this.load * 0.6);
      case '0105': return '4105' + hex(88 + 40);
      default: return 'NO DATA';
    }
  }
}
