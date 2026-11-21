// Perfiles de vehículo: cada uno con sus marchas, zonas y datos guardados aparte.

export const VEHICLES = {
  md201: {
    id: 'md201',
    name: 'Changan MD201',
    short: 'MD201',
    fuel: 'gasolina',
    displacement: 1.243,
    nGears: 5,
    // km/h por 1000 rpm, medidas en el viaje a Tongoy
    gearRatios: [6.2, 11.0, 15.6, 20.7, 25.9],
    eco: { min: 1500, max: 2500 },
    ecoTop: { min: 1500, max: 2900 }, // en 5ª rinde bien hasta ~75 km/h
    power: { min: 3000, minLoaded: 3300, max: 5500, targetMax: 5000 },
    lugRpm: 1250,      // bajo esto, con carga, el motor se ahoga
    upMinRpm: 1300,    // no sugerir subir si la marcha siguiente queda bajo esto
    gaugeMax: 6000,
    idleRpm: 800,
    pedalPid: '11',    // mariposa (0111): 6.7 % suelto, ~82 % a fondo
  },
  homan: {
    id: 'homan',
    name: 'Sinotruk Homan 612i',
    short: 'Homan',
    fuel: 'diesel',
    // Motor JE493ZLQ5 (Jiangxi Isuzu 493): 2.771 L turbo intercooler, 85 kW (116 hp) a 3800 rpm,
    // 285 N·m entre 1800 y 2200 rpm.
    displacement: 2.771,
    nGears: 6,
    // Caja Wanliyang WLY6T40 (400 N·m). Relaciones de la serie WLY6G40 (6.14):
    // 6.14 / 3.36 / 2.11 / 1.34 / 1.00 / 0.79. La 5ª y 6ª medidas en el camión (28.5 y 36.0 km/h
    // por 1000 rpm) calzan con 1.00 y 0.79, así que el resto se calcula con el mismo factor.
    gearRatios: [6.14, 3.36, 2.11, 1.34, 1.0, 0.79].map((r) => Math.round((28.47 / r) * 100) / 100),
    eco: { min: 1400, max: 2200 },
    ecoTop: { min: 1500, max: 2300 }, // 6ª: ~54–83 km/h
    power: { min: 1800, minLoaded: 2000, max: 3600, targetMax: 3200 }, // torque máx. 1800–2200, potencia máx. 3800
    lugRpm: 1200,
    upMinRpm: 1150,
    gaugeMax: 4000,
    idleRpm: 750,
    pedalPid: '49',    // pedal del acelerador D (0149): ~14.5 % suelto
    gpsSpeed: true,    // la ECU informa velocidad 0: usar GPS del teléfono
  },
};

export const DEFAULT_VEHICLE = 'md201';

export function vehicle(id) {
  return VEHICLES[id] || VEHICLES[DEFAULT_VEHICLE];
}
