// Decide el color del indicador y el consejo para el conductor.

const ORD = ['', '1ª', '2ª', '3ª', '4ª', '5ª', '6ª'];
export const gearName = (g) => ORD[g] || `${g}ª`;

/**
 * s: { rpm, speed, load, throttle, lph, gear, fuelCut }
 * zone: { min, max }
 * gears: GearLearner (o null)
 * nGears: número de marchas de la caja
 */
export function advise(s, zone, gears, nGears) {
  if (s.rpm == null) return { color: 'off', msg: 'Sin datos' };
  if (s.speed != null && s.speed < 4) {
    return s.rpm > 1300
      ? { color: 'yellow', msg: 'Detenido: no aceleres en vacío' }
      : { color: 'idle', msg: 'Detenido' };
  }
  if (s.fuelCut) return { color: 'green', msg: 'Freno motor: no gasta' };

  const g = s.gear;
  const up = g && g < nGears && gears ? gears.rpmInGear(s.speed, g + 1) : null;
  const down = g && g > 1 && gears ? gears.rpmInGear(s.speed, g - 1) : null;

  if ((s.throttle != null && s.throttle > 80) || (s.load != null && s.load > 92)) {
    if (s.rpm > zone.max && up && up >= 1300) return { color: 'red', msg: `Sube a ${gearName(g + 1)} y suelta el acelerador`, shift: g + 1 };
    return { color: 'red', msg: 'Acelerador a fondo: suelta un poco' };
  }

  if (s.rpm > zone.max) {
    const color = s.rpm > zone.max + 600 ? 'red' : 'yellow';
    if (up && up >= Math.max(1300, zone.min - 300)) return { color, msg: `Sube a ${gearName(g + 1)}`, shift: g + 1 };
    if (g === nGears || (gears && gears.learned >= nGears && g === gears.learned)) return { color, msg: 'RPM altas: baja la velocidad' };
    return { color, msg: 'RPM altas' };
  }

  if (s.rpm < 1250 && (s.load ?? 0) > 65 && g && g > 1) {
    return { color: 'yellow', msg: down ? `Baja a ${gearName(g - 1)}: el motor se esfuerza` : 'Motor forzado: baja una marcha', shift: g - 1 };
  }

  if (s.rpm < zone.min) {
    return (s.load ?? 0) < 60
      ? { color: 'green', msg: 'Bien (RPM bajas, suave)' }
      : { color: 'yellow', msg: 'Poca RPM para esa carga' };
  }

  return { color: 'green', msg: 'Zona verde' };
}
