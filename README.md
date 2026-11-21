# OBD Ahorro

App web (PWA) para Android que lee el OBD2 de la camioneta en vivo y aprende **en qué rango de RPM rinde más el combustible**.

Vehículos (se eligen en la pantalla Manejar; cada uno guarda sus datos por separado):

| | Changan MD201 2019 | Sinotruk Homan 612i 2023 |
|---|---|---|
| Motor | Gasolina 1.2 (sin MAF) | Diésel JE493ZLQ5 2.77 L turbo: 116 hp a 3800 rpm, 285 N·m a 1800–2200 rpm |
| Caja | Manual 5 marchas | Wanliyang WLY6T40, 6 marchas (6.14/3.36/2.11/1.34/1.00/0.79) |
| Consumo | Calculado con MAP | Informado por la ECU (015E) |
| Velocidad | OBD (010D) | **GPS del teléfono** (la ECU informa 0) |
| Pedal | Mariposa (0111) | Pedal D (0149) |
| Zona de ahorro inicial | 1500–2500 rpm (5ª hasta 2900) | 1400–2200 rpm (6ª hasta 2300) |
| Zona de fuerza | 3000–5500 rpm | 1800–3600 rpm (2000 cargado) |

Adaptador: **KONNWEI KW905** (ELM327 Bluetooth LE).

## Qué hace

- Se conecta al adaptador por **Bluetooth LE** desde Chrome en Android (Web Bluetooth).
- Lee RPM (010C), velocidad (010D), presión del múltiple MAP (010B), temperatura de admisión (010F), acelerador (0111),
  estado del sistema de combustible (0103) y carga (0104). La MD201 **no tiene sensor MAF**, así que el consumo se calcula
  con MAP (speed-density). Si el vehículo tiene MAF (0110) o informa consumo (015E), se usa eso.
- Calcula el consumo: `MAF ≈ RPM/120 × MAP/(R·T) × cilindrada × VE × 28.97`, `L/h = MAF × 3600 ÷ (14.7 × 740)` y `km/L = velocidad ÷ L/h`.
- Detecta el **freno motor** (acelerador suelto en marcha → la inyección se corta → consumo 0).
- Trae precargadas las **relaciones de las 5 marchas de la MD201** (medidas en un viaje real); también puede aprenderlas sola.
- Guarda km recorridos y litros gastados **por rango de 250 rpm, por marcha y por velocidad**, solo a velocidad pareja, y calcula la **zona verde**: los rangos con al menos 90 % del mejor km/L.
- Pantalla de manejo: indicador verde/amarillo/rojo, km/L en vivo, marcha, aviso de cambio (“Sube a 4ª”) y avisos por voz.
- **Modo fuerza (subidas / carga):** detecta sola cuando vas con el pedal muy pisado y la camioneta no gana velocidad.
  Entonces cambia la zona a 3000–5500 rpm (3300 si vas cargado) y avisa por voz **“Baja a cuarta”** antes de que el motor se ahogue,
  sin mandarte a una marcha que pase de 5000 rpm. En plano vuelve sola al modo ahorro. El botón **Voy cargado** hace que entre antes.
  Avisa también si te pasas de 5500 rpm.
- **Importa registros de Car Scanner** (CSV) para aprender de viajes anteriores.
- Modo **Demo** con un simulador, para probar sin la camioneta.
- Exporta el viaje en CSV y lo aprendido en JSON. Funciona sin señal una vez abierta (service worker).

## Cómo usarla

1. Abre la página en **Chrome para Android** (necesita HTTPS, por ejemplo GitHub Pages).
2. Menú ⋮ → *Agregar a pantalla principal* para tenerla como app.
3. Conecta el KW905 en el puerto OBD2 y pon el contacto en ON (o enciende el motor).
4. Activa Bluetooth y ubicación en el teléfono. **No** lo emparejes desde Ajustes de Android.
5. Toca **Conectar** y elige el adaptador en la lista.
6. Maneja normal unos días. La zona verde se va ajustando sola (pestaña *Mi zona*).

Si no conecta o no lee datos, mira la pestaña **Ajustes → Diagnóstico**: ahí se ve todo lo que responde el adaptador.

## Desarrollo

No necesita compilación: HTML + JavaScript (módulos ES).

```sh
npm test          # pruebas de cálculo (Node 18+)
python3 -m http.server 8080   # y abrir http://localhost:8080 → botón Demo
```

| Archivo | Qué hace |
|---|---|
| `js/ble.js` | Conexión Web Bluetooth y búsqueda de las características GATT del adaptador |
| `js/elm327.js` | Cola de comandos ELM327 (espera el prompt `>`), inicialización |
| `js/obd.js` | PIDs del modo 01 y decodificación |
| `js/fuel.js` | Consumo por 015E / MAF / MAP |
| `js/gears.js` | Aprendizaje de marchas |
| `js/analyzer.js` | Marcha, velocidad pareja y qué muestras cuentan |
| `js/import.js` | Importar registros de Car Scanner |
| `js/power.js` | Detector de subidas y consejos del modo fuerza |
| `js/vehicles.js` | Perfiles de vehículo (marchas, zonas, PIDs) |
| `js/stats.js` | Rendimiento por rango de RPM y zona verde |
| `js/advise.js` | Color del indicador y consejo de cambio |
| `js/sim.js` | Simulador de ELM327 + camioneta |
| `js/app.js` | Interfaz |

## Limitaciones conocidas

- El consumo calculado por MAP es una estimación (±10–15 %). Para afinarlo, usa el *factor de corrección* en Ajustes comparando con una carga de tanque lleno.
- Los adaptadores ELM327 con **Bluetooth clásico** no funcionan con Web Bluetooth; para esos haría falta una app nativa.
