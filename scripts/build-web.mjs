// Copia la app web a www/ para empaquetarla en Android (Capacitor).
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.join(root, 'www');
fs.rmSync(out, { recursive: true, force: true });
const copy = (rel) => {
  const src = path.join(root, rel);
  const dst = path.join(out, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
};
for (const f of ['index.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'css', 'js']) copy(f);
// Núcleo de Capacitor (sin dependencias): lo usa js/native.js dentro de la app Android.
fs.mkdirSync(path.join(out, 'js/vendor'), { recursive: true });
fs.copyFileSync(path.join(root, 'node_modules/@capacitor/core/dist/index.js'), path.join(out, 'js/vendor/capacitor-core.js'));
console.log('www/ lista');
