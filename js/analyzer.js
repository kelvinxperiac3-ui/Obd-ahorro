// Procesa cada muestra (en vivo o importada): marcha, si va a velocidad pareja,
// y acumula estadísticas solo cuando el dato es comparable.

import { GearLearner } from './gears.js';
import { RpmStats } from './stats.js';

export const STEADY_ACCEL = 0.25; // m/s²: por debajo se considera velocidad pareja

export class Analyzer {
  constructor(gears, stats) {
    this.gears = gears || new GearLearner();
    this.stats = stats || new RpmStats();
    this.hist = []; // [t, speed] de los últimos segundos
    this.lastT = null;
  }

  /** Aceleración (m/s²) comparando con la velocidad de hace ~2 s. */
  accel(t, speed) {
    this.hist.push([t, speed]);
    while (this.hist.length > 2 && t - this.hist[1][0] >= 2) this.hist.shift();
    const [t0, v0] = this.hist[0];
    if (t - t0 < 0.8 || t - t0 > 6) return null;
    return (speed - v0) / 3.6 / (t - t0);
  }

  /**
   * s: { t (segundos), rpm, speed, lph, fuelCut }
   * Devuelve { gear, accel, steady, dt }
   */
  feed(s) {
    const dt = this.lastT == null ? 0 : s.t - this.lastT;
    this.lastT = s.t;
    if (dt > 10) this.hist = [];
    if (s.speed != null && s.rpm != null) this.gears.add(s.speed, s.rpm);
    let gear = this.gears.gearFor(s.speed, s.rpm);
    // Con lectura rápida, la velocidad se lee una vuelta por medio: al acelerar o frenar la
    // relación velocidad/RPM queda unas décimas desfasada. Si no calza con ninguna marcha pero
    // sigue cerca (±15 %) de la que llevaba hace menos de 2 s, se mantiene esa marcha.
    if (gear) {
      this.lastGear = gear;
      this.lastGearT = s.t;
    } else if (this.lastGear && s.t - this.lastGearT < 2 && s.speed > 4 && s.rpm > 1000) {
      const r = this.gears.ratioOf(this.lastGear);
      if (r && Math.abs(Math.log((s.speed * 1000) / s.rpm / r)) < 0.15) gear = this.lastGear;
    }
    const a = s.speed != null ? this.accel(s.t, s.speed) : null;
    const steady = a != null && Math.abs(a) < STEADY_ACCEL;
    // Para la zona solo cuentan momentos con el motor empujando, en una marcha conocida
    // y a velocidad pareja (acelerar o frenar distorsiona el km/L).
    if (!s.fuelCut && !s.skip && gear && steady && s.lph != null && s.lph > 0) {
      this.stats.add({ rpm: s.rpm, speed: s.speed, lph: s.lph, gear, dt });
    }
    return { gear, accel: a, steady, dt };
  }
}
