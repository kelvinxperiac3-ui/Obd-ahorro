// Cola de comandos ELM327 sobre cualquier transporte con write(str) y onData.
// Cada comando espera el prompt '>' del adaptador.

export class Elm327 {
  constructor(transport, log = () => {}) {
    this.t = transport;
    this.log = log;
    this.buf = '';
    this.pending = null;
    this.queue = Promise.resolve();
    this.t.onData = (s) => this._onData(s);
  }

  _onData(s) {
    this.buf += s;
    const i = this.buf.indexOf('>');
    if (i < 0 || !this.pending) return;
    const raw = this.buf.slice(0, i);
    this.buf = this.buf.slice(i + 1);
    const p = this.pending;
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve(cleanLines(raw, p.cmd));
  }

  send(cmd, timeout = 2500) {
    const run = () => new Promise((resolve, reject) => {
      this.buf = '';
      this.pending = {
        cmd,
        resolve,
        timer: setTimeout(() => {
          this.pending = null;
          reject(new Error(`Sin respuesta a ${cmd}`));
        }, timeout),
      };
      this.t.write(cmd + '\r').catch((e) => {
        clearTimeout(this.pending?.timer);
        this.pending = null;
        reject(e);
      });
    });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async init() {
    const steps = [
      ['ATZ', 4000],
      ['ATE0'], ['ATL0'], ['ATS0'], ['ATH0'], ['ATAT1'], ['ATSP0'],
    ];
    let version = '';
    for (const [cmd, to] of steps) {
      const r = await this.send(cmd, to);
      this.log(`${cmd} → ${r.join(' | ')}`);
      if (cmd === 'ATZ') version = r.find((l) => /ELM/i.test(l)) || r.join(' ');
    }
    // 0100 obliga a buscar el protocolo del vehículo (puede tardar).
    const r = await this.send('0100', 15000);
    this.log(`0100 → ${r.join(' | ')}`);
    if (r.some((l) => /UNABLE|ERROR|NO DATA/i.test(l))) {
      throw new Error('El adaptador no logra hablar con la camioneta. ¿Está el contacto en ON?');
    }
    let protocol = '';
    try { protocol = (await this.send('ATDPN')).join(''); } catch { /* opcional */ }
    return { version, protocol, first: r };
  }
}

export function cleanLines(raw, cmd) {
  return raw
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l && l !== cmd && !/^SEARCHING/i.test(l) && !/^BUS INIT/i.test(l));
}
