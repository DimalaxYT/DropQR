'use strict';

// DropQR — comportement de la barre de navigation.
//
// Chargé sur toutes les pages (statiques, rendues par le serveur, landing) et
// ré-initialisé après chaque navigation PJAX. Il gère, et rien d'autre :
//   - la pastille qui glisse sous les liens (survol + lien courant) ;
//   - le lien de la page courante (.is-current + aria-current) ;
//   - le surlignage de la section visible sur la landing (#product, #how, #faq) ;
//   - la progression de lecture et l'escamotage de la barre au défilement ;
//   - le menu en panneau sur petit écran : scrim, focus piégé, fermeture propre.
//
// Toutes les recherches d'éléments sont refaites à chaque initialisation : le
// contenu de #nv est remplacé par le PJAX, les anciens nœuds disparaissent.

(() => {
  let controller = null;

  // Marqueur pour le CSS : avec JS la pastille glisse, sans JS le survol garde
  // un fond statique (voir nav.css).
  document.documentElement.classList.add('nv-js');

  const media = (query) => {
    try {
      return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
    } catch (_error) {
      return false;
    }
  };

  const samePath = (a, b) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

  const initNav = () => {
    const nv = document.getElementById('nv');
    if (!nv) return;

    // Coupe les écouteurs de l'instance précédente (navigation PJAX).
    if (controller) controller.abort();
    controller = new AbortController();
    const { signal } = controller;

    const bar = nv.querySelector('.nv-bar');
    const linksBox = nv.querySelector('.nv-links');
    const pill = nv.querySelector('.nv-pill');
    const burger = nv.querySelector('.nv-burger');
    const progress = nv.querySelector('.nv-progress i');
    const scrim = nv.querySelector('.nv-scrim');
    // Certaines pages (version téléphone) n'ont pas de liens mais gardent la
    // progression et l'escamotage : on ne sort donc pas quand `items` est vide.
    const items = Array.from(nv.querySelectorAll('.nv-links a'));

    const path = window.location.pathname.replace(/\/+$/, '') || '/';
    const panelMode = () => media('(max-width: 1040px)');

    // ---------------------------------------------------------------------
    // Pastille glissante
    // ---------------------------------------------------------------------
    let pillTarget = null;

    const movePill = (target) => {
      if (!pill || !linksBox) return;
      if (!target || panelMode()) {
        pill.classList.remove('is-visible');
        pillTarget = null;
        return;
      }
      const boxRect = linksBox.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      if (!rect.width) return;
      pillTarget = target;
      pill.style.setProperty('--nv-pill-x', `${(rect.left - boxRect.left).toFixed(1)}px`);
      pill.style.setProperty('--nv-pill-w', `${rect.width.toFixed(1)}px`);
      pill.classList.add('is-visible');
    };

    const currentLink = () => items.find((link) => link.classList.contains('is-current')) || null;

    // ---------------------------------------------------------------------
    // Lien courant
    // ---------------------------------------------------------------------
    const markCurrent = (target) => {
      items.forEach((link) => {
        const isCurrent = link === target;
        link.classList.toggle('is-current', isCurrent);
        if (isCurrent) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      });
      if (!pillTarget) movePill(target);
    };

    const resolvePageCurrent = () => {
      // 1. une page (Receive, Help…) : chemin identique
      // 2. la landing : les ancres sont départagées par le scroll-spy
      let found = null;
      items.forEach((link) => {
        if (found) return;
        let url = null;
        try {
          url = new URL(link.href, window.location.href);
        } catch (_error) {
          return;
        }
        const target = url.pathname.replace(/\/+$/, '') || '/';
        if (url.hash) return; // géré par le scroll-spy sur la landing
        if (samePath(target, path)) found = link;
      });
      // /receive?code=… : la chip reste active même avec une query string
      if (!found) {
        const chip = items.find((link) => link.classList.contains('nv-chip'));
        if (chip && samePath(path, '/receive')) found = chip;
      }
      return found;
    };

    markCurrent(resolvePageCurrent());

    // ---------------------------------------------------------------------
    // Survol / focus : la pastille suit le pointeur, revient au lien courant
    // ---------------------------------------------------------------------
    const returnPill = () => movePill(currentLink());

    items.forEach((link) => {
      link.addEventListener('pointerenter', () => movePill(link), { passive: true, signal });
      link.addEventListener('focus', () => movePill(link), { signal });
      link.addEventListener('click', () => setOpen(false), { signal });
    });

    if (linksBox) {
      linksBox.addEventListener('pointerleave', returnPill, { passive: true, signal });
      linksBox.addEventListener('focusout', (event) => {
        if (!linksBox.contains(event.relatedTarget)) returnPill();
      }, { signal });
    }

    // ---------------------------------------------------------------------
    // Scroll-spy (landing) : la section visible prend le dessus
    // ---------------------------------------------------------------------
    const spyLinks = items.filter((link) => {
      try {
        const url = new URL(link.href, window.location.href);
        return Boolean(url.hash) && samePath(url.pathname, path);
      } catch (_error) {
        return false;
      }
    });
    const spyTargets = spyLinks
      .map((link) => {
        const id = new URL(link.href, window.location.href).hash.slice(1);
        const section = id ? document.getElementById(id) : null;
        return section ? { link, section } : null;
      })
      .filter(Boolean);

    if (spyTargets.length && 'IntersectionObserver' in window) {
      const visible = new Map();
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => visible.set(entry.target, entry.isIntersecting ? entry.intersectionRatio : 0));
          let best = null;
          let bestRatio = 0;
          visible.forEach((ratio, section) => {
            if (ratio > bestRatio) {
              bestRatio = ratio;
              best = section;
            }
          });
          const found = spyTargets.find((item) => item.section === best);
          if (found) {
            markCurrent(found.link);
            return;
          }
          // Aucune section visible : en haut de page on nettoie (hero), plus bas
          // on garde la dernière pour éviter un clignotement entre deux sections.
          if ((window.scrollY || 0) < 200) markCurrent(resolvePageCurrent());
        },
        { rootMargin: '-25% 0px -55% 0px', threshold: [0, 0.15, 0.4, 0.75, 1] }
      );
      spyTargets.forEach(({ section }) => observer.observe(section));
      signal.addEventListener('abort', () => observer.disconnect(), { once: true });
    }

    // ---------------------------------------------------------------------
    // Menu (petit écran)
    // ---------------------------------------------------------------------
    const focusables = () => {
      const nodes = [burger, ...items].filter(Boolean);
      return nodes.filter((node) => node.offsetParent !== null || node === burger);
    };

    let open = false;

    // Repère pour les technologies d'assistance : le bouton menu pilote la liste.
    if (linksBox && !linksBox.id) linksBox.id = 'nv-links';
    if (burger && linksBox) burger.setAttribute('aria-controls', linksBox.id);

    const lockScroll = (lock) => {
      if (lock) {
        const sbw = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
        document.documentElement.style.setProperty('--nv-sbw', `${sbw}px`);
      }
      document.documentElement.classList.toggle('nav-open', lock);
    };

    function setOpen(next, options = {}) {
      const wanted = Boolean(next) && panelMode();
      if (wanted === open && !options.force) {
        nv.classList.toggle('open', wanted);
        if (burger) burger.setAttribute('aria-expanded', String(wanted));
        return;
      }
      open = wanted;
      nv.classList.toggle('open', open);
      if (burger) burger.setAttribute('aria-expanded', String(open));
      lockScroll(open && panelMode());
      if (open) {
        nv.classList.remove('is-hidden');
        window.setTimeout(() => {
          const first = items[0];
          // Si le panneau a été refermé entre-temps, on ne déplace pas le focus.
          if (open && first && panelMode()) first.focus({ preventScroll: true });
        }, 120);
      } else if (options.restoreFocus && burger) {
        burger.focus({ preventScroll: true });
      }
    }

    if (burger) {
      burger.addEventListener('click', () => setOpen(!open), { signal });
    }
    if (scrim) {
      scrim.addEventListener('click', () => setOpen(false, { restoreFocus: true }), { signal });
    }

    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') {
          if (open) {
            event.preventDefault();
            setOpen(false, { restoreFocus: true });
          }
          return;
        }
        if (event.key !== 'Tab' || !open || !panelMode()) return;
        // Focus piégé dans le panneau tant qu'il est ouvert.
        const nodes = focusables();
        if (!nodes.length) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      },
      { signal }
    );

    document.addEventListener(
      'click',
      (event) => {
        if (!open) return;
        if (!nv.contains(event.target)) setOpen(false);
      },
      { signal }
    );

    window.addEventListener(
      'resize',
      () => {
        if (!panelMode() && open) setOpen(false);
        movePill(pillTarget || currentLink());
      },
      { passive: true, signal }
    );

    // ---------------------------------------------------------------------
    // Défilement : progression, compactage, escamotage
    // ---------------------------------------------------------------------
    let lastY = window.scrollY || 0;
    let ticking = false;
    let hidden = false;

    const setHidden = (next) => {
      if (next === hidden) return;
      // Jamais pendant que le menu est ouvert, ni quand le clavier parcourt les
      // liens : la barre ne doit pas fuir sous le focus. Le bouton menu, lui,
      // peut garder le focus sans bloquer l'escamotage.
      const focusInLinks = Boolean(linksBox && linksBox.contains(document.activeElement));
      if (next && (open || focusInLinks)) return;
      hidden = next;
      nv.classList.toggle('is-hidden', hidden);
    };

    const onScroll = () => {
      ticking = false;
      const y = window.scrollY || 0;
      const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);

      nv.classList.toggle('scrolled', y > 24);
      if (progress) {
        progress.style.setProperty('--nv-progress', `${(Math.min(1, Math.max(0, y / max)) * 100).toFixed(2)}%`);
      }

      const delta = y - lastY;
      if (Math.abs(delta) > 6) {
        // On descend franchement au-delà de l'en-tête : la barre s'escamote.
        if (delta > 0 && y > 340) setHidden(true);
        else if (delta < 0) setHidden(false);
        lastY = y;
      }
      if (y < 140) setHidden(false);
    };

    const requestScroll = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(onScroll);
    };

    window.addEventListener('scroll', requestScroll, { passive: true, signal });
    window.addEventListener('resize', requestScroll, { passive: true, signal });
    nv.addEventListener('focusin', () => setHidden(false), { signal });

    // ---------------------------------------------------------------------
    // Démarrage
    // ---------------------------------------------------------------------
    // Après un remplacement PJAX, le conteneur #nv survit : on efface les états
    // laissés par la page précédente (barre escamotée, panneau ouvert).
    nv.classList.remove('is-hidden', 'open');
    document.documentElement.classList.remove('nav-open');

    setOpen(false, { force: true });
    onScroll();
    window.requestAnimationFrame(() => movePill(currentLink()));

    // Les polices peuvent changer la largeur des libellés : on replace la pastille.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => movePill(pillTarget || currentLink())).catch(() => {});
    }
    if (bar && 'ResizeObserver' in window) {
      const ro = new ResizeObserver(() => movePill(pillTarget || currentLink()));
      ro.observe(bar);
      signal.addEventListener('abort', () => ro.disconnect(), { once: true });
    }
  };

  initNav();
  window.addEventListener('pjax:load', initNav);
  window.addEventListener('pagehide', () => {
    document.documentElement.classList.remove('nav-open');
  });
})();
