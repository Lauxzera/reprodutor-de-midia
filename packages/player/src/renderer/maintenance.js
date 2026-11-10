'use strict';

// Menu de manutenção (Ctrl+Shift+M), protegido por senha. Todas as ações são revalidadas no processo principal.
(() => {
  const api = window.playerApi;
  const root = document.getElementById('maint');
  let token = null;

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c != null) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return node;
  }

  const isOpen = () => !root.classList.contains('hidden');

  function close() {
    token = null;
    root.classList.add('hidden');
    document.body.classList.remove('maint-open');
    root.replaceChildren();
  }

  function open() {
    if (isOpen()) return;
    document.body.classList.add('maint-open');
    root.classList.remove('hidden');
    showLogin();
  }

  const box = (...children) => root.replaceChildren(el('div', { class: 'box' }, ...children));
  const secs = (ms) => Math.ceil(ms / 1000);

  async function showLogin(message = '') {
    const st = await api.maint.status();
    const first = !st.hasPassword;
    const pass = el('input', { type: 'password', placeholder: first ? 'Nova senha (mín. 4 caracteres)' : 'Senha de manutenção', autocomplete: 'off' });
    const confirm = first ? el('input', { type: 'password', placeholder: 'Repita a senha', autocomplete: 'off' }) : null;
    const msg = el('div', { class: 'msg' }, message || (st.lockedMs ? `Bloqueado por ${secs(st.lockedMs)} s` : ''));

    const submit = async () => {
      msg.textContent = '';
      if (first) {
        if (pass.value !== confirm.value) {
          msg.textContent = 'As senhas não conferem';
          return;
        }
        const r = await api.maint.setPassword(pass.value);
        if (!r.ok) {
          msg.textContent = r.error;
          return;
        }
      }
      const auth = await api.maint.auth(pass.value);
      if (!auth.ok) {
        msg.textContent = auth.retryAfterMs ? `${auth.error}. Tente de novo em ${secs(auth.retryAfterMs)} s` : auth.error;
        pass.value = '';
        pass.focus();
        return;
      }
      token = auth.token;
      showMenu();
    };

    box(
      el('h1', {}, 'Manutenção'),
      el('p', {}, first ? 'Defina a senha de manutenção deste player.' : 'Digite a senha para continuar.'),
      pass,
      confirm,
      msg,
      el('div', { class: 'row' }, el('button', { class: 'primary', onclick: submit }, first ? 'Definir e entrar' : 'Entrar'), el('button', { onclick: close }, 'Cancelar')),
    );
    for (const input of [pass, confirm]) {
      if (input) input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
    }
    pass.focus();
  }

  async function showConfig() {
    const cur = await api.maint.getConfig(token);
    if (!cur.ok) return showLogin('Sessão expirada. Digite a senha novamente.');

    const baseUrl = el('input', { type: 'text', placeholder: 'https://meu-bucket.s3.us-west-004.backblazeb2.com', value: cur.baseUrl || '' });
    const screenId = el('input', { type: 'text', placeholder: 'loja', value: cur.screenId || '' });
    const poll = el('input', { type: 'number', min: '5', max: '3600', value: String(cur.pollSeconds || 60) });
    const keyId = el('input', { type: 'text', placeholder: 'keyID da chave SOMENTE LEITURA (bucket privado)', value: cur.keyId || '' });
    const secret = el('input', { type: 'password', placeholder: cur.hasSecret ? '(mantida; digite para trocar)' : 'applicationKey da chave somente leitura' });
    const msg = el('div', { class: 'msg' });

    // Aceita colar o bloco JSON que o painel mostra na aba Publicar.
    baseUrl.addEventListener('input', () => {
      const text = baseUrl.value.trim();
      if (!text.startsWith('{')) return;
      try {
        const j = JSON.parse(text);
        baseUrl.value = j.baseUrl || '';
        if (j.screenId) screenId.value = j.screenId;
        if (j.pollSeconds) poll.value = String(j.pollSeconds);
        if (j.keyId) keyId.value = j.keyId;
        if (j.secretKey) secret.value = j.secretKey;
        msg.textContent = 'Campos preenchidos a partir do JSON colado.';
      } catch {
        /* ainda digitando */
      }
    });

    const save = async () => {
      const r = await api.maint.saveConfig(token, { baseUrl: baseUrl.value, screenId: screenId.value, pollSeconds: Number(poll.value), keyId: keyId.value, secretKey: secret.value });
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão expirada. Digite a senha novamente.');
      msg.textContent = r.ok ? r.message : r.error;
    };

    box(
      el('h1', {}, 'Conexão com o bucket'),
      el('p', {}, 'Cole aqui o JSON da aba Publicar do painel ou preencha os campos.'),
      el('label', {}, 'URL do bucket (pública, ou https://s3.<região>.backblazeb2.com/<bucket> se privado)', baseUrl),
      el('label', {}, 'keyID de leitura (só bucket privado)', keyId),
      el('label', {}, 'applicationKey de leitura', secret),
      el('label', {}, 'ID da tela', screenId),
      el('label', {}, 'Consultar a cada (segundos)', poll),
      msg,
      el('div', { class: 'row' }, el('button', { class: 'primary', onclick: save }, 'Salvar e reiniciar'), el('button', { onclick: () => showMenu() }, 'Voltar')),
    );
    baseUrl.focus();
  }

  async function showMenu(message = '') {
    const info = await api.maint.info(token);
    if (!info.ok) return showLogin('Sessão expirada. Digite a senha novamente.');
    const s = info.snapshot;
    const st = s.status || {};
    const msg = el('div', { class: 'msg' }, message);

    const run = (action, confirmText) => async () => {
      if (confirmText && !window.confirm(confirmText)) return;
      const r = await api.maint.action(token, action);
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão expirada. Digite a senha novamente.');
      if (action === 'sync') return showMenu(r.message);
      msg.textContent = r.ok ? r.message : r.error;
    };

    box(
      el('h1', {}, 'Manutenção'),
      el(
        'p',
        {},
        `Tela: ${s.screenId || '—'} · revisão ${s.revision ?? '—'} · ${s.playableCount}/${s.itemCount} itens no disco · sync: ${st.state}${st.message ? ` (${st.message})` : ''} · última: ${st.lastSyncAt || '—'}`,
      ),
      el('pre', {}, info.log || '(log vazio)'),
      msg,
      el(
        'div',
        { class: 'row' },
        el('button', { class: 'primary', onclick: run('sync') }, 'Sincronizar agora'),
        el('button', { onclick: showConfig }, 'Configurar conexão'),
        el('button', { onclick: run('open-folder') }, 'Abrir pasta de dados'),
        el('button', { onclick: run('restart', 'Reiniciar o player?') }, 'Reiniciar'),
        el('button', { class: 'danger', onclick: run('quit', 'Encerrar o player? A TV ficará sem conteúdo.') }, 'Sair do player'),
        el('button', { onclick: close }, 'Fechar'),
      ),
    );
  }

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'm') {
      e.preventDefault();
      isOpen() ? close() : open();
    } else if (e.key === 'Escape' && isOpen()) {
      close();
    }
  });

  window.__openMaint = open; // usado nos testes automatizados
})();
