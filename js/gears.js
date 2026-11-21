// Marchas de la camioneta a partir de la relación velocidad/RPM.
// ratio = km/h por cada 1000 rpm. Cada marcha forma un "pico" en el histograma.

const BIN = 0.025; // ancho de bin en escala logarítmica (~2.5 %)

// Medidas en el viaje a Tongoy (Changan MD201 2019, manual 5 marchas).
export const MD201_RATIOS = [6.2, 11.0, 15.6, 20.7, 25.9];

export class GearLearner {
  /**
   * @param nGears  marchas de la caja
   * @param saved   histograma guardado
   * @param preset  relaciones conocidas (km/h por 1000 rpm). Si se dan, se usan tal cual.
   */
  constructor(nGears = 5, saved = null, preset = null) {
    this.nGears = nGears;
    this.hist = saved?.hist || {};
    this.total = saved?.total || 0;
    this.preset = preset?.length ? [...preset].sort((a, b) => a - b) : null;
    this.peaks = [];
    this._recompute();
  }

  static ratio(speed, rpm) {
    if (!speed || !rpm || rpm < 700) return null;
    return (speed * 1000) / rpm;
  }

  add(speed, rpm) {
    const r = GearLearner.ratio(speed, rpm);
    if (r == null || speed < 5 || rpm < 900) return;
    const b = Math.round(Math.log(r) / BIN);
    this.hist[b] = (this.hist[b] || 0) + 1;
    this.total++;
    if (this.total % 25 === 0) this._recompute();
  }

  /** Picos detectados en el histograma (sin usar el preset). */
  detect() {
    const keys = Object.keys(this.hist).map(Number);
    if (!keys.length) return [];
    const smooth = (b) => (this.hist[b - 1] || 0) * 0.5 + (this.hist[b] || 0) + (this.hist[b + 1] || 0) * 0.5;
    const minCount = Math.max(15, this.total * 0.02);
    const cands = [];
    for (const b of keys) {
      const v = smooth(b);
      if (v < minCount) continue;
      if (v >= smooth(b - 1) && v > smooth(b + 1) && v >= smooth(b - 2) && v > smooth(b + 2)) {
        let w = 0; let sum = 0;
        for (let k = b - 1; k <= b + 1; k++) { w += this.hist[k] || 0; sum += (this.hist[k] || 0) * k; }
        cands.push({ ratio: Math.exp((sum / w) * BIN), weight: v });
      }
    }
    cands.sort((a, b) => b.weight - a.weight);
    const chosen = [];
    for (const c of cands) {
      if (chosen.every((p) => Math.abs(Math.log(p.ratio / c.ratio)) > 0.12)) chosen.push(c);
      if (chosen.length >= this.nGears) break;
    }
    return chosen.map((c) => c.ratio).sort((a, b) => a - b);
  }

  _recompute() {
    if (this.preset && this.preset.length < this.nGears) {
      // Preset parcial (ej. solo las marchas altas medidas): completar con las detectadas más cortas.
      const lo = this.preset[0] * 0.9;
      const extra = this.detect().filter((p) => p < lo).slice(-(this.nGears - this.preset.length));
      this.peaks = [...extra, ...this.preset];
    } else {
      this.peaks = this.preset || this.detect();
    }
    // La 1ª casi no se usa y a veces no forma pico: si faltan marchas, se asume
    // que faltan las de abajo (la más larga detectada es la última marcha).
    this.offset = Math.max(0, this.nGears - this.peaks.length);
  }

  get learned() { return this.peaks.length; }

  /** Relación (km/h por 1000 rpm) de una marcha 1..n, o null si no se conoce. */
  ratioOf(gear) { return this.peaks[gear - 1 - this.offset] ?? null; }

  /** Marcha (1..n) o null si va en neutro / embrague pisado / sin datos. */
  gearFor(speed, rpm) {
    const r = GearLearner.ratio(speed, rpm);
    if (r == null || speed < 4) return null;
    let best = null; let bestErr = 0.07;
    this.peaks.forEach((p, i) => {
      const err = Math.abs(Math.log(r / p));
      if (err < bestErr) { bestErr = err; best = i + 1 + this.offset; }
    });
    return best;
  }

  /** RPM que tendría el motor en otra marcha a la misma velocidad. */
  rpmInGear(speed, gear) {
    const p = this.ratioOf(gear);
    return p ? (speed * 1000) / p : null;
  }

  toJSON() { return { hist: this.hist, total: this.total }; }
}
