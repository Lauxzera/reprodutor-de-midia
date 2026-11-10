'use strict';

/**
 * Vigia o renderer. Dispara recarga quando:
 *  - não chegam batimentos (renderer travado ou morto), ou
 *  - o item atual passou do prazo esperado (reprodução emperrada).
 * Se acontecer mais de `maxReloads` vezes na janela `windowMs`, pede reinício do app inteiro.
 */
class Watchdog {
  constructor({ now = Date.now, onReload, onRestart, log = () => {}, maxReloads = 3, windowMs = 10 * 60 * 1000, heartbeatTimeoutMs = 60000 } = {}) {
    this.now = now;
    this.onReload = onReload;
    this.onRestart = onRestart;
    this.log = log;
    this.maxReloads = maxReloads;
    this.windowMs = windowMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.lastHeartbeat = now();
    this.deadline = null;
    this.troubles = [];
    this._timer = null;
  }

  heartbeat() {
    this.lastHeartbeat = this.now();
  }

  /** O renderer começou um item: id e quanto tempo, no máximo, deve levar. id nulo = ocioso. */
  itemStarted({ id, expectedMs } = {}) {
    this.heartbeat();
    this.deadline = id && Number.isFinite(expectedMs) && expectedMs > 0 ? this.now() + expectedMs : null;
  }

  /** Dá um período de carência (ex.: após recarregar a página). */
  reset() {
    this.lastHeartbeat = this.now();
    this.deadline = null;
  }

  check() {
    const t = this.now();
    if (t - this.lastHeartbeat > this.heartbeatTimeoutMs) return this._trouble('renderer sem batimentos');
    if (this.deadline !== null && t > this.deadline) return this._trouble('item da playlist travado');
    return null;
  }

  _trouble(reason) {
    const t = this.now();
    this.troubles = this.troubles.filter((x) => t - x < this.windowMs);
    this.troubles.push(t);
    this.reset();
    if (this.troubles.length > this.maxReloads) {
      this.log(`Watchdog: ${reason}; ${this.troubles.length} falhas em pouco tempo, reiniciando o player`);
      this.troubles = [];
      this.onRestart(reason);
      return 'restart';
    }
    this.log(`Watchdog: ${reason}; recarregando a tela`);
    this.onReload(reason);
    return 'reload';
  }

  start(tickMs = 10000) {
    this.stop();
    this._timer = setInterval(() => this.check(), tickMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }
}

module.exports = { Watchdog };
