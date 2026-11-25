// Cálculo de consumo instantáneo para motor a gasolina.

export const DEFAULT_ENGINE = {
  displacement: 1.243, // litros (Changan MD201 1.2; el 1.5 XL es 1.493)
  ve: 0.85,            // eficiencia volumétrica, solo se usa si no hay MAF
  afr: 14.7,           // relación estequiométrica aire/gasolina
  density: 740,        // g/L de gasolina
};

/** Estima MAF (g/s) a partir de MAP (kPa), RPM y temperatura de admisión (°C). */
export function mafFromMap(rpm, mapKpa, iatC, displacementL, ve) {
  const R = 8.314; // J/(mol·K)
  const M = 28.97; // g/mol aire
  const molesPerCycle = (mapKpa * displacementL) / (R * (iatC + 273.15));
  return (rpm / 120) * molesPerCycle * M * ve;
}

/**
 * Devuelve { lph, method } o null.
 * Prioridad: 015E (consumo reportado) > MAF > MAP+IAT.
 */
export function fuelLph(s, cfg = DEFAULT_ENGINE) {
  if (s.fuelRate != null) return { lph: s.fuelRate, method: 'ECU (015E)' };
  // En diésel la mezcla no es fija (14.7): sin el dato de la ECU no hay cálculo confiable.
  if (cfg.fuel === 'diesel') return null;
  let maf = s.maf;
  let method = 'MAF';
  if (maf == null && s.map != null && s.rpm != null) {
    maf = mafFromMap(s.rpm, s.map, s.iat ?? 25, cfg.displacement, cfg.ve);
    method = 'MAP';
  }
  if (maf == null) return null;
  return { lph: (maf * 3600) / (cfg.afr * cfg.density), method };
}

export const MAX_GAP_FILL = 180; // segundos: un corte más largo no se rellena

/**
 * Corte de conexión andando (Bluetooth que se cae y vuelve): estima los km y litros de ese rato
 * con el promedio de la lectura de antes y la de después. Sin esto el viaje queda corto y el
 * factor del tanque se desvía. prev/cur: { speed, lph, rawLph }. Devuelve null si no aplica.
 */
export function fillGap(prev, cur, dt) {
  if (!prev || dt < 5 || dt > MAX_GAP_FILL) return null;
  if (prev.speed == null || cur.speed == null || prev.speed < 5 || cur.speed < 5) return null;
  const avg = (a, b) => (a == null || b == null ? null : (a + b) / 2);
  const h = dt / 3600;
  const lph = avg(prev.lph, cur.lph);
  const rawLph = avg(prev.rawLph, cur.rawLph);
  return { km: avg(prev.speed, cur.speed) * h, l: lph == null ? 0 : lph * h, rawL: rawLph == null ? null : rawLph * h };
}

/** km/L a partir de velocidad (km/h) y L/h. null si va detenido. */
export function kmPerL(speed, lph) {
  if (speed == null || lph == null || speed < 3) return null;
  if (lph <= 0.01) return 99.9; // corte de inyección
  return Math.min(99.9, speed / lph);
}
