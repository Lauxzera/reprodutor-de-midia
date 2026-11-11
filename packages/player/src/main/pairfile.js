'use strict';

// Pareamento por arquivo: um `pair.txt` com o código de pareamento (da aba Publicar do admin), colocado na pasta de dados,
// em Downloads ou na raiz de um pendrive, configura um Player ainda sem conexão sem digitar nada.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { decodePair, isPairCode } = require('@reprodutor/shared');

/** Pastas onde procurar o pair.txt (a pasta de dados primeiro; depois Downloads e as raízes de D: a Z:). */
function candidateFiles({ dataDir, home = os.homedir(), drives = true, platform = process.platform } = {}) {
  const list = [path.join(dataDir, 'pair.txt'), path.join(home, 'Downloads', 'pair.txt'), path.join(home, 'Desktop', 'pair.txt')];
  if (drives && platform === 'win32') for (let c = 68; c <= 90; c++) list.push(`${String.fromCharCode(c)}:\\pair.txt`);
  return list;
}

/** Primeiro pair.txt com um código válido: { file, code, pair } ou null. */
function findPairFile(opts = {}) {
  for (const file of candidateFiles(opts)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const code = text.replace(/\s+/g, '').replace(/^﻿/, '');
    if (!isPairCode(code)) continue;
    try {
      return { file, code, pair: decodePair(code) };
    } catch {
      /* código corrompido: tenta o próximo */
    }
  }
  return null;
}

/** Grava as credenciais do código no config.json (mantém o que já existir). Devolve o novo config. */
function writePairConfig(configFile, pair) {
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    /* config novo */
  }
  const next = { ...cur, baseUrl: pair.baseUrl, pollSeconds: pair.pollSeconds, keyId: pair.keyId, region: pair.region };
  if (pair.secretKey) next.secretKey = pair.secretKey;
  else delete next.secretKey;
  fs.writeFileSync(configFile, JSON.stringify(next, null, 2));
  return next;
}

module.exports = { candidateFiles, findPairFile, writePairConfig };
