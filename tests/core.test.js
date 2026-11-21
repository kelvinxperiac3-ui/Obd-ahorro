import test from 'node:test';
import assert from 'node:assert/strict';
import { decode, parseSupported, extractBytes } from '../js/obd.js';
import { cleanLines } from '../js/elm327.js';
import { fuelLph, kmPerL, mafFromMap } from '../js/fuel.js';
import { GearLearner } from '../js/gears.js';
import { RpmStats } from '../js/stats.js';
import { advise } from '../js/advise.js';

test('decodifica RPM, velocidad y MAF con y sin espacios', () => {
  assert.equal(decode(['41 0C 1A F8'], '0C'), 1726);
  assert.equal(decode(['410D3C'], '0D'), 60);
  assert.equal(decode(['41 10 01 F4'], '10'), 5);
  assert.equal(decode(['NO DATA'], '10'), null);
  // con encabezados CAN (7E8 06 41 0C ...)
  assert.equal(decode(['7E804410C1AF8'], '0C'), 1726);
});

test('no confunde 41 en posición impar', () => {
  assert.deepEqual(extractBytes(['A410C0FA0'], '41', '0C', 2), null);
});

test('limpia eco y SEARCHING', () => {
  assert.deepEqual(cleanLines('0100\rSEARCHING...\r41 00 BE 3F B8 13\r\r', '0100'), ['41 00 BE 3F B8 13']);
});

test('PIDs soportados', () => {
  const s = parseSupported(['4100BE3FB813'], '00');
  for (const p of ['04', '05', '0B', '0C', '0D', '0F', '10', '11', '20']) assert.ok(s.has(p), p);
  assert.ok(!s.has('02'));
});

test('consumo por MAF (gasolina)', () => {
  const r = fuelLph({ maf: 10 });
  assert.equal(r.method, 'MAF');
  assert.ok(Math.abs(r.lph - 3.309) < 0.01);
  assert.ok(Math.abs(kmPerL(60, r.lph) - 18.13) < 0.05);
  assert.equal(kmPerL(1, 2), null);
});

test('015E tiene prioridad y MAP sirve de respaldo', () => {
  assert.equal(fuelLph({ fuelRate: 2.5, maf: 10 }).lph, 2.5);
  const m = fuelLph({ map: 40, iat: 30, rpm: 2000 }, { displacement: 1.243, ve: 0.85, afr: 14.7, density: 740 });
  assert.equal(m.method, 'MAP');
  const maf = mafFromMap(2000, 40, 30, 1.243, 0.85);
  assert.ok(maf > 6 && maf < 12, String(maf));
});

test('aprende 5 marchas y las reconoce', () => {
  const ratios = [7.2, 12.8, 19.5, 26.5, 33.0];
  const g = new GearLearner(5);
  for (let i = 0; i < 4000; i++) {
    const r = ratios[i % 5] * (1 + (Math.random() - 0.5) * 0.02);
    const rpm = 1200 + Math.random() * 2000;
    g.add((r * rpm) / 1000, rpm);
  }
  assert.equal(g.learned, 5);
  assert.equal(g.gearFor(39, 2000), 3); // 19.5 km/h por 1000 rpm
  assert.equal(g.gearFor(10, 2500), null); // embrague / neutro
  assert.ok(Math.abs(g.rpmInGear(53, 4) - 2000) < 60);
});

test('zona verde alrededor del mejor rango', () => {
  const st = new RpmStats();
  const eff = { 1250: 12, 1500: 15, 1750: 17, 2000: 17.5, 2250: 16.5, 2500: 14, 2750: 12, 3000: 10 };
  for (const [rpm, kml] of Object.entries(eff)) {
    for (let i = 0; i < 60; i++) st.add({ rpm: Number(rpm) + 10, speed: 50, lph: 50 / kml, gear: 4, dt: 1 });
  }
  const z = st.zone(0);
  assert.ok(z.learned);
  assert.equal(z.min, 1750);
  assert.equal(z.max, 2500);
  assert.equal(st.zone(3).learned, false); // sin datos en 3ª
});

test('consejos', () => {
  const g = new GearLearner(5, null, [7.2, 12.8, 19.5, 26.5, 33.0]);
  const zone = { min: 1500, max: 2500 };
  assert.equal(advise({ rpm: 2000, speed: 39, gear: 3, load: 40, throttle: 20 }, zone, g, 5).color, 'green');
  const up = advise({ rpm: 3200, speed: 62, gear: 3, load: 50, throttle: 30 }, zone, g, 5);
  assert.equal(up.shift, 4);
  assert.match(up.msg, /Sube a 4ª/);
  const down = advise({ rpm: 1100, speed: 36, gear: 4, load: 80, throttle: 50 }, zone, g, 5);
  assert.equal(down.shift, 3);
  assert.equal(advise({ rpm: 800, speed: 0 }, zone, g, 5).color, 'idle');
});

import { parseCarScanner } from '../js/import.js';
import { Analyzer } from '../js/analyzer.js';
import { MD201_RATIOS } from '../js/gears.js';

test('si falta la 1ª, numera desde la última marcha', () => {
  const g = new GearLearner(5);
  const ratios = [11.0, 15.6, 20.7, 25.9]; // 2ª a 5ª, como en el viaje a Tongoy
  for (let i = 0; i < 3000; i++) { const rpm = 1500 + Math.random() * 1500; g.add((ratios[i % 4] * rpm) / 1000, rpm); }
  assert.equal(g.learned, 4);
  assert.equal(g.gearFor(51.8, 2000), 5);
  assert.equal(g.gearFor(22, 2000), 2);
  assert.equal(g.ratioOf(1), null);
});

test('preset de la MD201', () => {
  const g = new GearLearner(5, null, MD201_RATIOS);
  assert.equal(g.gearFor(65, 2510), 5);
  assert.equal(g.gearFor(12.4, 2000), 1);
  assert.ok(Math.abs(g.rpmInGear(60, 4) - 2899) < 5);
});

test('importa registro de Car Scanner', () => {
  const csv = [
    '"SECONDS";"PID";"VALUE";"UNITS";',
    '"100.0";"Presión absoluta en el colector de admisión";"11.748";"psi";',
    '"100.1";"Consumo instantáneo de combustible (l/h)";"3.5";"L/h";',
    '"100.2";"Velocidad del vehículo";"60";"km/h";',
    '"100.3";"Revoluciones del motor";"2317";"rpm";',
    '"100.3";"Revoluciones del motor x1000";"2.3";"rpm";',
  ].join('\n');
  const rows = parseCarScanner(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rpm, 2317);
  assert.equal(rows[0].speed, 60);
  assert.equal(rows[0].lph, 3.5);
  assert.ok(Math.abs(rows[0].map - 81) < 0.1);
  assert.throws(() => parseCarScanner('a,b,c'));
});

test('solo acumula a velocidad pareja', () => {
  const an = new Analyzer(new GearLearner(5, null, MD201_RATIOS));
  // acelerando de 30 a 60 km/h en 3ª: no cuenta
  for (let i = 0; i <= 30; i++) { const v = 30 + i; an.feed({ t: i, speed: v, rpm: (v * 1000) / 15.6, lph: 6 }); }
  assert.equal(an.stats.totalSeconds(), 0);
  // crucero a 65 en 5ª: cuenta
  for (let i = 31; i <= 90; i++) an.feed({ t: i, speed: 65, rpm: 2510, lph: 3.7 });
  assert.ok(an.stats.totalSeconds() > 50);
  // freno motor: no cuenta
  const before = an.stats.totalSeconds();
  for (let i = 91; i <= 100; i++) an.feed({ t: i, speed: 65, rpm: 2510, lph: 0, fuelCut: true });
  assert.equal(an.stats.totalSeconds(), before);
  const sp = an.stats.bySpeed();
  assert.equal(sp[0].band, 60);
  assert.equal(sp[0].gears[0].gear, 5);
});

import { HillDetector, powerAdvice, pedalPct } from '../js/power.js';

test('pedal relativo con la mariposa de la MD201', () => {
  assert.equal(pedalPct(6.7, 6.7, 82), 0);
  assert.equal(pedalPct(82, 6.7, 82), 100);
  assert.ok(Math.abs(pedalPct(44.35, 6.7, 82) - 50) < 0.1);
  assert.equal(pedalPct(null, 6.7, 82), null);
});

test('detecta subida: pedal a fondo y sin ganar velocidad', () => {
  const h = new HillDetector();
  assert.equal(h.update({ t: 0, pedal: 90, accel: -0.2, speed: 60 }), false);
  assert.equal(h.update({ t: 1, pedal: 90, accel: -0.2, speed: 59 }), false);
  assert.equal(h.update({ t: 2.1, pedal: 90, accel: -0.2, speed: 58 }), true);
  // acelerando fuerte en plano (gana velocidad): no es subida
  const h2 = new HillDetector();
  for (let t = 0; t < 5; t++) assert.equal(h2.update({ t, pedal: 95, accel: 1.2, speed: 40 + t * 4 }), false);
  // suelta el pedal: sale del modo
  assert.equal(h.update({ t: 3, pedal: 20, accel: 0, speed: 58 }), false);
});

test('cargado entra antes', () => {
  const h = new HillDetector();
  h.update({ t: 0, pedal: 55, accel: 0.1, speed: 50, loaded: true });
  assert.equal(h.update({ t: 1.1, pedal: 55, accel: 0.1, speed: 50, loaded: true }), true);
  const n = new HillDetector();
  n.update({ t: 0, pedal: 55, accel: 0.1, speed: 50 });
  assert.equal(n.update({ t: 3, pedal: 55, accel: 0.1, speed: 50 }), false);
});

test('consejo de fuerza en la MD201', () => {
  const g = new GearLearner(5, null, MD201_RATIOS);
  // 5ª a 70 km/h ≈ 2700 rpm en subida → bajar a 4ª (≈3380 rpm)
  const a = powerAdvice({ rpm: 2703, speed: 70, gear: 5 }, g, 5);
  assert.equal(a.shift, 4);
  assert.match(a.msg, /Baja a 4ª/);
  // 4ª a 70 ≈ 3380 → bien
  assert.equal(powerAdvice({ rpm: 3380, speed: 70, gear: 4 }, g, 5).color, 'green');
  // cargado: 3200 rpm ya pide bajar
  assert.equal(powerAdvice({ rpm: 3200, speed: 66, gear: 4 }, g, 5, true).shift, 3);
  // no manda a una marcha que pase de 5000 rpm
  const b = powerAdvice({ rpm: 2900, speed: 60, gear: 3 }, g, 5); // 2ª quedaría en ~5450
  assert.match(b.msg, /quedará alto/);
  // pasado de vueltas
  assert.equal(powerAdvice({ rpm: 5800, speed: 64, gear: 2 }, g, 5).shift, 3);
});

import { VEHICLES } from '../js/vehicles.js';

test('Homan: preset parcial (5ª y 6ª) y el resto se aprende', () => {
  const g = new GearLearner(6, null, [28.5, 36.0]); // solo 5ª y 6ª conocidas
  assert.equal(g.gearFor(80, 2220), 6);
  assert.equal(g.gearFor(80, 2807), 5);
  assert.equal(g.ratioOf(4), null);
  // maneja en 3ª y 4ª: aparecen
  for (let i = 0; i < 2000; i++) {
    const r = i % 2 ? 22.5 : 17.5; const rpm = 1300 + Math.random() * 1200;
    g.add((r * rpm) / 1000, rpm);
  }
  g._recompute();
  assert.equal(g.gearFor(45, 2000), 4);
  assert.equal(g.gearFor(35, 2000), 3);
  assert.equal(g.gearFor(80, 2220), 6);
});

test('diésel: solo consumo de la ECU, nunca la fórmula de gasolina', () => {
  assert.equal(fuelLph({ maf: 179 }, { fuel: 'diesel' }), null);
  assert.equal(fuelLph({ fuelRate: 14.4, maf: 179 }, { fuel: 'diesel' }).lph, 14.4);
});

test('importa registro del camión usando la velocidad GPS', () => {
  const csv = [
    '"SECONDS";"PID";"VALUE";"UNITS";"LATITUDE";"LONGTITUDE";',
    '"10.0";"Velocidad (GPS)";"78.0";"km/h";"-31.3";"-71.5";',
    '"10.1";"Velocidad del vehículo";"0";"km/h";"-31.3";"-71.5";',
    '"10.2";"Consumo del combustible del motor";"14.4";"L/h";"-31.3";"-71.5";',
    '"10.3";"Revoluciones del motor";"2164";"rpm";"-31.3";"-71.5";',
  ].join('\n');
  const [r] = parseCarScanner(csv);
  assert.equal(r.speed, 78);
  assert.equal(r.speedSrc, 'GPS');
  assert.equal(r.lph, 14.4);
});

test('consejos del diésel con su zona', () => {
  const V = VEHICLES.homan;
  const g = new GearLearner(6, null, [7.5, 12.5, 17.5, 22.5, 28.5, 36.0]);
  const opts = { lugRpm: V.lugRpm, upMinRpm: V.upMinRpm, idleRpm: V.idleRpm, redMargin: 400 };
  // 5ª a 80 km/h ≈ 2800 rpm: subir a 6ª (≈2220)
  const a = advise({ rpm: 2807, speed: 80, gear: 5, load: 40, throttle: 30 }, V.eco, g, 6, opts);
  assert.equal(a.shift, 6);
  // 6ª a 70 ≈ 1945 rpm: zona verde
  assert.equal(advise({ rpm: 1945, speed: 70, gear: 6, load: 50, throttle: 40 }, V.ecoTop, g, 6, opts).color, 'green');
  // subida: 6ª a 1500 rpm → bajar a 5ª (≈1900)
  const p = powerAdvice({ rpm: 1500, speed: 54, gear: 6 }, g, 6, false, V.power);
  assert.equal(p.shift, 5);
});

test('Homan: 6 marchas de la caja WLY6T40 calzan con lo medido', () => {
  const g = new GearLearner(6, null, VEHICLES.homan.gearRatios);
  assert.equal(g.gearFor(80, 2807), 5); // medido: 28.5 km/h por 1000 rpm
  assert.equal(g.gearFor(78, 2164), 6); // medido: 36.0
  assert.equal(g.gearFor(20, 2360), 2);
  // subida en 6ª a 1700 rpm: bajar a 5ª (≈2150 rpm)
  assert.equal(powerAdvice({ rpm: 1700, speed: 61, gear: 6 }, g, 6, false, VEHICLES.homan.power).shift, 5);
  // cargado, 5ª a 1950: bajar a 4ª (≈2610)
  assert.equal(powerAdvice({ rpm: 1950, speed: 55.5, gear: 5 }, g, 6, true, VEHICLES.homan.power).shift, 4);
});
