'use strict';

// Ponto de entrada do painel web: login local (credenciais criptografadas neste navegador),
// monta o `panelApi` e então carrega a interface (panel.js).

const { createS3, regionFromEndpoint } = require('./s3');
const { createMemoryS3 } = require('./memory-s3');
const { createWebApi } = require('./web-api');
const vault = require('./vault');
const { convertVideo } = require('./convert');

const LS_VAULT = 'rm.vault';
const LS_SETTINGS = 'rm.settings';

const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    localStorage.setItem(k, v);
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignorado */
    }
  },
};

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

const gate = () => document.getElementById('gate');

function showGate(title, ...content) {
  const g = gate();
  g.hidden = false;
  g.replaceChildren(el('div', { class: 'gate-box' }, el('h1', {}, 'Reprodutor de Mídia'), el('p', { class: 'gate-sub' }, title), ...content));
}

const field = (label, input, help) => el('label', { class: 'gate-field' }, el('span', {}, label), input, help ? el('small', {}, help) : null);

function makeStorage(settings, creds) {
  return createS3({ endpoint: settings.endpoint, region: settings.region || regionFromEndpoint(settings.endpoint), bucket: settings.bucket, keyId: creds.keyId, appKey: creds.appKey });
}

// Seletor de arquivos único e permanente (oculto), para a biblioteca.
const fileInput = el('input', { type: 'file', multiple: true, hidden: true, id: 'rm-file-input', accept: 'image/*,video/*,.mp4,.m4v,.mov,.webm' });
document.body.append(fileInput);

function start({ storage, settings, saveSettings, logout, getReadKey }) {
  const api = createWebApi({
    storage,
    settings,
    saveSettings,
    logout,
    getReadKey,
    convertVideo,
    pickFiles: () =>
      new Promise((resolve) => {
        fileInput.value = '';
        fileInput.onchange = () => resolve([...fileInput.files]);
        fileInput.oncancel = () => resolve([]);
        fileInput.click();
      }),
  });
  window.panelApi = api;
  gate().hidden = true;
  const s = document.createElement('script');
  s.src = 'panel.js';
  document.body.append(s);
}

function demo() {
  const settings = { endpoint: 'https://s3.exemplo.backblazeb2.com', region: 'exemplo', bucket: 'demonstracao', privateBucket: true, publicBaseUrl: '' };
  const banner = el('div', { class: 'demo-banner' }, 'Modo demonstração: os dados ficam só na memória desta aba e somem ao fechar.');
  document.body.prepend(banner);
  window.__rm = { convertVideo }; // usado nos testes automatizados do modo demonstração
  let readKey = { keyId: 'LEITURA-DEMO', appKey: 'demo-demo-demo' };
  start({ storage: createMemoryS3(), settings, saveSettings: async (p, _k, rk) => { Object.assign(settings, p); if (rk) readKey = rk; }, logout: async () => location.reload(), getReadKey: () => readKey });
}

function setup() {
  const endpoint = el('input', { type: 'text', placeholder: 'https://s3.us-east-005.backblazeb2.com', autocomplete: 'off' });
  const bucket = el('input', { type: 'text', placeholder: 'nome-do-bucket', autocomplete: 'off' });
  const keyId = el('input', { type: 'text', placeholder: 'keyID da chave de leitura e escrita', autocomplete: 'off' });
  const appKey = el('input', { type: 'password', placeholder: 'applicationKey', autocomplete: 'off' });
  const priv = el('input', { type: 'checkbox', checked: true });
  const pass = el('input', { type: 'password', placeholder: 'mínimo 8 caracteres', autocomplete: 'new-password' });
  const pass2 = el('input', { type: 'password', placeholder: 'repita a senha', autocomplete: 'new-password' });
  const msg = el('p', { class: 'gate-msg' });
  const btn = el('button', { class: 'gate-btn', type: 'submit' }, 'Salvar e entrar');

  const submit = async (ev) => {
    ev.preventDefault();
    msg.textContent = '';
    const settings = { endpoint: endpoint.value.trim().replace(/\/+$/, ''), region: '', bucket: bucket.value.trim(), privateBucket: priv.checked, publicBaseUrl: '' };
    const creds = { keyId: keyId.value.trim(), appKey: appKey.value };
    if (!/^https:\/\//.test(settings.endpoint) || !settings.bucket || !creds.keyId || !creds.appKey) return (msg.textContent = 'Preencha endpoint (https://…), bucket, keyID e applicationKey.');
    if (pass.value.length < 8) return (msg.textContent = 'A senha precisa ter ao menos 8 caracteres.');
    if (pass.value !== pass2.value) return (msg.textContent = 'As senhas não conferem.');
    btn.disabled = true;
    btn.textContent = 'Testando conexão…';
    try {
      const probe = makeStorage(settings, creds);
      await probe.putJson('_ping.json', { at: new Date().toISOString() });
      await probe.delete('_ping.json');
      store.set(LS_VAULT, JSON.stringify(await vault.seal(pass.value, creds)));
      store.set(LS_SETTINGS, JSON.stringify(settings));
      launch(settings, creds, pass.value);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Salvar e entrar';
      msg.textContent = `Não foi possível conectar: ${e.message}`;
    }
  };

  showGate(
    'Primeiro acesso: conecte o seu bucket do Backblaze B2.',
    el(
      'form',
      { onsubmit: submit },
      field('Endpoint S3', endpoint),
      field('Bucket', bucket),
      field('keyID', keyId),
      field('applicationKey', appKey, 'Fica criptografada neste navegador. Use uma chave restrita a este bucket.'),
      el('label', { class: 'gate-check' }, priv, ' Bucket privado (o player lê com uma chave somente de leitura)'),
      field('Senha deste navegador', pass, 'Protege as chaves guardadas aqui. Não é a senha do Backblaze e não é recuperável.'),
      field('Repita a senha', pass2),
      msg,
      btn,
    ),
  );
}

function unlock() {
  const pass = el('input', { type: 'password', placeholder: 'senha deste navegador', autocomplete: 'current-password' });
  const msg = el('p', { class: 'gate-msg' });
  const btn = el('button', { class: 'gate-btn', type: 'submit' }, 'Entrar');
  const submit = async (ev) => {
    ev.preventDefault();
    btn.disabled = true;
    msg.textContent = '';
    try {
      const creds = await vault.open(pass.value, JSON.parse(store.get(LS_VAULT)));
      launch(JSON.parse(store.get(LS_SETTINGS) || '{}'), creds, pass.value);
    } catch (e) {
      btn.disabled = false;
      msg.textContent = e.message;
    }
  };
  showGate(
    'Digite a senha para abrir o painel.',
    el(
      'form',
      { onsubmit: submit },
      field('Senha', pass),
      msg,
      btn,
      el('button', { class: 'gate-link', type: 'button', onclick: () => confirm('Apagar as chaves guardadas neste navegador? Os dados no B2 não são afetados.') && (store.del(LS_VAULT), store.del(LS_SETTINGS), location.reload()) }, 'Esquecer as chaves deste navegador'),
    ),
  );
  pass.focus();
}

function launch(settings, creds, passphrase) {
  let current = makeStorage(settings, creds);
  // O painel guarda uma referência fixa ao storage; este proxy repassa para o cliente atual (muda se as chaves mudarem).
  const storage = new Proxy({}, { get: (_t, k) => (typeof current[k] === 'function' ? (...a) => current[k](...a) : current[k]) });

  const saveSettings = async (patch, keys, readKeys) => {
    Object.assign(settings, patch);
    store.set(LS_SETTINGS, JSON.stringify(settings));
    let changed = false;
    if (keys && keys.keyId && keys.appKey) {
      creds = { ...creds, keyId: keys.keyId, appKey: keys.appKey };
      changed = true;
    }
    if (readKeys && readKeys.keyId && readKeys.appKey) {
      creds = { ...creds, readKeyId: readKeys.keyId, readAppKey: readKeys.appKey };
      changed = true;
    }
    if (changed) store.set(LS_VAULT, JSON.stringify(await vault.seal(passphrase, creds)));
    current = makeStorage(settings, creds);
  };
  const getReadKey = () => (creds.readKeyId && creds.readAppKey ? { keyId: creds.readKeyId, appKey: creds.readAppKey } : null);
  start({ storage, settings, saveSettings, logout: async () => location.reload(), getReadKey });
}

if (new URLSearchParams(location.search).has('demo')) demo();
else if (store.get(LS_VAULT)) unlock();
else setup();
