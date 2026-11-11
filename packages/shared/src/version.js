'use strict';

// Comparação de versões (sem dependências do Node: usada também pelo painel web).

const parseVersion = (v) => String(v || '0').replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);

/** >0 se a > b. */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

module.exports = { compareVersions };
