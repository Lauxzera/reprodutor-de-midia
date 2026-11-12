'use strict';

// Teclado flutuante na tela do Player (layout ABNT2, o padrão QWERTY do Brasil), para totens/telas touch
// sem teclado nem mouse. Aparece ao tocar num campo de texto do painel, pode ser arrastado e redimensionado
// e não depende do teclado do Windows. A lógica (applyKey, compose, charFor) é pura e testada à parte.
(() => {
  // [normal, com Shift]. Letras: só a minúscula (o Shift/Caps maiúsculiza). "dead:" = acento que espera a próxima letra.
  const K = (n, s) => [n, s === undefined ? n.toUpperCase() : s];
  const ROWS = [
    [K("'", '"'), K('1', '!'), K('2', '@'), K('3', '#'), K('4', '$'), K('5', '%'), K('6', 'dead:diaeresis'), K('7', '&'), K('8', '*'), K('9', '('), K('0', ')'), K('-', '_'), K('=', '+'), 'BACK'],
    [K('q'), K('w'), K('e'), K('r'), K('t'), K('y'), K('u'), K('i'), K('o'), K('p'), K('dead:acute', 'dead:grave'), K('[', '{')],
    ['CAPS', K('a'), K('s'), K('d'), K('f'), K('g'), K('h'), K('j'), K('k'), K('l'), K('ç'), K('dead:tilde', 'dead:circumflex'), K(']', '}'), 'ENTER'],
    ['SHIFT', K('\\', '|'), K('z'), K('x'), K('c'), K('v'), K('b'), K('n'), K('m'), K(',', '<'), K('.', '>'), K(';', ':'), K('/', '?'), 'SHIFT'],
    [K('SPACE', 'SPACE')],
  ];
  const NUM_ROWS = [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['.', '0', 'BACK'], ['ENTER']];

  const DEAD_CHAR = { acute: '´', grave: '`', tilde: '~', circumflex: '^', diaeresis: '¨' };
  const DEAD_MAP = {
    acute: { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý', c: 'ç', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú', Y: 'Ý', C: 'Ç' },
    grave: { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', A: 'À', E: 'È', I: 'Ì', O: 'Ò', U: 'Ù' },
    tilde: { a: 'ã', o: 'õ', n: 'ñ', A: 'Ã', O: 'Õ', N: 'Ñ' },
    circumflex: { a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û', A: 'Â', E: 'Ê', I: 'Î', O: 'Ô', U: 'Û' },
    diaeresis: { a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', y: 'ÿ', A: 'Ä', E: 'Ë', I: 'Ï', O: 'Ö', U: 'Ü' },
  };
  const LABELS = { SHIFT: '⇧', CAPS: 'Caps', BACK: '⌫', SPACE: 'espaço', ENTER: 'OK' };
  const TEXT_TYPES = new Set(['text', 'password', 'search', 'url', 'tel', 'email', 'number', '']);
  const isLetter = (c) => c.length === 1 && c.toLowerCase() !== c.toUpperCase();

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

  /** O que a tecla `def` ([normal, shift]) digita com Shift/Caps ligados. */
  function charFor(def, { shift = false, caps = false } = {}) {
    const [n, s] = def;
    if (n.startsWith('dead:')) return shift ? s : n;
    if (isLetter(n)) return shift !== caps ? n.toUpperCase() : n;
    return shift ? s : n;
  }

  /**
   * Acento morto + próxima tecla. Devolve { text, dead }: o texto a inserir e, se a tecla
   * também for um acento, o novo acento pendente.
   */
  function compose(dead, ch) {
    if (!dead) return ch.startsWith('dead:') ? { text: '', dead: ch.slice(5) } : { text: ch, dead: null };
    if (ch.startsWith('dead:')) return { text: DEAD_CHAR[dead], dead: ch.slice(5) }; // dois acentos seguidos: o primeiro sai como símbolo
    if (ch === ' ') return { text: DEAD_CHAR[dead], dead: null };
    return { text: (DEAD_MAP[dead] && DEAD_MAP[dead][ch]) || DEAD_CHAR[dead] + ch, dead: null };
  }

  const isTextField = (n) => n && ((n.tagName === 'INPUT' && TEXT_TYPES.has((n.type || '').toLowerCase())) || n.tagName === 'TEXTAREA');

  const SIZES = [640, 800, 960, 1120, 1300];
  const store = {
    get() {
      try {
        return JSON.parse(localStorage.getItem('rm.vkb') || '{}');
      } catch {
        return {};
      }
    },
    set(v) {
      try {
        localStorage.setItem('rm.vkb', JSON.stringify(v));
      } catch {
        /* sem armazenamento: vale só nesta sessão */
      }
    },
  };

  function attach(root, { paste } = {}) {
    const kb = document.createElement('div');
    kb.id = 'vkb';
    kb.className = 'hidden';
    kb.setAttribute('role', 'group');
    kb.setAttribute('aria-label', 'Teclado na tela');
    document.body.append(kb);

    let current = null;
    let shift = false;
    let caps = false;
    let dead = null;
    const saved = store.get();
    let sizeIdx = Number.isInteger(saved.size) && saved.size >= 0 && saved.size < SIZES.length ? saved.size : 2;
    let pos = saved.x !== undefined ? { x: saved.x, y: saved.y } : null; // null = centralizado embaixo
    const keyDefs = new Map();

    const width = () => Math.min(SIZES[sizeIdx], Math.max(320, window.innerWidth - 16));

    function place() {
      kb.style.setProperty('width', `${width()}px`);
      const w = kb.offsetWidth || width();
      const h = kb.offsetHeight || 300;
      let x = pos ? pos.x : (window.innerWidth - w) / 2;
      let y = pos ? pos.y : window.innerHeight - h - 12;
      x = Math.max(4, Math.min(window.innerWidth - w - 4, x));
      y = Math.max(4, Math.min(window.innerHeight - h - 4, y));
      kb.style.setProperty('left', `${x}px`);
      kb.style.setProperty('top', `${y}px`);
    }

    function hide() {
      current = null;
      dead = null;
      kb.classList.add('hidden');
    }

    function write(text) {
      if (!current || !root.contains(current)) return hide();
      const isNum = (current.type || '') === 'number';
      // input[type=number] não expõe a seleção: trata o fim do texto como cursor.
      const start = isNum ? current.value.length : current.selectionStart ?? current.value.length;
      const end = isNum ? current.value.length : current.selectionEnd ?? current.value.length;
      const next = applyKey({ value: current.value, start, end }, text);
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

    // O teclado é flutuante e pode estar em qualquer lugar: se cobrir o campo, rola o painel para destapá-lo.
    function reveal() {
      if (!current || !root.contains(current) || !current.getBoundingClientRect) return;
      const r = current.getBoundingClientRect();
      const k = kb.getBoundingClientRect();
      const overlaps = !(r.bottom < k.top - 8 || r.top > k.bottom + 8 || r.right < k.left || r.left > k.right);
      if (!overlaps) {
        if (r.top < 8) root.scrollTop += r.top - 8;
        return;
      }
      if (k.top + k.height / 2 > window.innerHeight / 2) root.scrollTop += r.bottom - (k.top - 12);
      else root.scrollTop -= k.bottom + 12 - r.top;
    }

    const markDead = () => kb.classList.toggle('dead-pending', dead !== null);

    function press(name) {
      if (name === 'CLOSE' || name === 'ENTER') return hide();
      if (name === 'SMALLER' || name === 'BIGGER') {
        sizeIdx = Math.max(0, Math.min(SIZES.length - 1, sizeIdx + (name === 'BIGGER' ? 1 : -1)));
        store.set({ ...store.get(), size: sizeIdx });
        place();
        return reveal();
      }
      if (name === 'SHIFT') {
        shift = !shift;
        return render();
      }
      if (name === 'CAPS') {
        caps = !caps;
        return render();
      }
      if (name === 'PASTE') {
        if (paste) paste().then((text) => text && write(text));
        return;
      }
      if (name === 'LEFT' || name === 'RIGHT' || name === 'CLEAR' || name === 'BACK') {
        dead = null;
        markDead();
        return write(name);
      }
      const def = keyDefs.get(name);
      if (!def) return;
      const r = compose(dead, charFor(def, { shift, caps }));
      dead = r.dead;
      if (r.text) write(r.text);
      if (shift) {
        shift = false;
        return render();
      }
      markDead();
    }

    function keyButton(name, label, cls = '') {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `vk ${cls}`.trim();
      b.dataset.key = name;
      b.textContent = label;
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
    }

    const labelOf = (def) => {
      const c = charFor(def, { shift, caps });
      if (c.startsWith('dead:')) return DEAD_CHAR[c.slice(5)];
      return c === 'SPACE' ? LABELS.SPACE : c;
    };

    function bindDrag(handle) {
      let start = null;
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const r = kb.getBoundingClientRect();
        start = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        if (handle.setPointerCapture && e.pointerId !== undefined) {
          try {
            handle.setPointerCapture(e.pointerId);
          } catch {
            /* ignorado */
          }
        }
      });
      handle.addEventListener('pointermove', (e) => {
        if (!start) return;
        pos = { x: e.clientX - start.dx, y: e.clientY - start.dy };
        place();
      });
      const end = () => {
        if (!start) return;
        start = null;
        if (pos) store.set({ ...store.get(), x: Math.round(pos.x), y: Math.round(pos.y) });
        reveal();
      };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    }

    function render() {
      keyDefs.clear();
      const num = current && (current.type || '') === 'number';
      const rows = [];
      if (num) {
        for (const r of NUM_ROWS) {
          const row = document.createElement('div');
          row.className = 'vk-row';
          for (const k of r) row.append(keyButton(k, LABELS[k] || k, k === 'ENTER' || k === 'BACK' ? 'fn' : ''));
          rows.push(row);
        }
      } else {
        ROWS.forEach((r, ri) => {
          const row = document.createElement('div');
          row.className = `vk-row r${ri}`;
          r.forEach((def, ci) => {
            if (typeof def === 'string') {
              const b = keyButton(def, LABELS[def] || def, `fn k-${def.toLowerCase()}`);
              if (def === 'SHIFT') b.setAttribute('aria-pressed', String(shift));
              if (def === 'CAPS') {
                b.setAttribute('aria-pressed', String(caps));
                if (caps) b.classList.add('lock');
              }
              row.append(b);
              return;
            }
            const id = `${ri}:${ci}`;
            keyDefs.set(id, def);
            row.append(keyButton(id, labelOf(def), def[0] === 'SPACE' ? 'wide' : def[0].startsWith('dead:') ? 'dead' : ''));
          });
          rows.push(row);
        });
      }
      // barra de cima: alça para arrastar + ferramentas
      const bar = document.createElement('div');
      bar.className = 'vk-bar';
      const handle = document.createElement('div');
      handle.className = 'vk-handle';
      handle.textContent = '⠿ Arraste para mover';
      bindDrag(handle);
      bar.append(handle);
      for (const [name, label] of [['PASTE', 'Colar'], ['LEFT', '◀'], ['RIGHT', '▶'], ['CLEAR', 'Limpar'], ['SMALLER', 'A−'], ['BIGGER', 'A+'], ['CLOSE', 'Concluído']]) {
        if (name === 'PASTE' && !paste) continue;
        bar.append(keyButton(name, label, `tool${name === 'CLOSE' ? ' done' : ''}`));
      }
      kb.replaceChildren(bar, ...rows);
      markDead();
      place();
    }

    function show(target) {
      current = target;
      shift = false;
      dead = null;
      render();
      kb.classList.remove('hidden');
      place();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            place();
            reveal();
          }),
        );
      }
    }

    root.addEventListener('focusin', (e) => {
      if (isTextField(e.target)) show(e.target);
    });
    // Tocar fora de um campo (e fora do teclado) fecha o teclado.
    root.addEventListener('pointerdown', (e) => {
      if (!isTextField(e.target) && !kb.contains(e.target)) hide();
    });
    window.addEventListener('resize', () => !kb.classList.contains('hidden') && place());

    return { hide, show, element: kb };
  }

  window.VKB = { attach, applyKey, compose, charFor, ROWS, NUM_ROWS, DEAD_MAP };
})();
