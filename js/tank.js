// Consumo real por el método "tanque lleno a tanque lleno".
//
// 1. Se llena hasta el corte y se marca el inicio.
// 2. Mientras se maneja, la app suma km y litros ESTIMADOS (sin factor de corrección).
// 3. En la siguiente carga hasta el corte, los litros de la bomba son el consumo real del
//    período: real km/L = km / litros, y factor = litros reales / litros estimados.
// Las cargas parciales (sin llegar al corte) se suman a la siguiente carga completa.
// Con el odómetro de ambas cargas, los km son exactos aunque algún tramo se haya manejado
// sin la app; en ese caso los litros estimados se escalan según la parte medida.

export const MIN_KM = 50;        // menos que esto, el error de llenado (±1 L) pesa demasiado
export const MIN_COVERAGE = 0.9; // la app debe haber medido al menos el 90 % de los km

export function newTank() {
  return { period: null, pendingL: 0, history: [], undo: null };
}

/** Suma lo manejado (km y litros estimados sin corrección) al período en curso. */
export function addDriving(tank, km, rawL) {
  if (!tank.period || !(km >= 0) || !(rawL >= 0)) return;
  tank.period.km += km;
  tank.period.rawL += rawL;
}

/**
 * Registra una carga.
 * @param {object} f { liters, odo, full, date }
 * @returns resultado: { type: 'start' | 'partial' | 'full', ... }
 */
export function registerFill(tank, { liters = 0, odo = null, full = true, date = new Date().toISOString() }) {
  const snapshot = JSON.stringify({ period: tank.period, pendingL: tank.pendingL, history: tank.history });
  const L = Number(liters) || 0;
  const odometer = odo === '' || odo == null ? null : Number(odo);

  if (!full) {
    if (!tank.period) return { type: 'partial', ignored: true };
    tank.pendingL += L;
    tank.undo = snapshot;
    return { type: 'partial', liters: L, pendingL: tank.pendingL };
  }

  if (!tank.period) {
    tank.period = { start: date, odoStart: odometer, km: 0, rawL: 0 };
    tank.pendingL = 0;
    tank.undo = snapshot;
    return { type: 'start' };
  }

  const p = tank.period;
  const total = L + tank.pendingL;
  const odoKm = odometer != null && p.odoStart != null && odometer > p.odoStart ? odometer - p.odoStart : null;
  const km = odoKm ?? p.km;
  const coverage = odoKm ? p.km / odoKm : null;
  // Si la app no midió todo el trayecto, se estima lo que faltó con el mismo rendimiento.
  const rawFull = coverage && coverage < 0.98 && coverage > 0 ? p.rawL / coverage : p.rawL;

  const warnings = [];
  if (total <= 0) warnings.push('litros');
  if (km < MIN_KM) warnings.push('corto');
  if (coverage != null && coverage < MIN_COVERAGE) warnings.push('cobertura');
  if (rawFull <= 0) warnings.push('sinDatos');

  const res = {
    date,
    start: p.start,
    km: round(km, 1),
    appKm: round(p.km, 1),
    odoKm: odoKm != null ? round(odoKm, 1) : null,
    liters: round(total, 2),
    rawL: round(p.rawL, 2),
    realKmL: total > 0 ? round(km / total, 2) : null,
    appKmL: p.rawL > 0 ? round(p.km / p.rawL, 2) : null,
    factor: total > 0 && rawFull > 0 ? round(total / rawFull, 3) : null,
    coverage: coverage != null ? round(coverage, 3) : null,
    warnings,
  };
  tank.history.unshift(res);
  tank.history.length = Math.min(tank.history.length, 30);
  tank.period = { start: date, odoStart: odometer, km: 0, rawL: 0 };
  tank.pendingL = 0;
  tank.undo = snapshot;
  return { type: 'full', ...res };
}

/** Deshace la última carga registrada (por si se equivocó al anotar). */
export function undoFill(tank) {
  if (!tank.undo) return false;
  const prev = JSON.parse(tank.undo);
  tank.period = prev.period;
  tank.pendingL = prev.pendingL;
  tank.history = prev.history;
  tank.undo = null;
  return true;
}

/**
 * Factor sugerido: promedio ponderado por litros de las últimas 3 cargas confiables.
 * Una sola carga tiene ±5–10 % de error (el corte de la bomba no es exacto); varias lo afinan.
 */
export function suggestedFactor(history) {
  const ok = history.filter((h) => h.factor && !h.warnings.length).slice(0, 3);
  if (!ok.length) return null;
  const w = ok.reduce((s, h) => s + h.liters, 0);
  return { factor: round(ok.reduce((s, h) => s + h.factor * h.liters, 0) / w, 3), n: ok.length };
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
