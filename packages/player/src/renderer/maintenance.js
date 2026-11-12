'use strict';

// Menu de manutenção (Ctrl+Shift+M), sem senha. Todas as ações são revalidadas no processo principal.
(() => {
  const api = window.playerApi;
  const root = document.getElementById('maint');
  let token = null;

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    // Sem o teclado do Windows: o teclado na tela do Player (vkb.js) cuida da digitação.
    if (tag === 'input' || tag === 'textarea') node.setAttribute('inputmode', 'none');
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c != null) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return node;
  }

  // Grupo de botões grandes (substitui <select>, que é pequeno e ruim no toque).
  function choice(options, value, onpick) {
    const wrap = el('div', { class: 'choice', role: 'group' });
    let cur = value;
    const draw = () =>
      wrap.replaceChildren(
        ...options.map(([v, label]) =>
          el('button', { type: 'button', class: 'opt', 'aria-pressed': String(v === cur), onclick: () => { cur = v; draw(); if (onpick) onpick(v); } }, label),
        ),
      );
    draw();
    return { node: wrap, get: () => cur };
  }

  // Confirmação dentro do próprio painel (botões grandes; o diálogo nativo é pequeno no toque).
  function ask(text, okLabel = 'Confirmar') {
    return new Promise((resolve) => {
      const done = (v) => {
        overlay.remove();
        resolve(v);
      };
      const overlay = el('div', { class: 'modal' }, el('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true' }, el('p', {}, text), el('div', { class: 'row' }, el('button', { class: 'primary', onclick: () => done(true) }, okLabel), el('button', { onclick: () => done(false) }, 'Cancelar'))));
      root.append(overlay);
    });
  }

  const AUTO_START_SECS = 60; // sem mexer no painel, a reprodução começa sozinha depois disso
  let view = ''; // 'home' enquanto a tela inicial está aberta
  let afterLogin = null; // o que fazer depois de renovar a sessão
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

  let kb = null; // teclado na tela (vkb.js)
  const isOpen = () => !root.classList.contains('hidden');
  const hold = (h) => window.__hold && window.__hold(h);

  function stopCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = null;
    countdownEl = null;
  }

  function close() {
    hideKb();
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

  // Abre a tela inicial (mídias, conexão, atualização e configurações).
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

  const hideKb = () => kb && kb.hide();
  const box = (...children) => (hideKb(), root.replaceChildren(el('div', { class: 'box' }, ...children)));
  const secs = (ms) => Math.ceil(ms / 1000);
  const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
  const STATE_LABEL = { online: 'Conectado', idle: 'Conectado', offline: 'Sem conexão', error: 'Com erro', downloading: 'Baixando mídias', checking: 'Verificando' };

  // Sem senha: o painel abre uma sessão local sozinho e roda a ação.
  // `rerender`: redesenha o painel antes da ação (ela escreve mensagens/progresso nele).
  const needAuth = (next, rerender = false) => () => (token ? next() : showLogin('', rerender ? async () => (await showHome(), next()) : next));

  // Mantido por compatibilidade com as chamadas de 'Sessão expirada': renova a sessão em silêncio.
  async function showLogin(message = '', next = null) {
    const r = await api.maint.session();
    token = r.token;
    const go = next || afterLogin || showHome;
    afterLogin = null;
    go();
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
      if (confirmText && !(await ask(confirmText))) return;
      const r = await api.maint.action(token, action);
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão renovada. Tente de novo.');
      if (action === 'minimize' || action === 'windows-settings') {
        if (r.ok) return close();
      }
      showHome(r.ok ? r.message : r.error);
    };

    const checkUpdates = async () => {
      setMsg('Verificando atualizações…');
      const r = await api.maint.updateCheck(token);
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão renovada. Tente de novo.');
      showHome(r.ok ? (r.info.newer ? `Nova versão disponível: v${r.info.latest}.` : `Já está na versão mais recente (v${r.info.current}).`) : `Não consegui verificar: ${r.error}`);
    };

    const doUpdate = async () => {
      if (!(await ask(`Atualizar para a v${up.latest}? O player baixa, fecha, instala e reabre sozinho (cerca de um minuto; a TV fica sem imagem nesse tempo).`, 'Atualizar'))) return;
      setMsg('Baixando a atualização… 0%');
      if (progressEl) progressEl.value = 0;
      busy = true;
      const r = await api.maint.updateInstall(token);
      if (!r.ok) busy = false;
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão renovada. Tente de novo.');
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
    const rep = s.report || {};
    const connClass = !s.configured || st.state === 'error' || st.state === 'offline' ? 'pill warn' : 'pill ok';
    const hasUp = up && up.newer;
    const inWindow = s.windowMode === 'window';
    if (hasUp) progressEl = el('progress', { max: '100', value: '0' });
    countdownEl = el('div', { class: 'msg' });

    const tile = (title, desc, onclick, cls = '') => el('button', { class: `tile ${cls}`.trim(), onclick }, el('b', {}, title), el('span', {}, desc));

    hideKb();
    root.replaceChildren(
      el(
        'div',
        { class: 'box wide' },
        el(
          'div',
          { class: 'winbar' },
          el('h1', {}, 'Reprodutor Player'),
          el('div', { class: 'winbtns' }, el('button', { class: 'winbtn', onclick: needAuth(run('minimize'), true) }, 'Minimizar'), el('button', { class: 'winbtn', onclick: needAuth(run('window-toggle'), true) }, inWindow ? 'Tela cheia' : 'Janela')),
        ),
        el(
          'div',
          { class: 'info' },
          el('div', { class: connClass }, 'Conexão com o admin', el('b', {}, connLabel), st.message && st.state === 'error' ? st.message : `Tela: ${s.screenId || '—'} · revisão ${s.revision ?? '—'}`),
          el('div', { class: 'pill' }, 'Última sincronização', el('b', {}, st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString('pt-BR') : '—'), `${s.playableCount}/${s.itemCount} mídias no disco`),
          el('div', { class: rep.enabled && !rep.error ? 'pill ok' : 'pill' }, 'Relatório ao admin', el('b', {}, rep.enabled ? (rep.lastAt ? 'Enviando' : 'Aguardando') : 'Desligado'), rep.enabled ? (rep.error ? `falha: ${rep.error}` : rep.lastAt ? `último ${new Date(rep.lastAt).toLocaleTimeString('pt-BR')}` : 'primeiro envio em instantes') : 'sem chave de status no código de pareamento'),
          el('div', { class: hasUp ? 'pill warn' : 'pill' }, 'Versão', el('b', {}, `v${s.version || (up && up.current) || '—'}`), hasUp ? `v${up.latest} disponível` : 'Sem atualização pendente'),
        ),
        el('button', { class: 'bigstart', onclick: close }, el('b', {}, 'Iniciar reprodução'), el('span', {}, 'Mostra a programação na tela')),
        hasUp ? tile(`Atualizar para v${up.latest}`, 'Baixa, instala e reabre sozinho', needAuth(doUpdate, true), 'accent') : null,
        hasUp ? el('div', {}, progressEl) : null,
        msg,
        el(
          'div',
          { class: 'tiles' },
          tile('Sincronizar agora', 'Busca mídias e playlist novas', needAuth(run('sync'), true)),
          tile('Conexão com o admin', 'Parear com o código e escolher a tela', needAuth(showConfig)),
          tile('Exibição', 'Ajuste da imagem, rotação e volume', needAuth(showDisplay)),
          tile('Verificar atualizações', 'Procura uma versão nova no GitHub', needAuth(checkUpdates, true)),
          tile('Configurações do Windows', 'Abre o Windows (o player minimiza)', needAuth(run('windows-settings'), true)),
          tile('Mais opções', 'Log, pasta de dados, reiniciar e sair', needAuth(() => showMenu())),
        ),
        el('div', {}, `Mídias baixadas (${cards.length})`),
        cards.length ? el('div', { class: 'grid' }, ...cards) : el('p', {}, s.configured ? 'Nenhuma mídia publicada ainda.' : 'Player não configurado. Toque em "Conexão com o admin" e cole o código de pareamento.'),
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
    const fit = choice([['auto', 'Seguir a playlist'], ['contain', 'Inteira (barras pretas)'], ['cover', 'Preencher (corta as bordas)'], ['fill', 'Esticar']], d.fit);
    const rotate = choice([[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']], Number(d.rotate));
    let vol = d.volume;
    const volLabel = el('b', { class: 'vol' }, `${vol}%`);
    const volume = el('input', { type: 'range', min: '0', max: '100', step: '5', 'aria-label': 'Volume' });
    const setVol = (n) => {
      vol = Math.max(0, Math.min(100, Math.round(n)));
      volume.value = String(vol);
      volLabel.textContent = `${vol}%`;
    };
    volume.value = String(vol);
    volume.addEventListener('input', () => setVol(Number(volume.value)));
    const msg = el('div', { class: 'msg' });
    const save = async () => {
      const r = await api.maint.setDisplay(token, { fit: fit.get(), rotate: Number(rotate.get()), volume: vol });
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão renovada. Tente de novo.', showDisplay);
      msg.textContent = r.ok ? r.message : r.error;
    };
    box(
      el('h1', {}, 'Exibição'),
      el('p', {}, 'Vale só para este player e se aplica na hora.'),
      el('div', { class: 'field' }, el('div', { class: 'lbl' }, 'Ajuste da imagem'), fit.node),
      el('div', { class: 'field' }, el('div', { class: 'lbl' }, 'Rotação da tela'), rotate.node),
      el('div', { class: 'field' }, el('div', { class: 'lbl' }, 'Volume'), el('div', { class: 'row volrow' }, el('button', { type: 'button', 'aria-label': 'Diminuir o volume', onclick: () => setVol(vol - 10) }, '−'), volLabel, el('button', { type: 'button', 'aria-label': 'Aumentar o volume', onclick: () => setVol(vol + 10) }, '+')), volume),
      msg,
      el('div', { class: 'row footbar' }, el('button', { class: 'primary', onclick: save }, 'Salvar'), el('button', { onclick: () => showHome('') }, 'Voltar')),
    );
  }

  async function showConfig() {
    view = 'sub';
    stopCountdown();
    const cur = await api.maint.getConfig(token);
    if (!cur.ok) return showLogin('Sessão renovada. Tente de novo.');

    const code = el('textarea', { rows: '3', placeholder: 'Código de pareamento (começa com RM1-). Está em Conectar TV, no painel do admin.' });
    const status = el('div', { class: 'msg' });
    const screenBox = el('div', { class: 'choice', role: 'group' });
    let pickedScreen = '';
    const screenId = el('input', { type: 'text', placeholder: 'ou digite o ID da tela', value: cur.screenId || '' });
    const poll = el('input', { type: 'number', min: '5', max: '3600', value: String(cur.pollSeconds || 120) });
    const baseUrl = el('input', { type: 'text', placeholder: 'https://s3.<região>.backblazeb2.com/<bucket>', value: cur.baseUrl || '' });
    const keyId = el('input', { type: 'text', placeholder: 'keyID da chave SOMENTE LEITURA', value: cur.keyId || '' });
    const secret = el('input', { type: 'password', placeholder: cur.hasSecret ? '(mantida; digite para trocar)' : 'applicationKey da chave somente leitura' });
    const msg = el('div', { class: 'msg' });
    let paired = false; // credenciais do código estão guardadas no processo principal

    const fillScreens = (ids, keep) => {
      const want = keep || screenId.value;
      if (want && ids.includes(want)) pickedScreen = want;
      else if (ids.length === 1) pickedScreen = ids[0];
      if (pickedScreen) screenId.value = pickedScreen;
      screenBox.replaceChildren(
        ...(ids.length
          ? ids.map((id) => el('button', { type: 'button', class: 'opt', 'aria-pressed': String(id === pickedScreen), onclick: () => { pickedScreen = id; screenId.value = id; fillScreens(ids, id); } }, id))
          : [el('p', {}, 'Nenhuma tela publicada ainda')]),
      );
    };
    fillScreens(cur.screens || []);

    const refreshScreens = async () => {
      const r = await api.maint.listScreens(token);
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão renovada. Tente de novo.');
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
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão renovada. Tente de novo.');
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
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão renovada. Tente de novo.');
      if (!r.ok) {
        status.textContent = r.error;
        return;
      }
      code.value = r.text;
      await applyCode();
    };

    // Sem teclado: procura o pair.txt (pendrive, Downloads, Área de Trabalho) e usa o código que estiver lá.
    const findPair = async () => {
      status.textContent = 'Procurando o pair.txt…';
      const r = await api.maint.findPair(token);
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão renovada. Tente de novo.');
      if (!r.ok) {
        status.textContent = r.error;
        return;
      }
      code.value = r.text;
      await applyCode();
      if (paired) status.textContent = `pair.txt encontrado em ${r.file}. ${status.textContent}`;
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
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão renovada. Tente de novo.');
      msg.textContent = r.ok ? r.message : r.error;
    };

    box(
      el('h1', {}, 'Conexão com o bucket'),
      el('p', {}, 'Use o pair.txt do pendrive ou cole o código de pareamento do painel e escolha a tela.'),
      el('div', { class: 'row' }, el('button', { class: 'primary', onclick: findPair }, 'Procurar pair.txt (pendrive ou Downloads)'), el('button', { onclick: pasteCode }, 'Colar código copiado')),
      el('label', {}, 'Código de pareamento', code),
      status,
      el('div', { class: 'field' }, el('div', { class: 'lbl' }, 'Tela'), screenBox),
      el('div', { class: 'row' }, el('button', { onclick: refreshScreens }, 'Atualizar lista')),
      el('label', {}, 'Consultar a cada (segundos)', poll),
      el('details', {}, el('summary', {}, 'Avançado: preencher à mão'), el('label', {}, 'URL do bucket', baseUrl), el('label', {}, 'keyID de leitura', keyId), el('label', {}, 'applicationKey de leitura', secret), el('label', {}, 'ID da tela', screenId)),
      msg,
      el('div', { class: 'row footbar' }, el('button', { class: 'primary', onclick: save }, 'Salvar e reiniciar'), el('button', { onclick: () => showHome('') }, 'Voltar')),
    );
  }

  async function showMenu(message = '') {
    view = 'sub';
    stopCountdown();
    const info = await api.maint.info(token);
    if (!info.ok) return showLogin('Sessão renovada. Tente de novo.');
    const s = info.snapshot;
    const st = s.status || {};
    const msg = el('div', { class: 'msg' }, message);

    const run = (action, confirmText) => async () => {
      if (confirmText && !(await ask(confirmText))) return;
      const r = await api.maint.action(token, action);
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão renovada. Tente de novo.');
      if (action === 'sync') return showMenu(r.message);
      msg.textContent = r.ok ? r.message : r.error;
    };

    const up = s.update;
    const checkUpdates = async () => {
      msg.textContent = 'Verificando atualizações…';
      const r = await api.maint.updateCheck(token);
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão renovada. Tente de novo.');
      showMenu(r.ok ? (r.info.newer ? `Nova versão disponível: v${r.info.latest}.` : `Já está na versão mais recente (v${r.info.current}).`) : `Não consegui verificar: ${r.error}`);
    };
    const doUpdate = async () => {
      if (!(await ask(`Atualizar para a v${up.latest}? O player baixa, fecha, instala e reabre sozinho (cerca de um minuto; a TV fica sem imagem nesse tempo).`, 'Atualizar'))) return;
      msg.textContent = 'Baixando a atualização…';
      const r = await api.maint.updateInstall(token);
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão renovada. Tente de novo.');
      msg.textContent = r.ok ? r.message : r.error;
    };

    // Minimizar: fecha o menu (e a sessão) e esconde a janela; o player volta sozinho depois de alguns minutos.
    const minimize = (action) => async () => {
      const r = await api.maint.action(token, action);
      if (!r.ok && r.error === 'Sessão expirada') return showLogin('Sessão renovada. Tente de novo.');
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

  // Mexer no painel adia o início automático da reprodução. Parado por 3 minutos em qualquer tela,
  // o painel fecha e a reprodução volta (um totem sem ninguém por perto nunca fica parado nas configurações).
  const IDLE_CLOSE_MS = window.__IDLE_MS || 180000;
  let lastTouch = Date.now();
  const bump = () => {
    secsLeft = AUTO_START_SECS;
    lastTouch = Date.now();
  };
  const watchIdle = () => {
    const t = setTimeout(() => {
      if (isOpen() && !busy && Date.now() - lastTouch > IDLE_CLOSE_MS) close();
      watchIdle();
    }, window.__IDLE_POLL_MS || 5000);
    if (t && t.unref) t.unref();
  };
  watchIdle();
  window.addEventListener('mousemove', bump);
  window.addEventListener('click', bump);
  window.addEventListener('pointerdown', bump);
  window.addEventListener('touchstart', bump);

  window.addEventListener('keydown', (e) => {
    bump();
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'm') {
      e.preventDefault();
      isOpen() ? close() : open();
    } else if (e.key === 'Escape' && isOpen()) {
      close();
    }
  });

  // Botão ⚙ no canto inferior direito: quase invisível sobre o vídeo e aberto com TOQUE LONGO (1,5 s),
  // para que ninguém abra as configurações sem querer num totem público. O anel mostra o andamento.
  const corner = document.getElementById('corner');
  const hint = document.getElementById('corner-hint');
  let cursorTimer = null;
  window.addEventListener('mousemove', () => {
    document.body.classList.add('show-cursor');
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => document.body.classList.remove('show-cursor'), 3000);
  });
  const HOLD_MS = window.__HOLD_MS || 1500;
  let holdTimer = null;
  let hintTimer = null;
  const endHold = (opened) => {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
      if (!opened && hint) {
        hint.classList.add('show');
        clearTimeout(hintTimer);
        hintTimer = setTimeout(() => hint.classList.remove('show'), 2500);
      }
    }
    corner.classList.remove('holding');
  };
  corner.addEventListener('pointerdown', (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (holdTimer) return;
    corner.classList.add('holding');
    holdTimer = setTimeout(() => {
      holdTimer = null;
      endHold(true);
      open();
    }, HOLD_MS);
  });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) corner.addEventListener(t, () => endHold(false));
  corner.addEventListener('click', (e) => {
    if (!e.detail) open(); // acionado pelo teclado (Enter/Espaço no botão)
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault()); // toque longo não abre menu do navegador

  if (window.VKB) kb = window.VKB.attach(root, { paste: async () => ((await api.maint.paste(token || (await api.maint.session()).token)) || {}).text || '' });

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
