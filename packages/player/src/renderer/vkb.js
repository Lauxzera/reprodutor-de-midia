'use strict';

// Teclado na tela do Player, para totens/telas touch sem teclado nem mouse.
// Aparece sozinho ao tocar num campo de texto do painel de manutenção e não depende do teclado do Windows.
// A lógica de digitação (applyKey) é pura e testada à parte; attach() liga tudo ao DOM.
(() => {
  const LETTERS = [
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
    ['SHIFT', 'z', 'x', 'c', 'v', 'b', 'n', 'm', 'BACK'],
  ];
  const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
  const LAYOUTS = {
    abc: [DIGITS, ...LETTERS, ['SYM', '-', '_', '.', 'SPACE', '/', ':', 'ENTER']],
    sym: [DIGITS, ['!', '@', '#', '$', '%', '&', '*', '(', ')', '+'], ['=', '?', ',', ';', '"', "'", '<', '>', '~', 'BACK'], ['[', ']', '{', '}', '\\', '|', '^', '`'], ['ABC', '-', '_', '.', 'SPACE', '/', ':', 'ENTER']],
    num: [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['.', '0', 'BACK'], ['ENTER']],
  };
  const LABELS = { SHIFT: '⇧', BACK: '⌫', SPACE: 'espaço', ENTER: 'OK', SYM: '?123', ABC: 'ABC' };
  const TEXT_TYPES = new Set(['text', 'password', 'search', 'url', 'tel', 'email', 'number', '']);

  /**
   * Aplica uma tecla ao texto. `st` = { value, start, end } (seleção); devolve o novo estado.
   * Teclas especiais: BACK (apaga), LEFT/RIGHT (move o cursor), CLEAR (limpa tudo). Qualquer outra string é inserida.
   */
  function applyKey(st, key) {
    const { value } = st;
    let { start, end } = st;
    if (start > end) [start, end] = [end, start];
    if (key === 'BACK') {
      if (start !== end) return { value: value.slice(0, start) + value.slice(end), start, end: start };
      if (start === 0) return { value, start, end: start };
      return { value: value.slice(0, start - 1) + value.slice(end), start: start - 1, end: start - 1 };
    }
    if (key === 'LEFT') {
      const p = start !== end ? start : Math.max(0, start - 1);
      return { value, start: p, end: p };
    }
    if (key === 'RIGHT') {
      const p = start !== end ? end : Math.min(value.length, end + 1);
      return { value, start: p, end: p };
    }
    if (key === 'CLEAR') return { value: '', start: 0, end: 0 };
    const text = key === 'SPACE' ? ' ' : key;
    return { value: value.slice(0, start) + text + value.slice(end), start: start + text.length, end: start + text.length };
  }

  const isTextField = (n) => n && ((n.tagName === 'INPUT' && TEXT_TYPES.has((n.type || '').toLowerCase())) || n.tagName === 'TEXTAREA');

  function attach(root, { paste } = {}) {
    const kb = document.createElement('div');
    kb.id = 'vkb';
    kb.className = 'hidden';
    kb.setAttribute('role', 'group');
    kb.setAttribute('aria-label', 'Teclado na tela');
    document.body.append(kb);

    let current = null;
    let layout = 'abc';
    let shift = 0; // 0 = minúsculas, 1 = próxima letra maiúscula, 2 = maiúsculas fixas
    let lastShiftTap = 0;

    const setHeight = () => document.documentElement.style.setProperty('--vkb-h', kb.classList.contains('hidden') ? '0px' : `${kb.offsetHeight}px`);

    function hide() {
      current = null;
      kb.classList.add('hidden');
      document.body.classList.remove('vkb-open');
      setHeight();
    }

    function write(key) {
      if (!current || !root.contains(current)) return hide();
      const isNum = (current.type || '') === 'number';
      // input[type=number] não expõe a seleção: trata o fim do texto como cursor.
      const start = isNum ? current.value.length : current.selectionStart ?? current.value.length;
      const end = isNum ? current.value.length : current.selectionEnd ?? current.value.length;
      const next = applyKey({ value: current.value, start, end }, key);
      if (next.value !== current.value) {
        current.value = next.value;
        current.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (!isNum) {
        try {
          current.setSelectionRange(next.start, next.end);
        } catch {
          /* tipo sem seleção */
        }
      }
    }

    function press(name) {
      if (name === 'SHIFT') {
        const now = Date.now();
        shift = now - lastShiftTap < 450 ? 2 : shift ? 0 : 1; // toque duplo = maiúsculas fixas
        lastShiftTap = now;
        return render();
      }
      if (name === 'SYM' || name === 'ABC') {
        layout = name === 'SYM' ? 'sym' : 'abc';
        return render();
      }
      if (name === 'ENTER') return hide();
      if (name === 'PASTE') {
        if (paste) paste().then((text) => text && write(text));
        return;
      }
      const letter = name.length === 1 && name.toLowerCase() !== name.toUpperCase();
      write(letter && shift ? name.toUpperCase() : name);
      if (letter && shift === 1) {
        shift = 0;
        render();
      }
    }

    const key = (name, cls = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `vk ${cls}`.trim();
      b.dataset.key = name;
      const letter = name.length === 1 && name.toLowerCase() !== name.toUpperCase();
      b.textContent = LABELS[name] || (letter && shift ? name.toUpperCase() : name);
      if (name === 'SHIFT') {
        b.setAttribute('aria-pressed', String(shift > 0));
        if (shift === 2) b.classList.add('lock');
      }
      if (name === 'SPACE') b.classList.add('wide');
      if (name === 'ENTER' || name === 'SHIFT' || name === 'BACK' || name === 'SYM' || name === 'ABC') b.classList.add('fn');
      // pointerdown/mousedown sem foco: o campo continua selecionado enquanto se digita.
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        press(name);
      });
      b.addEventListener('click', (e) => {
        if (e.detail === 0) press(name); // acionado pelo teclado físico
      });
      return b;
    };

    function render() {
      const type = (current && (current.type || '')) === 'number' ? 'num' : layout;
      const rows = LAYOUTS[type].map((r) => {
        const row = document.createElement('div');
        row.className = 'vk-row';
        for (const k of r) row.append(key(k));
        return row;
      });
      const bar = document.createElement('div');
      bar.className = 'vk-row vk-tools';
      for (const [name, label] of [['PASTE', 'Colar'], ['LEFT', '◀'], ['RIGHT', '▶'], ['CLEAR', 'Limpar'], ['ENTER', 'Concluído']]) {
        const b = key(name, 'tool');
        b.textContent = label;
        if (name === 'PASTE' && !paste) continue;
        bar.append(b);
      }
      kb.replaceChildren(bar, ...rows);
      setHeight();
    }

    function show(target) {
      current = target;
      layout = 'abc';
      shift = 0;
      render();
      kb.classList.remove('hidden');
      document.body.classList.add('vkb-open');
      setHeight();
      // deixa o campo visível acima do teclado (depois que o espaço do teclado entrou no layout)
      const reveal = () => {
        if (!root.contains(target) || !target.getBoundingClientRect) return;
        const r = target.getBoundingClientRect();
        const free = window.innerHeight - kb.offsetHeight;
        const overlap = r.bottom - (free - 16);
        if (overlap > 0) root.scrollTop += overlap;
        else if (r.top < 8) root.scrollTop += r.top - 8;
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(reveal));
    }

    root.addEventListener('focusin', (e) => {
      if (isTextField(e.target)) show(e.target);
    });
    // Tocar fora de um campo (e fora do teclado) fecha o teclado.
    root.addEventListener('pointerdown', (e) => {
      if (!isTextField(e.target) && !kb.contains(e.target)) hide();
    });

    return { hide, show, element: kb };
  }

  window.VKB = { attach, applyKey, LAYOUTS };
})();
