'use strict';

const { buildStatus, statusKey, putJsonSigned, REPORT_EVERY_SEC } = require('@reprodutor/shared');

/**
 * Relatório de status do player: a cada 2 minutos grava status/<tela>.json no bucket
 * (versão, estado, o que está tocando) com uma chave que SÓ grava em status/.
 * Sem chave de status, fica desligado. Falhas nunca afetam a reprodução.
 */
class StatusReporter {
  constructor({ baseUrl, screenId, keyId, secretKey, region, collect, fetch = globalThis.fetch, log = () => {}, everyMs = REPORT_EVERY_SEC * 1000, firstMs = 8000 }) {
    this.url = baseUrl && screenId ? `${String(baseUrl).replace(/\/+$/, '')}/${statusKey(screenId)}` : '';
    this.screenId = screenId;
    this.creds = { keyId, secretKey, region };
    this.collect = collect;
    this.fetch = fetch;
    this.log = log;
    this.everyMs = everyMs;
    this.firstMs = firstMs;
    this.enabled = Boolean(this.url && keyId && secretKey);
    this.lastAt = null;
    this.lastError = '';
    this._timer = null;
    this._stopped = true;
    this._failedBefore = false;
  }

  /** Estado para a tela do painel do player. */
  info() {
    return { enabled: this.enabled, lastAt: this.lastAt, error: this.lastError };
  }

  async report(extra = {}) {
    if (!this.enabled) return false;
    try {
      const body = buildStatus({ screenId: this.screenId, ...this.collect(), ...extra });
      const res = await putJsonSigned(this.fetch, this.url, body, this.creds, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.lastAt = body.reportedAt;
      this.lastError = '';
      if (this._failedBefore) this.log('Relatório de status voltou a funcionar');
      this._failedBefore = false;
      return true;
    } catch (e) {
      this.lastError = e.cause?.code || e.message;
      if (!this._failedBefore) this.log(`Relatório de status falhou (${this.lastError}); segue tentando em silêncio`);
      this._failedBefore = true;
      return false;
    }
  }

  start() {
    if (!this.enabled || !this._stopped) return;
    this._stopped = false;
    const tick = async () => {
      if (this._stopped) return;
      await this.report();
      if (!this._stopped) this._timer = setTimeout(tick, this.everyMs);
    };
    this._timer = setTimeout(tick, this.firstMs);
  }

  /** Envia já (ex.: depois de uma sincronização que mudou a programação). */
  nudge() {
    if (this.enabled && !this._stopped) this.report();
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._timer);
  }
}

module.exports = { StatusReporter };
