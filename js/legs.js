// Tramos: cuánto costó ir de un lugar a otro.
//
// Un tramo empieza al encender el motor y termina cuando se apaga para una parada
// (más de STOP_MS sin datos del motor; un semáforo con el motor andando no corta).
// Los cortes cortos de Bluetooth andando no cortan el tramo: se rellenan en fuel.fillGap.
// El costo usa los litros corregidos (con el factor del tanque) y el precio por litro
// de la última carga en que se anotó lo pagado.

import { MAX_GAP_FILL } from './fuel.js';

export const STOP_MS = MAX_GAP_FILL * 1000; // apagado más que esto = parada
export const MIN_LEG_KM = 0.2;              // mover el auto unos metros no es un tramo
const MAX_LEGS = 200;

export function newLegs() {
  return { cur: null, list: [] };
}

/** Suma km y litros al tramo en curso (lo crea si no hay). now: ms (Date.now()). */
export function legAdd(legs, km, l, now) {
  if (!(km >= 0) || !(l >= 0)) return;
  if (!legs.cur) legs.cur = { start: now, end: now, km: 0, l: 0 };
  legs.cur.km += km;
  legs.cur.l += l;
  legs.cur.end = now;
}

/** Cierra el tramo en curso y lo guarda en la lista (si recorrió algo), con el precio de ese día. */
export function legClose(legs, price = null) {
  const c = legs.cur;
  legs.cur = null;
  if (!c || c.km < MIN_LEG_KM) return null;
  const leg = { start: c.start, end: c.end, km: round(c.km, 2), l: round(c.l, 3), price: price > 0 ? price : null, to: '' };
  legs.list.unshift(leg);
  legs.list.length = Math.min(legs.list.length, MAX_LEGS);
  return leg;
}

/**
 * Al volver a tener datos del motor: si estuvo apagado más de STOP_MS, el tramo anterior terminó.
 * Usa la hora guardada en el tramo, así funciona aunque la app se haya cerrado durante la parada.
 */
export function legResume(legs, now, price = null) {
  if (legs.cur && now - legs.cur.end > STOP_MS) return legClose(legs, price);
  return null;
}

/** Precio por litro a partir de una carga. null si falta algún dato. */
export function pricePerLiter(paid, liters) {
  const p = Number(paid);
  const L = Number(liters);
  return p > 0 && L > 0 ? Math.round(p / L) : null;
}

/** Costo en pesos de unos litros. null si no hay precio. */
export const legCost = (l, price) => (price > 0 && l >= 0 ? Math.round(l * price) : null);

/** Agrupa tramos por día (fecha local) con sus totales, del más reciente al más antiguo. */
export function legsByDay(list) {
  const days = [];
  for (const leg of list) {
    const key = new Date(leg.start).toDateString();
    let d = days[days.length - 1];
    if (!d || d.key !== key) days.push((d = { key, date: leg.start, km: 0, l: 0, legs: [] }));
    d.km += leg.km;
    d.l += leg.l;
    d.legs.push(leg);
  }
  return days;
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
