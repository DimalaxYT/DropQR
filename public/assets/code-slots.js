'use strict';

// DropQR — Code Slots
//
// Adaptation du composant « Code Slots » de React Bits
// (https://reactbits.dev/micro/code-slots) pour la page Recevoir : un seul
// fichier, zéro dépendance, zéro framework.
//
// Principe : le vrai <input> reste en place (label, clavier, collage, lecteurs
// d'écran, soumission du formulaire). On l'entoure simplement d'une rangée de
// cases décoratives et on le rend transparent par-dessus. Sans JavaScript, le
// champ s'affiche exactement comme avant — rien ne casse.
//
// Utilisation :
//   <input id="transferCode" data-code-slots="7" ...>
//   input.codeSlots.setValue('Q7R4M2K')   // programme
//   input.codeSlots.setStatus('error')    // 'idle' | 'error' | 'success'
//   input.addEventListener('codeslots:complete', (e) => e.detail.code)
//
// Quand les 7 caractères sont saisis (frappe ou collage), le formulaire est
// soumis automatiquement (désactivable avec data-code-autosubmit="false").

(() => {
  const MAX_LENGTH = 12;
  const SETTLE_MS = 300;
  const CASCADE_MS = 20;
  const ERROR_MS = 1100;
  const SUCCESS_MS = 900;

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

  function enhance(input) {
    if (input.dataset.codeSlotsReady === '1' && input.codeSlots) return input.codeSlots;

    const declared = Number.parseInt(input.dataset.codeSlots, 10);
    const length = Math.min(MAX_LENGTH, Math.max(1, Number.isFinite(declared) ? declared : 7));
    const settleMs = prefersReducedMotion() ? 0 : SETTLE_MS;

    const root = document.createElement('div');
    root.className = 'cs';
    root.style.setProperty('--cs-length', String(length));
    root.style.setProperty('--cs-settle', `${settleMs}ms`);

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
      slot.appendChild(digit);
      row.appendChild(slot);
      slots.push({ slot, digit, char: '', timer: 0 });
    }

    input.parentNode.insertBefore(root, input);
    root.appendChild(row);
    root.appendChild(input);

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

      root.classList.toggle('cs--disabled', input.disabled);
    };

    const setStatus = (next, options = {}) => {
      status = next === 'error' || next === 'success' ? next : 'idle';
      root.classList.toggle('cs--error', status === 'error');
      root.classList.toggle('cs--success', status === 'success');
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
      if (status !== 'idle' && options.persist !== true) {
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
