// Modo fuerza: detecta subidas o carga pesada y aconseja la marcha para no perder velocidad.
//
// Motor MD201 1.2: torque máximo ~4800 rpm, potencia máxima ~6000 rpm.
// Bajo ~3000 rpm, a fondo y cargada, la camioneta se va quedando.

import { gearName } from './advise.js';

export const POWER = {
  min: 3000,        // bajo esto, con el pedal a fondo, conviene bajar de marcha
  minLoaded: 3300,  // con carga se baja antes
  max: 5500,        // sobre esto no se gana fuerza
  targetMax: 5000,  // al bajar, la nueva marcha no debería quedar sobre esto
};

/**
 * Pedal relativo 0–100 % a partir de la mariposa absoluta (0111).
 * La MD201 marca ~6.7 % en reposo y ~82 % a fondo.
 */
export function pedalPct(throttle, idle, full) {
  if (throttle == null) return null;
  const lo = idle < 100 ? idle : 7;
  const hi = Math.max(full || 80, lo + 20);
  return Math.max(0, Math.min(100, ((throttle - lo) / (hi - lo)) * 100));
}

/**
 * Detecta "voy subiendo / voy cargado": pedal muy pisado y la camioneta no gana velocidad.
 * Tiene histéresis para no parpadear.
 */
export class HillDetector {
  constructor() {
    this.active = false;
    this.since = null;     // desde cuándo se cumple la condición
    this.lastDemand = -1e9;
  }

  update({ t, pedal, accel, speed, loaded = false }) {
    const pedalOn = loaded ? 50 : 65;
    const maxAccel = loaded ? 0.25 : 0.1; // m/s²
    const moving = speed != null && speed > 15;
    const demand = moving && pedal != null && pedal >= pedalOn && accel != null && accel < maxAccel;

    if (demand) {
      this.lastDemand = t;
      if (this.since == null) this.since = t;
      if (t - this.since >= (loaded ? 1 : 2)) this.active = true;
    } else {
      this.since = null;
    }
    // Sale cuando suelta el pedal o lleva un rato sin exigirle al motor.
    if (this.active && ((pedal != null && pedal < 30) || t - this.lastDemand > 8 || !moving)) {
      this.active = false;
    }
    return this.active;
  }
}

/**
 * Consejo en modo fuerza. Devuelve null si no aplica (se usa el consejo normal).
 * s: { rpm, speed, gear }
 */
export function powerAdvice(s, gears, nGears, loaded = false) {
  const g = s.gear;
  if (s.rpm == null || !g) return null;
  const min = loaded ? POWER.minLoaded : POWER.min;

  if (s.rpm > POWER.max) {
    return g < nGears
      ? { color: 'red', msg: `Pasado de vueltas: sube a ${gearName(g + 1)}`, shift: g + 1, power: true }
      : { color: 'red', msg: 'Pasado de vueltas: suelta un poco', power: true };
  }
  if (s.rpm < min && g > 1) {
    const down = gears?.rpmInGear(s.speed, g - 1);
    if (down && down <= POWER.targetMax) {
      return { color: s.rpm < min - 600 ? 'red' : 'yellow', msg: `Baja a ${gearName(g - 1)} para tener fuerza`, shift: g - 1, power: true };
    }
    if (down && down <= POWER.max) {
      return { color: 'yellow', msg: `Baja a ${gearName(g - 1)} (quedará alto de vueltas)`, shift: g - 1, power: true };
    }
  }
  if (s.rpm < min) return { color: 'yellow', msg: 'Poca fuerza: mantén el pedal', power: true };
  return { color: 'green', msg: 'Buena fuerza para subir', power: true };
}
