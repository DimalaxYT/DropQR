'use strict';

// DropQR — Code Slots « neon deck »
//
// Adaptation très libre du composant « Code Slots » de React Bits
// (https://reactbits.dev/micro/code-slots) pour la page Recevoir : un seul
// fichier, zéro dépendance, zéro framework.
//
// Principe : le vrai <input> reste en place (label, clavier, collage, lecteurs
// d'écran, soumission du formulaire). On l'entoure d'une plaque décorative et
// on le rend transparent par-dessus. Sans JavaScript, le champ s'affiche
// exactement comme avant — rien ne casse.
//
// Utilisation :
//   <input id="transferCode" data-code-slots="7" ...>
//   input.codeSlots.setValue('Q7R4M2K')             // programme
//   input.codeSlots.setStatus('loading')            // idle | loading | error | success
//   input.addEventListener('codeslots:complete', (e) => e.detail.code)
//
// Quand les 7 caractères sont saisis (frappe ou collage), le formulaire est
// soumis automatiquement (désactivable avec data-code-autosubmit="false").

(() => {
  const MAX_LENGTH = 12;
  const SETTLE_MS = 380;
  const CASCADE_MS = 20;
  const ERROR_MS = 1400;
  const SUCCESS_MS = 1600;

  const normalize = (value, length) =>
    String(value || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, length);

  // Extrait un code d'un texte collé : code brut, /c/CODE, /code/CODE ou
  // ?code=CODE. Un lien /t/ID n'est pas un code : on laisse mobile.js le gérer.
  const extractCode = (text, length) => {
    const value = String(text || '').trim();
    if (!value) return '';
    try {
      const url = new URL(value);
      const fromQuery = url.searchParams.get('code');
      if (fromQuery) return normalize(fromQuery, length);
      const match = url.pathname.match(/\/(?:c|code)\/([A-Za-z0-9-]+)/);
      if (match) return normalize(match[1], length);
      return '';
    } catch (_error) {
      return normalize(value, length);
    }
  };

  const prefersReducedMotion = () =>
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const isCoarsePointer = () =>
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;

  const canHover = () =>
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  const vibrate = (pattern) => {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (_error) {
      /* API absente ou bloquée : sans importance */
    }
  };

  function enhance(input) {
    if (input.dataset.codeSlotsReady === '1' && input.codeSlots) return input.codeSlots;

    const declared = Number.parseInt(input.dataset.codeSlots, 10);
    const length = Math.min(MAX_LENGTH, Math.max(1, Number.isFinite(declared) ? declared : 7));
    const reduced = prefersReducedMotion();
    const settleMs = reduced ? 0 : SETTLE_MS;

    const root = document.createElement('div');
    root.className = 'cs';
    root.style.setProperty('--cs-length', String(length));
    root.style.setProperty('--cs-settle', `${settleMs}ms`);

    // Plaque de verre : halo pointeur, cases, éclat de succès.
    const deck = document.createElement('div');
    deck.className = 'cs-deck';

    const aura = document.createElement('span');
    aura.className = 'cs-aura';
    aura.setAttribute('aria-hidden', 'true');
    deck.appendChild(aura);

    const flare = document.createElement('span');
    flare.className = 'cs-flare';
    flare.setAttribute('aria-hidden', 'true');
    deck.appendChild(flare);

    const row = document.createElement('div');
    row.className = 'cs-row';
    // Les cases ne sont qu'un écho visuel : les lecteurs d'écran lisent le vrai
    // champ (valeur, label, aria-describedby) et ignorent cette rangée.
    row.setAttribute('aria-hidden', 'true');

    const slots = [];
    for (let index = 0; index < length; index += 1) {
      const slot = document.createElement('div');
      slot.className = 'cs-slot';

      const digit = document.createElement('span');
      digit.className = 'cs-digit';

      const ring = document.createElement('span');
      ring.className = 'cs-ring';

      slot.appendChild(digit);
      slot.appendChild(ring);
      row.appendChild(slot);
      slots.push({ slot, digit, ring, char: '', timer: 0 });
    }

    deck.appendChild(row);

    // Fine barre de progression de la saisie.
    const progress = document.createElement('span');
    progress.className = 'cs-progress is-empty';
    progress.setAttribute('aria-hidden', 'true');
    const progressBar = document.createElement('i');
    progress.appendChild(progressBar);

    input.parentNode.insertBefore(root, input);
    root.appendChild(deck);
    root.appendChild(input);
    root.appendChild(progress);

    input.classList.add('cs-native');
    input.dataset.codeSlotsReady = '1';
    if (input.form) input.form.classList.add('cs-form');
    input.maxLength = length;
    if (!input.getAttribute('autocomplete')) input.setAttribute('autocomplete', 'off');

    let status = 'idle';
    let statusTimer = 0;
    let lastComplete = '';

    const focusInput = () => {
      try {
        input.focus({ preventScroll: true });
      } catch (_error) {
        input.focus();
      }
      const end = input.value.length;
      try {
        input.setSelectionRange(end, end);
      } catch (_error) {
        /* champ sans sélection (type non texte) : rien à faire */
      }
    };

    const render = ({ cascade = false } = {}) => {
      const value = normalize(input.value, length);
      if (input.value !== value) input.value = value;
      if (value.length !== length) lastComplete = '';

      const landed = [];

      slots.forEach((state, index) => {
        const char = value[index] || '';
        if (char === state.char) return;

        if (char) {
          state.char = char;
          if (state.timer) {
            window.clearTimeout(state.timer);
            state.timer = 0;
          }
          state.digit.textContent = char;
          state.slot.classList.remove('is-draining');
          state.slot.classList.add('is-filled');
          landed.push(index);
          return;
        }

        // Caractère effacé : on le laisse « tomber » avant de vider la case.
        state.char = '';
        state.slot.classList.remove('is-landing');
        if (state.timer) window.clearTimeout(state.timer);
        if (settleMs === 0) {
          state.digit.textContent = '';
          state.slot.classList.remove('is-filled', 'is-draining');
          return;
        }
        state.slot.classList.add('is-draining');
        state.timer = window.setTimeout(() => {
          state.timer = 0;
          if (!input.value[index]) {
            slots[index].digit.textContent = '';
            slots[index].slot.classList.remove('is-filled', 'is-draining');
          }
        }, settleMs);
      });

      landed.forEach((index, order) => {
        const { slot } = slots[index];
        slot.style.setProperty('--cs-delay', `${cascade ? order * CASCADE_MS : 0}ms`);
        slot.classList.remove('is-landing');
        void slot.offsetWidth; // relance l'animation si la case se remplit vite
        slot.classList.add('is-landing');
      });

      const activeIndex = value.length < length ? value.length : -1;
      slots.forEach((state, index) => {
        state.slot.classList.toggle('is-active', index === activeIndex);
      });

      progress.style.setProperty('--cs-progress', `${Math.round((value.length / length) * 100)}%`);
      progress.classList.toggle('is-empty', value.length === 0);
      root.classList.toggle('cs--empty', value.length === 0);
      root.classList.toggle('cs--complete', value.length === length);
      root.classList.toggle('cs--disabled', input.disabled);
    };

    const restartFlare = () => {
      if (reduced) return;
      flare.classList.remove('is-on');
      void flare.offsetWidth;
      flare.classList.add('is-on');
    };

    const setStatus = (next, options = {}) => {
      status = ['error', 'success', 'loading'].includes(next) ? next : 'idle';
      root.classList.toggle('cs--error', status === 'error');
      root.classList.toggle('cs--success', status === 'success');
      root.classList.toggle('cs--loading', status === 'loading');
      progress.classList.toggle('is-error', status === 'error');
      progress.classList.toggle('is-success', status === 'success');
      input.setAttribute('aria-invalid', status === 'error' ? 'true' : 'false');

      if (statusTimer) {
        window.clearTimeout(statusTimer);
        statusTimer = 0;
      }

      if (status === 'error') {
        // Relance la secousse même si deux erreurs s'enchaînent.
        root.classList.remove('cs--shake');
        void root.offsetWidth;
        root.classList.add('cs--shake');
        flare.classList.remove('is-on');
        vibrate([26, 42, 26]);
        // Le code est complet et faux: on sélectionne tout pour que la
        // prochaine frappe remplace, au lieu de buter sur maxlength. Pas sur
        // écran tactile: la sélection native y ouvre des poignées inutiles.
        if (document.activeElement === input && !isCoarsePointer()) {
          try {
            input.select();
          } catch (_error) {
            /* ignore */
          }
        }
      } else {
        root.classList.remove('cs--shake');
      }

      if (status === 'success') {
        restartFlare();
        vibrate([10, 26, 10, 26, 16]);
      }

      // 'loading' reste affiché jusqu'au prochain état ; les autres retombent
      // seuls, sauf demande explicite de persistance.
      if ((status === 'error' || status === 'success') && options.persist !== true) {
        statusTimer = window.setTimeout(
          () => setStatus('idle'),
          status === 'error' ? ERROR_MS : SUCCESS_MS
        );
      }
    };

    const submitForm = () => {
      const form = input.form;
      if (!form || input.dataset.codeAutosubmit === 'false' || input.disabled) return;
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    };

    const notifyComplete = (userAction) => {
      const value = normalize(input.value, length);
      if (value.length !== length || value === lastComplete) return;
      lastComplete = value;
      vibrate(9);
      input.dispatchEvent(
        new CustomEvent('codeslots:complete', { bubbles: true, detail: { code: value } })
      );
      // Soumission seulement sur une action de l'utilisateur : une valeur posée
      // par le code appelant (receive.js, restauration, ?code=...) ne déclenche
      // pas une seconde recherche.
      if (userAction) submitForm();
    };

    const setValue = (value, options = {}) => {
      input.value = normalize(value, length);
      render({ cascade: options.cascade === true });
      if (options.status) setStatus(options.status, options);
    };

    const clear = () => {
      setValue('');
      setStatus('idle');
      lastComplete = '';
    };

    input.addEventListener('input', () => {
      const value = normalize(input.value, length);
      if (input.value !== value) input.value = value;
      const end = value.length;
      try {
        input.setSelectionRange(end, end);
      } catch (_error) {
        /* ignore */
      }
      render();
      if (status !== 'idle') setStatus('idle');
      notifyComplete(true);
    });

    input.addEventListener('paste', (event) => {
      const clipboard = event.clipboardData;
      const text = clipboard && clipboard.getData('text');
      if (!text) return;
      const code = extractCode(text, length);
      if (!code) return; // lien de partage (/t/...) : mobile.js s'en occupe
      event.preventDefault();
      setValue(code, { cascade: true });
      focusInput();
      notifyComplete(true);
    });

    input.addEventListener('focus', () => {
      root.classList.add('cs--focus');
      render();
    });

    input.addEventListener('blur', () => {
      root.classList.remove('cs--focus');
    });

    root.addEventListener('click', (event) => {
      if (event.target === input) return;
      focusInput();
    });

    // Inclinaison 3D + halo qui suit le pointeur (souris uniquement).
    if (!reduced && canHover()) {
      let pointerFrame = 0;
      let lastX = 0;
      let lastY = 0;

      const applyPointer = () => {
        pointerFrame = 0;
        const rect = root.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const px = Math.min(1, Math.max(0, (lastX - rect.left) / rect.width));
        const py = Math.min(1, Math.max(0, (lastY - rect.top) / rect.height));
        root.style.setProperty('--cs-mx', `${(px * 100).toFixed(1)}%`);
        root.style.setProperty('--cs-my', `${(py * 100).toFixed(1)}%`);
        deck.style.setProperty('--cs-ry', `${((px - 0.5) * 7).toFixed(2)}deg`);
        deck.style.setProperty('--cs-rx', `${((0.5 - py) * 5).toFixed(2)}deg`);
      };

      root.addEventListener(
        'pointermove',
        (event) => {
          lastX = event.clientX;
          lastY = event.clientY;
          if (pointerFrame) return;
          pointerFrame = window.requestAnimationFrame(applyPointer);
        },
        { passive: true }
      );

      root.addEventListener(
        'pointerleave',
        () => {
          deck.style.setProperty('--cs-ry', '0deg');
          deck.style.setProperty('--cs-rx', '0deg');
        },
        { passive: true }
      );
    }

    Object.defineProperty(input, 'codeSlots', {
      configurable: true,
      value: Object.freeze({
        length,
        element: root,
        setValue,
        setStatus,
        clear,
        focus: focusInput,
        getValue: () => normalize(input.value, length)
      })
    });

    render();
    setStatus('idle', { persist: true });
    return input.codeSlots;
  }

  const initCodeSlots = () => {
    document.querySelectorAll('input[data-code-slots]').forEach((input) => {
      try {
        enhance(input);
      } catch (_error) {
        // En cas de souci, le champ natif reste utilisable tel quel.
      }
    });
  };

  initCodeSlots();
  window.addEventListener('pjax:load', initCodeSlots);
})();
