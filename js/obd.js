// Definiciones de PIDs del modo 01 y su decodificación.

export const PIDS = {
  '03': { key: 'fuelSys', n: 1, f: ([a]) => a }, // 4 = lazo abierto por desaceleración (corte)
  '04': { key: 'load', n: 1, f: ([a]) => (a * 100) / 255 },
  '05': { key: 'coolant', n: 1, f: ([a]) => a - 40 },
  '0B': { key: 'map', n: 1, f: ([a]) => a },
  '0C': { key: 'rpm', n: 2, f: ([a, b]) => (a * 256 + b) / 4 },
  '0D': { key: 'speed', n: 1, f: ([a]) => a },
  '0F': { key: 'iat', n: 1, f: ([a]) => a - 40 },
  '10': { key: 'maf', n: 2, f: ([a, b]) => (a * 256 + b) / 100 },
  '11': { key: 'throttle', n: 1, f: ([a]) => (a * 100) / 255 },
  '49': { key: 'pedalD', n: 1, f: ([a]) => (a * 100) / 255 },
  '5E': { key: 'fuelRate', n: 2, f: ([a, b]) => (a * 256 + b) / 20 },
};

/** Busca "41 <pid>" en las líneas de respuesta y devuelve los bytes de datos. */
export function extractBytes(lines, mode, pid, n) {
  const tag = (mode + pid).toUpperCase();
  for (const line of lines) {
    let hex = line.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    if (hex.length % 2) hex = hex.slice(3); // encabezado CAN de 11 bits (ej. 7E8)
    for (let i = hex.indexOf(tag); i >= 0; i = hex.indexOf(tag, i + 1)) {
      if (i % 2 !== 0) continue;
      const start = i + tag.length;
      if (hex.length < start + n * 2) continue;
      const out = [];
      for (let k = 0; k < n; k++) out.push(parseInt(hex.substr(start + k * 2, 2), 16));
      return out;
    }
  }
  return null;
}

export function decode(lines, pid) {
  const def = PIDS[pid];
  if (!def) return null;
  const bytes = extractBytes(lines, '41', pid, def.n);
  return bytes ? def.f(bytes) : null;
}

/** Decodifica la máscara de PIDs soportados (respuesta a 0100, 0120, 0140...). */
export function parseSupported(lines, basePid) {
  const base = parseInt(basePid, 16);
  const bytes = extractBytes(lines, '41', basePid, 4);
  const set = new Set();
  if (!bytes) return set;
  for (let i = 0; i < 32; i++) {
    if (bytes[i >> 3] & (0x80 >> (i & 7))) set.add((base + i + 1).toString(16).toUpperCase().padStart(2, '0'));
  }
  return set;
}

export async function readSupported(elm) {
  const all = new Set();
  for (const base of ['00', '20', '40']) {
    let lines;
    try { lines = await elm.send('01' + base, 5000); } catch { break; }
    const s = parseSupported(lines, base);
    s.forEach((p) => all.add(p));
    const next = (parseInt(base, 16) + 0x20).toString(16).toUpperCase().padStart(2, '0');
    if (!s.has(next)) break;
  }
  return all;
}

/**
 * Respuesta a una consulta con varias PIDs (ej. "010C0D0B"): "41 0C a b 0D a 0B a".
 * En CAN puede venir en varias tramas numeradas ("00A", "0: 41 0C ...", "1: ...").
 * Devuelve { pid: valor } con las que se pudieron leer.
 */
export function parseMulti(lines, pids) {
  const numbered = lines.some((l) => /^[0-9A-F]:/i.test(l.trim()));
  let hex = '';
  for (const raw of lines) {
    const l = raw.trim();
    if (numbered && /^[0-9A-F]{3}$/i.test(l.replace(/\s/g, ''))) continue; // largo total
    hex += l.replace(/^[0-9A-F]:/i, '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  }
  const out = {};
  let i = hex.indexOf('41');
  while (i >= 0 && i % 2) i = hex.indexOf('41', i + 1);
  if (i < 0) return out;
  i += 2;
  const want = new Set(pids.map((p) => p.toUpperCase()));
  while (i + 2 <= hex.length) {
    const pid = hex.substr(i, 2);
    const def = PIDS[pid];
    if (!def || !want.has(pid) || i + 2 + def.n * 2 > hex.length) break;
    const bytes = [];
    for (let k = 0; k < def.n; k++) bytes.push(parseInt(hex.substr(i + 2 + k * 2, 2), 16));
    out[pid] = def.f(bytes);
    want.delete(pid);
    i += 2 + def.n * 2;
  }
  return out;
}
