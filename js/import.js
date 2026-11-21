// Importa registros de Car Scanner (formato "SECONDS";"PID";"VALUE";"UNITS").
// Junta los valores por momento: cada lectura de RPM toma el último valor de los demás.

const NAMES = [
  [/^Revoluciones del motor$|^Engine RPM$/i, 'rpm'],
  [/^Velocidad del veh[ií]culo$|^Vehicle speed$/i, 'speed'],
  [/^Consumo instant[aá]neo de combustible \(l\/h\)$|^Fuel rate \(l\/h\)$|^Instant fuel consumption \(l\/h\)$/i, 'lph'],
  [/colector de admisi[oó]n$|^Intake manifold (absolute )?pressure$/i, 'map'],
  [/^Posici[oó]n de la mariposa|^Throttle position/i, 'thr'],
  [/^Caudal de aire|^MAF/i, 'maf'],
  [/^Economizador de combustible/i, 'eco'],
];

const toKpa = (v, unit) => (/psi/i.test(unit) ? v * 6.894757 : /bar/i.test(unit) ? v * 100 : v);

export function parseCarScanner(text) {
  const lines = text.split(/\r?\n/);
  const head = lines[0] || '';
  const sep = head.includes(';') ? ';' : ',';
  if (!/SECONDS/i.test(head) || !/PID/i.test(head)) throw new Error('No parece un registro de Car Scanner (faltan columnas SECONDS/PID/VALUE).');
  const cache = new Map();
  const keyOf = (name) => {
    if (!cache.has(name)) cache.set(name, NAMES.find(([re]) => re.test(name))?.[1] || null);
    return cache.get(name);
  };
  const last = {};
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const f = splitRow(lines[i], sep);
    if (f.length < 3) continue;
    const t = Number(f[0]);
    const key = keyOf(f[1]);
    if (!key || !Number.isFinite(t)) continue;
    let v = Number(f[2]);
    if (!Number.isFinite(v)) continue;
    if (key === 'map') v = toKpa(v, f[3] || '');
    if (key === 'rpm') {
      const r = { t, rpm: v };
      for (const k of ['speed', 'lph', 'map', 'thr', 'maf', 'eco']) {
        if (last[k] && t - last[k].t < 2.5) r[k] = last[k].v;
      }
      rows.push(r);
    } else {
      last[key] = { t, v };
    }
  }
  if (!rows.length) throw new Error('El archivo no trae RPM.');
  return rows;
}

function splitRow(line, sep) {
  return line.split(sep).map((s) => s.trim().replace(/^"|"$/g, ''));
}
