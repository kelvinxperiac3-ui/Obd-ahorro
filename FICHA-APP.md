# Ficha de la app — OBD Ahorro

Léela antes de cada versión. Si un cambio va contra esto, se para y se pregunta.

## Qué debe hacer
- Leer el auto por OBD (ELM327 por Bluetooth LE, KONNWEI KW905) y decir en vivo si se está manejando gastando poco.
- Indicador de color (verde / amarillo / rojo) y consejo corto: subir o bajar de marcha, soltar el acelerador.
- Calcular el consumo (L/h y km/L). La MD201 no tiene MAF: se calcula con MAP + RPM + temperatura.
- Detectar el freno motor (corte de inyección) y el modo fuerza (subidas).
- Aprender la zona verde de RPM de cada marcha con el uso.
- Pestaña Tanque: llevar los litros y corregir el cálculo con cada carga real (factor).
- Viaje: km, litros, tiempo y promedio. Exportar el viaje en CSV. El respaldo (JSON) guarda lo aprendido, el tanque y los tramos de Gastos.
- Gastos: costo en pesos de cada tramo entre paradas (motor apagado > 3 min), del viaje y del día. Precio por litro = lo pagado ÷ litros de la última carga. Se puede anotar a dónde se llegó.
- Reconectar solo si se corta el Bluetooth o el adaptador se duerme en una parada: intentos rápidos y después cada 20 s, hasta 90 min. Al volver, pide otra vez todos los datos.
- Vehículos: Changan MD201 (gasolina) y Homan (diésel).

## Qué NO debe hacer
- No pintar rojo por ir normal en carretera en la última marcha (rojo solo muy arriba, ~4100 rpm en 5.ª).
- No mezclar dos días o turnos: si el motor estuvo apagado más de 1 hora, empieza un viaje nuevo. Las paradas de venta (10–20 min) siguen en el mismo viaje.
- No perder km ni litros por cortes cortos de Bluetooth (hasta 3 min se rellenan con un promedio).
- No dejar de pedir un dato porque no contestó con el motor apagado (si las RPM tampoco contestan, no cuenta). Si no, el km/L queda en «--» al volver a arrancar.
- No dar por conectada la camioneta si la respuesta al inicio no trae «4100» (puede ser una respuesta atrasada de antes del corte).
- No inventar consumo en diésel sin el dato de la ECU.
- No usar la "carga del motor" para decidir "a fondo" si hay dato del pedal.

## Cómo se comprueba
- `npm test` (todas deben pasar; nunca cambiar una prueba para que pase).
- Modo Demo en el navegador: carga sin errores en la consola.
- Parada en la Demo: `__obd.sim().engineOff = true` (motor apagado) y además `closed = true` + `onDisconnect()` (corte de Bluetooth). Al poner `engineOff = false` debe volver el km/L con todos los PIDs.
- Cada versión: subir `APP_VERSION` (js/app.js), `data-v` y `?v=` en index.html, y `CACHE` en sw.js.
