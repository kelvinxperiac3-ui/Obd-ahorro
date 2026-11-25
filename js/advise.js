// Decide el color del indicador y el consejo para el conductor.

const ORD = ['', '1ª', '2ª', '3ª', '4ª', '5ª', '6ª'];
export const gearName = (g) => ORD[g] || `${g}ª`;

/**
 * s: { rpm, speed, load, throttle, lph, gear, fuelCut }
 * zone: { min, max }
 * gears: GearLearner (o null)
 * nGears: número de marchas de la caja
 * opts: { lugRpm, upMinRpm, idleRpm } según el vehículo
 */
export function advise(s, zone, gears, nGears, opts = {}) {
  const lugRpm = opts.lugRpm ?? 1250;
  const upMin = opts.upMinRpm ?? 1300;
  const idleRpm = opts.idleRpm ?? 800;
  if (s.rpm == null) return { color: 'off', msg: 'Sin datos' };
  if (s.speed != null && s.speed < 4) {
    return s.rpm > idleRpm + 500
      ? { color: 'yellow', msg: 'Detenido: no aceleres en vacío' }
      : { color: 'idle', msg: 'Detenido' };
  }
  if (s.fuelCut) return { color: 'green', msg: 'Freno motor: no gasta' };

  const g = s.gear;
  const up = g && g < nGears && gears ? gears.rpmInGear(s.speed, g + 1) : null;
  const down = g && g > 1 && gears ? gears.rpmInGear(s.speed, g - 1) : null;

  // "A fondo" por el pedal. La carga calculada no sirve para esto: en la MD201 marca 84–100 %
  // en carretera aunque se vaya suave. Solo se usa si no hay dato de pedal.
  const floored = s.throttle != null ? s.throttle > 80 : (s.load != null && s.load > 95);
  if (floored) {
    if (s.rpm > zone.max && up && up >= upMin) return { color: 'red', msg: `Sube a ${gearName(g + 1)} y suelta el acelerador`, shift: g + 1 };
    return { color: 'yellow', msg: 'Acelerador a fondo: suelta un poco' };
  }

  if (s.rpm > zone.max) {
    // En la última marcha ir más rápido gasta más, pero no es "error": rojo solo bastante arriba.
    // En la última marcha las RPM son la velocidad: la zona aprendida suele quedar baja (lo más
    // lento rinde más) y pintaría rojo toda la carretera. El rojo se mide desde la zona de fábrica.
    const top = g === nGears;
    const margin = top ? (opts.redMarginTop ?? 1200) : (opts.redMargin ?? 600);
    const redBase = top && opts.topMax ? Math.max(zone.max, opts.topMax) : zone.max;
    const color = s.rpm > redBase + margin ? 'red' : 'yellow';
    if (up && up >= Math.max(upMin, zone.min - 300)) return { color, msg: `Sube a ${gearName(g + 1)}`, shift: g + 1 };
    if (g === nGears) return { color, msg: opts.topHint || 'Más rápido = más consumo' };
    return { color, msg: 'RPM altas' };
  }

  if (s.rpm < lugRpm && (s.load ?? 0) > 65 && g && g > 1) {
    return { color: 'yellow', msg: down ? `Baja a ${gearName(g - 1)}: el motor se esfuerza` : 'Motor forzado: baja una marcha', shift: g - 1 };
  }

  if (s.rpm < zone.min) {
    return (s.load ?? 0) < 60
      ? { color: 'green', msg: 'Bien (RPM bajas, suave)' }
      : { color: 'yellow', msg: 'Poca RPM para esa carga' };
  }

  return { color: 'green', msg: 'Zona verde' };
}
