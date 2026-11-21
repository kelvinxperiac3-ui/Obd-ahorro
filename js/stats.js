// Acumula rendimiento real por rango de RPM (y por marcha) para encontrar la zona verde.

export const BUCKET = 250; // rpm por rango
export const MIN_BUCKET_SECONDS = 30; // datos mínimos para confiar en un rango
export const DEFAULT_ZONE = { min: 1500, max: 2500, learned: false };

export class RpmStats {
  constructor(saved = null) {
    this.b = saved?.b || {}; // clave "g:rpm" → {t, km, l}
  }

  static bucketOf(rpm) { return Math.floor(rpm / BUCKET) * BUCKET; }

  add({ rpm, speed, lph, gear, dt }) {
    if (rpm == null || speed == null || lph == null || speed < 5 || dt <= 0 || dt > 5) return;
    const km = (speed * dt) / 3600;
    const l = (lph * dt) / 3600;
    const rb = RpmStats.bucketOf(rpm);
    for (const g of [0, gear || null]) { // 0 = todas las marchas juntas
      if (g == null) continue;
      const k = `${g}:${rb}`;
      const e = (this.b[k] ||= { t: 0, km: 0, l: 0 });
      e.t += dt; e.km += km; e.l += l;
    }
  }

  /** Lista de rangos para una marcha (0 = todas), ordenada por rpm. */
  rows(gear = 0) {
    return Object.entries(this.b)
      .filter(([k]) => k.startsWith(`${gear}:`))
      .map(([k, e]) => ({ rpm: Number(k.split(':')[1]), ...e, kmL: e.l > 0 ? e.km / e.l : null }))
      .sort((a, b) => a.rpm - b.rpm);
  }

  /**
   * Zona verde: rangos contiguos alrededor del mejor km/L con >= 90 % del mejor.
   * Si hay pocos datos, devuelve la zona por defecto.
   */
  zone(gear = 0, tolerance = 0.9) {
    const rows = this.rows(gear).filter((r) => r.t >= MIN_BUCKET_SECONDS && r.kmL);
    if (rows.length < 3) return { ...DEFAULT_ZONE };
    const best = rows.reduce((a, b) => (b.kmL > a.kmL ? b : a));
    const ok = new Set(rows.filter((r) => r.kmL >= best.kmL * tolerance).map((r) => r.rpm));
    let min = best.rpm; let max = best.rpm;
    while (ok.has(min - BUCKET)) min -= BUCKET;
    while (ok.has(max + BUCKET)) max += BUCKET;
    return { min, max: max + BUCKET, best: best.kmL, bestRpm: best.rpm, learned: true };
  }

  totalSeconds() {
    return Object.entries(this.b).filter(([k]) => k.startsWith('0:')).reduce((s, [, e]) => s + e.t, 0);
  }

  toJSON() { return { b: this.b }; }
}
