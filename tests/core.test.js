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
  const g = new GearLearner(5);
  g.peaks = [7.2, 12.8, 19.5, 26.5, 33.0];
  const zone = { min: 1500, max: 2500 };
  assert.equal(advise({ rpm: 2000, speed: 39, gear: 3, load: 40, throttle: 20 }, zone, g, 5).color, 'green');
  const up = advise({ rpm: 3200, speed: 62, gear: 3, load: 50, throttle: 30 }, zone, g, 5);
  assert.equal(up.shift, 4);
  assert.match(up.msg, /Sube a 4ª/);
  const down = advise({ rpm: 1100, speed: 36, gear: 4, load: 80, throttle: 50 }, zone, g, 5);
  assert.equal(down.shift, 3);
  assert.equal(advise({ rpm: 800, speed: 0 }, zone, g, 5).color, 'idle');
});
