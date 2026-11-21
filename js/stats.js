// Acumula rendimiento real por rango de RPM, por marcha y por velocidad.

export const BUCKET = 250; // rpm por rango
export const SPEED_BAND = 10; // km/h por banda
export const MIN_BUCKET_SECONDS = 30; // datos mínimos para confiar en un rango
export const DEFAULT_ZONE = { min: 1500, max: 2500, learned: false };
// En la última marcha, el viaje a Tongoy mostró buen rendimiento hasta ~75 km/h (≈2900 rpm).
export const DEFAULT_TOP_ZONE = { min: 1500, max: 2900, learned: false };

export class RpmStats {
  constructor(saved = null) {
    this.b = saved?.b || {}; // "g:rpm" → {t, km, l}
    this.v = saved?.v || {}; // "banda:g" → {t, km, l}
  }

  static bucketOf(rpm) { return Math.floor(rpm / BUCKET) * BUCKET; }

  add({ rpm, speed, lph, gear, dt }) {
    if (rpm == null || speed == null || lph == null || speed < 5 || dt <= 0 || dt > 5) return;
    const km = (speed * dt) / 3600;
    const l = (lph * dt) / 3600;
    const put = (obj, k) => { const e = (obj[k] ||= { t: 0, km: 0, l: 0 }); e.t += dt; e.km += km; e.l += l; };
    const rb = RpmStats.bucketOf(rpm);
    put(this.b, `0:${rb}`); // 0 = todas las marchas juntas
    if (gear) {
      put(this.b, `${gear}:${rb}`);
      put(this.v, `${Math.floor(speed / SPEED_BAND) * SPEED_BAND}:${gear}`);
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
   *
   * Solo se confía en lo aprendido si los datos permiten comparar de verdad. Si no,
   * devuelve la zona por defecto con `reason`:
   *  - 'pocos':  menos de 4 rangos con datos suficientes
   *  - 'rango':  todo en un rango estrecho (< 1000 rpm), ej. un viaje solo de carretera
   *  - 'parejo': todos los rangos rinden parecido (±10 %): los datos no distinguen
   *  - 'borde':  el mejor está en el rango más alto medido (el óptimo podría estar fuera)
   * La zona aprendida además se limita a ±500/+750 rpm de la zona por defecto.
   */
  zone(gear = 0, tolerance = 0.9, fallback = DEFAULT_ZONE) {
    const rows = this.rows(gear).filter((r) => r.t >= MIN_BUCKET_SECONDS && r.kmL);
    const fb = (reason) => ({ ...fallback, learned: false, reason });
    if (rows.length < 4) return fb('pocos');
    const lo = rows[0].rpm;
    const hi = rows[rows.length - 1].rpm;
    if (hi - lo < 1000) return fb('rango');
    const best = rows.reduce((a, b) => (b.kmL > a.kmL ? b : a));
    const worst = rows.reduce((a, b) => (b.kmL < a.kmL ? b : a));
    if (worst.kmL >= best.kmL * tolerance) return fb('parejo');
    if (best.rpm === hi) return fb('borde');
    const ok = new Set(rows.filter((r) => r.kmL >= best.kmL * tolerance).map((r) => r.rpm));
    let min = best.rpm; let max = best.rpm;
    while (ok.has(min - BUCKET)) min -= BUCKET;
    while (ok.has(max + BUCKET)) max += BUCKET;
    max += BUCKET;
    min = Math.max(min, fallback.min - 500);
    max = Math.min(max, fallback.max + 750);
    if (max - min < BUCKET * 2) return fb('borde');
    return { min, max, best: best.kmL, bestRpm: best.rpm, learned: true };
  }

  /** Por cada banda de velocidad: km/L de cada marcha usada (con datos suficientes). */
  bySpeed(minSeconds = 15) {
    const out = {};
    for (const [k, e] of Object.entries(this.v)) {
      if (e.t < minSeconds || e.l <= 0) continue;
      const [band, g] = k.split(':').map(Number);
      (out[band] ||= []).push({ gear: g, kmL: e.km / e.l, t: e.t });
    }
    return Object.entries(out)
      .map(([band, gears]) => ({ band: Number(band), gears: gears.sort((a, b) => a.gear - b.gear) }))
      .sort((a, b) => a.band - b.band);
  }

  totalSeconds() {
    return Object.entries(this.b).filter(([k]) => k.startsWith('0:')).reduce((s, [, e]) => s + e.t, 0);
  }

  toJSON() { return { b: this.b, v: this.v }; }
}
