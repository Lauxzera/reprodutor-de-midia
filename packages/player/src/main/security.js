'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Senha de manutenção do player (para sair, reiniciar, ver logs).
 * Guardada como hash scrypt em <dataDir>/security.json. Apagar esse arquivo no PC redefine a senha.
 * Após 5 erros seguidos, bloqueia novas tentativas por 30 s.
 */
class Security {
  constructor(dir, { now = Date.now, maxFailures = 5, lockMs = 30000, tokenMs = 12 * 60 * 60 * 1000 } = {}) {
    this.file = path.join(dir, 'security.json');
    this.now = now;
    this.maxFailures = maxFailures;
    this.lockMs = lockMs;
    this.tokenMs = tokenMs;
    this.failures = 0;
    this.lockedUntil = 0;
    this.tokens = new Map();
  }

  hasPassword() {
    return fs.existsSync(this.file);
  }

  lockedMs() {
    return Math.max(0, this.lockedUntil - this.now());
  }

  setPassword(password) {
    if (this.hasPassword()) return { ok: false, error: 'Senha já definida' };
    if (typeof password !== 'string' || password.length < 4) return { ok: false, error: 'Use ao menos 4 caracteres' };
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 32);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ salt: salt.toString('hex'), hash: hash.toString('hex') }));
    return { ok: true };
  }

  verify(password) {
    if (!this.hasPassword()) return { ok: false, error: 'Senha ainda não definida' };
    const t = this.now();
    if (t < this.lockedUntil) return { ok: false, error: 'Muitas tentativas', retryAfterMs: this.lockedUntil - t };

    let ok = false;
    try {
      const { salt, hash } = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const given = crypto.scryptSync(String(password || ''), Buffer.from(salt, 'hex'), 32);
      ok = crypto.timingSafeEqual(given, Buffer.from(hash, 'hex'));
    } catch {
      ok = false;
    }

    if (ok) {
      this.failures = 0;
      const token = crypto.randomBytes(24).toString('hex');
      this.tokens.set(token, t + this.tokenMs);
      return { ok: true, token };
    }
    this.failures++;
    if (this.failures >= this.maxFailures) {
      this.failures = 0;
      this.lockedUntil = t + this.lockMs;
    }
    return { ok: false, error: 'Senha incorreta', retryAfterMs: Math.max(0, this.lockedUntil - t) };
  }

  /** Sessão sem senha (o painel do player é aberto direto, sem login). */
  issueToken() {
    const token = crypto.randomBytes(24).toString('hex');
    this.tokens.set(token, this.now() + this.tokenMs);
    return token;
  }

  /** Token de sessão (renovado a cada uso). */
  checkToken(token) {
    const exp = this.tokens.get(token);
    const t = this.now();
    if (!exp || t > exp) {
      this.tokens.delete(token);
      return false;
    }
    this.tokens.set(token, t + this.tokenMs);
    return true;
  }
}

module.exports = { Security };
