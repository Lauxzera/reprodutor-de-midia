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

  const AUTO_START_SECS = 60; // sem mexer no painel, a reprodução começa sozinha depois disso
  let view = ''; // 'home' enquanto a tela inicial está aberta
  let afterLogin = null; // o que fazer depois de digitar a senha
  let countdownTimer = null;
  let secsLeft = AUTO_START_SECS;
  let countdownEl = null;
  let progressEl = null;
  let homeMsg = '';
  let msgEl = null;
  const setMsg = (t) => {
    homeMsg = t;
    if (msgEl) msgEl.textContent = t;
  };
  let busy = false; // baixando a atualização: não redesenha a tela

  const isOpen = () => !root.classList.contains('hidden');
  const hold = (h) => window.__hold && window.__hold(h);

  function stopCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = null;
    countdownEl = null;
  }

  function close() {
    token = null;
    view = '';
    afterLogin = null;
    progressEl = null;
    stopCountdown();
    root.classList.add('hidden');
    document.body.classList.remove('maint-open');
    root.replaceChildren();
    hold(false);
  }

  // Abre a tela inicial (mídias, conexão, atualização e configurações). A senha só é pedida ao mexer em algo.
  function open() {
    if (isOpen()) return;
    document.body.classList.add('maint-open');
    root.classList.remove('hidden');
    hold(true);
    homeMsg = '';
    secsLeft = AUTO_START_SECS;
    busy = false;
    showHome();
  }

  const box = (...children) => root.replaceChildren(el('div', { class: 'box' }, ...children));
  const secs = (ms) => Math.ceil(ms / 1000);
  const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
  const STATE_LABEL = { online: 'Conectado', idle: 'Conectado', offline: 'Sem conexão', error: 'Com erro', downloading: 'Baixando mídias', checking: 'Verificando' };

  // Pede a senha (se ainda não houver sessão) e depois roda `next`.
  // `rerender`: depois da senha, redesenha o painel antes de rodar a ação (a ação escreve mensagens/progresso nele).
  const needAuth = (next, rerender = false) => () => (token ? next() : showLogin('', rerender ? async () => (await showHome(), next()) : next));

  async function showLogin(message = '', next = null) {
    if (next) afterLogin = next;
    view = 'login';
    stopCountdown();
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
      const go = afterLogin || showHome;
      afterLogin = null;
      go();
    };

    box(
      el('h1', {}, 'Manutenção'),
      el('p', {}, first ? 'Defina a senha de manutenção deste player.' : 'Digite a senha para continuar.'),
      pass,
      confirm,
      msg,
      el('div', { class: 'row' }, el('button', { class: 'primary', onclick: submit }, first ? 'Definir e entrar' : 'Entrar'), el('button', { onclick: () => ((afterLogin = null), showHome()) }, 'Cancelar')),
    );
    for (const input of [pass, confirm]) {
      if (input) input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
    }
    pass.focus();
  }

  async function showHome(message) {
    if (message !== undefined) homeMsg = message;
    view = 'home';
    stopCountdown();
    progressEl = null;
    const s = await api.getState();
    if (view !== 'home') return; // o usuário já foi para outra tela
    const st = s.status || {};
    const up = s.update;
    const problems = window.__problems || new Map();
    const msg = el('div', { class: 'msg' }, homeMsg);
    msgEl = msg;

    const run = (action, confirmText) => async () => {
      if (confirmText && !window.confirm(confirmText)) return;
      const r = await api.maint.action(token, action);
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão expirada. Digite a senha novamente.');
      if (action === 'minimize' || action === 'windows-settings') {
        if (r.ok) return close();
      }
      showHome(r.ok ? r.message : r.error);
    };

    const checkUpdates = async () => {
      setMsg('Verificando atualizações…');
      const r = await api.maint.updateCheck(token);
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão expirada. Digite a senha novamente.');
      showHome(r.ok ? (r.info.newer ? `Nova versão disponível: v${r.info.latest}.` : `Já está na versão mais recente (v${r.info.current}).`) : `Não consegui verificar: ${r.error}`);
    };

    const doUpdate = async () => {
      if (!window.confirm(`Atualizar para a v${up.latest}? O player baixa, fecha, instala e reabre sozinho (cerca de um minuto; a TV fica sem imagem nesse tempo).`)) return;
      setMsg('Baixando a atualização… 0%');
      if (progressEl) progressEl.value = 0;
      busy = true;
      const r = await api.maint.updateInstall(token);
      if (!r.ok) busy = false;
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão expirada. Digite a senha novamente.');
      setMsg(r.ok ? r.message : r.error);
    };

    const cards = (s.media || []).map((m) => {
      const why = problems.get(m.id);
      const thumb = m.src ? el('img', { src: m.src, alt: '' }) : m.type === 'video' ? 'VÍDEO' : m.present ? 'IMAGEM' : 'baixando…';
      return el(
        'div',
        { class: why ? 'card bad' : 'card' },
        el('div', { class: 'thumb' }, thumb),
        el('div', { class: 'meta' }, el('b', {}, m.name), `${m.type === 'video' ? 'vídeo' : 'imagem'} · ${fmtSize(m.size)}${m.type === 'image' && m.durationSec ? ` · ${m.durationSec} s` : ''}`, !m.present ? el('div', {}, 'ainda não baixado') : null, why ? el('div', { class: 'err' }, why.includes('HEVC') ? 'HEVC: não reproduz; converta para H.264' : why) : null),
      );
    });

    const connLabel = !s.configured ? 'Não configurado' : STATE_LABEL[st.state] || st.state || '—';
    const connClass = !s.configured || st.state === 'error' || st.state === 'offline' ? 'pill warn' : 'pill ok';
    const hasUp = up && up.newer;
    if (hasUp) progressEl = el('progress', { max: '100', value: '0' });
    countdownEl = el('div', { class: 'msg' });

    root.replaceChildren(
      el(
        'div',
        { class: 'box wide' },
        el('h1', {}, 'Reprodutor Player'),
        el(
          'div',
          { class: 'info' },
          el('div', { class: connClass }, 'Conexão com o admin', el('b', {}, connLabel), st.message && st.state === 'error' ? st.message : `Tela: ${s.screenId || '—'} · revisão ${s.revision ?? '—'}`),
          el('div', { class: 'pill' }, 'Última sincronização', el('b', {}, st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString('pt-BR') : '—'), `${s.playableCount}/${s.itemCount} mídias no disco`),
          el('div', { class: hasUp ? 'pill warn' : 'pill' }, 'Versão', el('b', {}, `v${s.version || (up && up.current) || '—'}`), hasUp ? `v${up.latest} disponível` : 'Sem atualização pendente'),
        ),
        el('div', {}, `Mídias baixadas (${cards.length})`),
        cards.length ? el('div', { class: 'grid' }, ...cards) : el('p', {}, s.configured ? 'Nenhuma mídia publicada ainda.' : 'Player não configurado. Clique em "Conexão com o admin" e cole o código de pareamento.'),
        hasUp ? el('div', {}, progressEl) : null,
        msg,
        el(
          'div',
          { class: 'row' },
          el('button', { class: 'primary', onclick: close }, 'Iniciar reprodução'),
          hasUp ? el('button', { class: 'primary', onclick: needAuth(doUpdate, true) }, `Atualizar para v${up.latest}`) : null,
          el('button', { onclick: needAuth(run('sync'), true) }, 'Sincronizar agora'),
          el('button', { onclick: needAuth(showDisplay) }, 'Exibição'),
          el('button', { onclick: needAuth(showConfig) }, 'Conexão com o admin'),
          el('button', { onclick: needAuth(checkUpdates, true) }, 'Verificar atualizações'),
          el('button', { onclick: needAuth(run('minimize'), true) }, 'Minimizar o player'),
          el('button', { onclick: needAuth(run('windows-settings'), true) }, 'Configurações do Windows'),
          el('button', { onclick: needAuth(() => showMenu()) }, 'Mais opções'),
        ),
        countdownEl,
      ),
    );

    // Sem ninguém mexendo, a reprodução começa sozinha (a TV não fica parada no painel depois de um reinício).
    if (!token && s.playableCount > 0) {
      const label = () => (countdownEl.textContent = `A reprodução começa sozinha em ${secsLeft} s se ninguém mexer aqui.`);
      label();
      countdownTimer = setInterval(() => {
        secsLeft -= 1;
        if (secsLeft <= 0) return close();
        if (countdownEl) label();
      }, 1000);
    }
  }

  async function showDisplay() {
    view = 'sub';
    stopCountdown();
    const s = await api.getState();
    const d = s.display || { fit: 'auto', rotate: 0, volume: 100 };
    const fit = el('select', {}, el('option', { value: 'auto' }, 'Seguir a playlist'), el('option', { value: 'contain' }, 'Mostrar inteira (barras pretas)'), el('option', { value: 'cover' }, 'Preencher a tela (corta as bordas)'), el('option', { value: 'fill' }, 'Esticar'));
    fit.value = d.fit;
    const rotate = el('select', {}, ...[0, 90, 180, 270].map((g) => el('option', { value: String(g) }, `${g}°`)));
    rotate.value = String(d.rotate);
    const volume = el('input', { type: 'range', min: '0', max: '100', step: '5' });
    volume.value = String(d.volume);
    const volLabel = el('span', {}, `${d.volume}%`);
    volume.addEventListener('input', () => (volLabel.textContent = `${volume.value}%`));
    const msg = el('div', { class: 'msg' });
    const save = async () => {
      const r = await api.maint.setDisplay(token, { fit: fit.value, rotate: Number(rotate.value), volume: Number(volume.value) });
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão expirada. Digite a senha novamente.', showDisplay);
      msg.textContent = r.ok ? r.message : r.error;
    };
    box(
      el('h1', {}, 'Exibição'),
      el('p', {}, 'Vale só para este player e se aplica na hora.'),
      el('label', {}, 'Ajuste da imagem', fit),
      el('label', {}, 'Rotação da tela', rotate),
      el('label', {}, 'Volume', volume, volLabel),
      msg,
      el('div', { class: 'row' }, el('button', { class: 'primary', onclick: save }, 'Salvar'), el('button', { onclick: () => showHome('') }, 'Voltar')),
    );
  }

  async function showConfig() {
    view = 'sub';
    stopCountdown();
    const cur = await api.maint.getConfig(token);
    if (!cur.ok) return showLogin('Sessão expirada. Digite a senha novamente.');

    const code = el('textarea', { rows: '3', placeholder: 'Cole aqui o código de pareamento (começa com RM1-). Ele está na aba Publicar do painel.' });
    const status = el('div', { class: 'msg' });
    const screenSel = el('select', {});
    const screenId = el('input', { type: 'text', placeholder: 'ou digite o ID da tela', value: cur.screenId || '' });
    const poll = el('input', { type: 'number', min: '5', max: '3600', value: String(cur.pollSeconds || 120) });
    const baseUrl = el('input', { type: 'text', placeholder: 'https://s3.<região>.backblazeb2.com/<bucket>', value: cur.baseUrl || '' });
    const keyId = el('input', { type: 'text', placeholder: 'keyID da chave SOMENTE LEITURA', value: cur.keyId || '' });
    const secret = el('input', { type: 'password', placeholder: cur.hasSecret ? '(mantida; digite para trocar)' : 'applicationKey da chave somente leitura' });
    const msg = el('div', { class: 'msg' });
    let paired = false; // credenciais do código estão guardadas no processo principal

    const fillScreens = (ids, keep) => {
      screenSel.replaceChildren(el('option', { value: '' }, ids.length ? 'Escolha a tela…' : 'Nenhuma tela publicada ainda'), ...ids.map((id) => el('option', { value: id }, id)));
      const want = keep || screenId.value;
      if (want && ids.includes(want)) screenSel.value = want;
      else if (ids.length === 1) screenSel.value = ids[0];
      if (screenSel.value) screenId.value = screenSel.value;
    };
    screenSel.addEventListener('change', () => {
      if (screenSel.value) screenId.value = screenSel.value;
    });
    fillScreens(cur.screens || []);

    const refreshScreens = async () => {
      const r = await api.maint.listScreens(token);
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão expirada. Digite a senha novamente.');
      if (r.ok) {
        fillScreens(r.screens);
        status.textContent = r.screens.length ? `${r.screens.length} tela(s) publicada(s).` : 'Nenhuma tela publicada ainda: publique pelo painel e clique em "Atualizar lista".';
      } else {
        status.textContent = r.error;
      }
    };

    // Colar o código de pareamento: valida e já busca as telas publicadas.
    const applyCode = async () => {
      const text = code.value.trim();
      if (text.length < 12) return;
      const r = await api.maint.applyPair(token, text);
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão expirada. Digite a senha novamente.');
      if (!r.ok) {
        paired = false;
        status.textContent = r.error;
        return;
      }
      paired = true;
      baseUrl.value = r.baseUrl;
      keyId.value = r.keyId;
      secret.value = '';
      poll.value = String(r.pollSeconds);
      fillScreens(r.screens);
      status.textContent = r.screensError ? `Código aceito, mas não consegui listar as telas: ${r.screensError}` : r.screens.length ? `Código aceito. ${r.screens.length} tela(s) publicada(s): escolha abaixo.` : 'Código aceito. Nenhuma tela publicada ainda: publique pelo painel e clique em "Atualizar lista".';
    };
    code.addEventListener('input', applyCode);
    const pasteCode = async () => {
      const r = await api.maint.paste(token);
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão expirada. Digite a senha novamente.');
      if (!r.ok) {
        status.textContent = r.error;
        return;
      }
      code.value = r.text;
      await applyCode();
    };

    // Compatibilidade: ainda aceita colar o JSON antigo no campo da URL.
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
      const payload = paired
        ? { usePair: true, screenId: screenId.value, pollSeconds: Number(poll.value) }
        : { baseUrl: baseUrl.value, screenId: screenId.value, pollSeconds: Number(poll.value), keyId: keyId.value, secretKey: secret.value };
      const r = await api.maint.saveConfig(token, payload);
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão expirada. Digite a senha novamente.');
      msg.textContent = r.ok ? r.message : r.error;
    };

    box(
      el('h1', {}, 'Conexão com o bucket'),
      el('p', {}, 'Cole o código de pareamento do painel e escolha a tela. Só isso.'),
      el('div', { class: 'row' }, el('button', { class: 'primary', onclick: pasteCode }, 'Colar código copiado')),
      el('label', {}, 'Código de pareamento', code),
      status,
      el('label', {}, 'Tela', screenSel),
      el('div', { class: 'row' }, el('button', { onclick: refreshScreens }, 'Atualizar lista')),
      el('label', {}, 'Consultar a cada (segundos)', poll),
      el('details', {}, el('summary', {}, 'Avançado: preencher à mão'), el('label', {}, 'URL do bucket', baseUrl), el('label', {}, 'keyID de leitura', keyId), el('label', {}, 'applicationKey de leitura', secret), el('label', {}, 'ID da tela', screenId)),
      msg,
      el('div', { class: 'row' }, el('button', { class: 'primary', onclick: save }, 'Salvar e reiniciar'), el('button', { onclick: () => showHome('') }, 'Voltar')),
    );
    code.focus();
  }

  async function showMenu(message = '') {
    view = 'sub';
    stopCountdown();
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

    const up = s.update;
    const checkUpdates = async () => {
      msg.textContent = 'Verificando atualizações…';
      const r = await api.maint.updateCheck(token);
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão expirada. Digite a senha novamente.');
      showMenu(r.ok ? (r.info.newer ? `Nova versão disponível: v${r.info.latest}.` : `Já está na versão mais recente (v${r.info.current}).`) : `Não consegui verificar: ${r.error}`);
    };
    const doUpdate = async () => {
      if (!window.confirm(`Atualizar para a v${up.latest}? O player baixa, fecha, instala e reabre sozinho (cerca de um minuto; a TV fica sem imagem nesse tempo).`)) return;
      msg.textContent = 'Baixando a atualização…';
      const r = await api.maint.updateInstall(token);
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão expirada. Digite a senha novamente.');
      msg.textContent = r.ok ? r.message : r.error;
    };

    // Minimizar: fecha o menu (e a sessão) e esconde a janela; o player volta sozinho depois de alguns minutos.
    const minimize = (action) => async () => {
      const r = await api.maint.action(token, action);
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão expirada. Digite a senha novamente.');
      if (r.ok) close();
      else msg.textContent = r.error;
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
      up && up.newer ? el('p', { class: 'msg' }, `Nova versão disponível: v${up.latest} (instalada: v${up.current}).`) : null,
      el(
        'div',
        { class: 'row' },
        up && up.newer ? el('button', { class: 'primary', onclick: doUpdate }, `Atualizar para v${up.latest}`) : null,
        el('button', { class: up && up.newer ? '' : 'primary', onclick: run('sync') }, 'Sincronizar agora'),
        el('button', { onclick: checkUpdates }, 'Verificar atualizações'),
        el('button', { onclick: showConfig }, 'Configurar conexão'),
        el('button', { onclick: minimize('minimize') }, 'Minimizar o player'),
        el('button', { onclick: minimize('windows-settings') }, 'Configurações do Windows'),
        el('button', { onclick: run('open-folder') }, 'Abrir pasta de dados'),
        el('button', { onclick: run('restart', 'Reiniciar o player?') }, 'Reiniciar'),
        el('button', { class: 'danger', onclick: run('quit', 'Encerrar o player? A TV ficará sem conteúdo.') }, 'Sair do player'),
        el('button', { onclick: () => showHome('') }, 'Voltar ao painel'),
        el('button', { onclick: close }, 'Fechar'),
      ),
    );
  }

  // Mexer no painel adia o início automático da reprodução.
  const bump = () => {
    secsLeft = AUTO_START_SECS;
  };
  window.addEventListener('mousemove', bump);
  window.addEventListener('click', bump);

  window.addEventListener('keydown', (e) => {
    bump();
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'm') {
      e.preventDefault();
      isOpen() ? close() : open();
    } else if (e.key === 'Escape' && isOpen()) {
      close();
    }
  });

  // Botão ⚙ no canto superior direito: sempre presente, com opacidade bem baixa (10%) para não atrapalhar o vídeo; sobe a 100% ao passar o mouse.
  const corner = document.getElementById('corner');
  let cursorTimer = null;
  window.addEventListener('mousemove', (e) => {
    document.body.classList.add('show-cursor');
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => document.body.classList.remove('show-cursor'), 3000);
  });
  corner.addEventListener('click', () => open());

  // Andamento do download da atualização (aparece na linha de mensagem do menu).
  if (api.onUpdateProgress) {
    api.onUpdateProgress((p) => {
      const m = root.querySelector('.msg');
      if (m) m.textContent = `Baixando a atualização… ${Math.round(p * 100)}%`;
      if (progressEl) progressEl.value = Math.round(p * 100);
    });
  }

  // Mudanças do sync (mídia baixada, status) atualizam a tela inicial enquanto ela está aberta.
  if (api.onChanged) api.onChanged(() => view === 'home' && !busy && showHome());

  // Ao ligar, o Player abre direto no painel; a reprodução começa sozinha em 60 s ou ao clicar em "Iniciar reprodução".
  open();

  window.__openMaint = open; // usado nos testes automatizados
})();
