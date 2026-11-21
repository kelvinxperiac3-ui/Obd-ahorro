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
    displacement: 2.8,
    nGears: 6,
    // Solo se midieron 5ª y 6ª (julio 2026); las demás se aprenden manejando.
    gearRatios: [28.5, 36.0],
    eco: { min: 1400, max: 2200 },
    ecoTop: { min: 1500, max: 2300 }, // 6ª: ~55–83 km/h
    power: { min: 1600, minLoaded: 1800, max: 3000, targetMax: 2700 },
    lugRpm: 1100,
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
