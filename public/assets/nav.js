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
// Contrainte de vitesse : la barre doit répondre au premier survol et au
// premier clic. Les positions des liens sont donc mesurées une seule fois puis
// mises en cache (invalidées au redimensionnement / chargement des polices),
// et l'état courant est déjà peint en CSS avant l'exécution de ce fichier.

(() => {
  let controller = null;

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

    // Après un remplacement PJAX, le conteneur #nv survit : on efface l'état
    // « barre escamotée » de la page précédente. L'état du menu, lui, est
    // adopté tel quel : device.js a pu l'ouvrir avant l'arrivée de ce script,
    // et le refermer ici ferait « sauter » le panneau sous le doigt.
    nv.classList.remove('is-hidden');

    // Repère pour les technologies d'assistance : le bouton menu pilote la liste.
    if (linksBox && !linksBox.id) linksBox.id = 'nv-links';
    if (burger && linksBox) burger.setAttribute('aria-controls', linksBox.id);

    // ---------------------------------------------------------------------
    // Pastille glissante (métriques mesurées une fois, puis mises en cache)
    // ---------------------------------------------------------------------
    let metrics = null;
    let hovered = null;

    const measure = () => {
      metrics = null;
      if (!pill || !linksBox) return;
      const box = linksBox.getBoundingClientRect();
      const next = new Map();
      items.forEach((link) => {
        const rect = link.getBoundingClientRect();
        if (rect.width) next.set(link, { x: rect.left - box.left, w: rect.width });
      });
      metrics = next;
    };

    // La chip « Receive » a son propre remplissage : la pastille dessous serait
    // invisible (et donnerait l'impression qu'elle a disparu).
    const pillable = (link) => Boolean(link) && !link.classList.contains('nv-chip');

    const paintPill = (target, instant) => {
      if (!pill || !linksBox) return;
      if (!pillable(target) || panelMode()) {
        pill.classList.remove('is-visible');
        return;
      }
      if (!metrics) measure();
      const spot = metrics && metrics.get(target);
      if (!spot) {
        pill.classList.remove('is-visible');
        return;
      }
      if (instant) pill.classList.add('is-instant');
      pill.style.setProperty('--nv-pill-x', `${spot.x.toFixed(1)}px`);
      pill.style.setProperty('--nv-pill-w', `${spot.w.toFixed(1)}px`);
      pill.classList.add('is-visible');
      if (instant) window.requestAnimationFrame(() => pill.classList.remove('is-instant'));
    };

    const currentLink = () => items.find((link) => link.classList.contains('is-current')) || null;
    const returnPill = () => paintPill(hovered || currentLink());

    // ---------------------------------------------------------------------
    // Lien courant
    // ---------------------------------------------------------------------
    const markCurrent = (target) => {
      items.forEach((link) => {
        const isCurrent = link === target;
        link.classList.toggle('is-current', isCurrent);
        if (!isCurrent) {
          link.removeAttribute('aria-current');
          return;
        }
        // Une ancre de section n'est pas une « page » : aria-current="location".
        let isAnchor = false;
        try {
          isAnchor = Boolean(new URL(link.href, window.location.href).hash);
        } catch (_error) {
          isAnchor = false;
        }
        link.setAttribute('aria-current', isAnchor ? 'location' : 'page');
      });
      if (!hovered) paintPill(target);
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
    items.forEach((link) => {
      link.addEventListener('pointerenter', () => {
        hovered = link;
        paintPill(link);
      }, { passive: true, signal });
      link.addEventListener('focus', () => {
        hovered = link;
        paintPill(link);
      }, { signal });
      link.addEventListener('click', () => closeMenu(false), { signal });
    });

    if (linksBox) {
      linksBox.addEventListener('pointerleave', () => {
        hovered = null;
        returnPill();
      }, { passive: true, signal });
      linksBox.addEventListener('focusout', (event) => {
        if (linksBox.contains(event.relatedTarget)) return;
        hovered = null;
        returnPill();
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
    // L'état ouvert/fermé appartient à device.js (script bloquant, exécuté avant
    // le premier rendu : voir `window.__dropqrSetMenu`). Ce fichier ne pose
    // AUCUN écouteur de clic sur le bouton : un seul propriétaire, donc aucun
    // clic perdu ni double bascule, même si ce script arrive en retard.
    // Ici on s'occupe du focus, du piège de clavier et de la remise en état.
    const focusables = () => {
      const nodes = [burger, ...items].filter(Boolean);
      return nodes.filter((node) => node.offsetParent !== null || node === burger);
    };

    const isOpen = () => nv.classList.contains('open');

    const closeMenu = (restoreFocus) => {
      if (typeof window.__dropqrSetMenu === 'function') {
        window.__dropqrSetMenu(false, { restoreFocus: Boolean(restoreFocus) });
        return;
      }
      // Repli si device.js n'est pas là (page isolée, test).
      nv.classList.remove('open');
      if (burger) burger.setAttribute('aria-expanded', 'false');
      document.documentElement.classList.remove('nav-open');
      if (restoreFocus && burger) burger.focus({ preventScroll: true });
    };

    // Filet de sécurité : si device.js n'a pas pu s'exécuter (page isolée, test,
    // fichier bloqué), ce script prend le relais sur le clic. Le test porte sur
    // l'API elle-même : jamais deux gestionnaires en même temps.
    if (!window.__dropqrSetMenu && burger) {
      const setMenuDirect = (next, restoreFocus) => {
        const open = Boolean(next) && panelMode();
        nv.classList.toggle('open', open);
        burger.setAttribute('aria-expanded', String(open));
        document.documentElement.classList.toggle('nav-open', open);
        if (open) {
          nv.classList.remove('is-hidden');
          window.setTimeout(() => {
            const first = items[0];
            if (isOpen() && first) first.focus({ preventScroll: true });
          }, 70);
        } else if (restoreFocus) {
          burger.focus({ preventScroll: true });
        }
      };
      burger.addEventListener('click', () => setMenuDirect(!isOpen()), { signal });
      if (scrim) scrim.addEventListener('click', () => setMenuDirect(false, true), { signal });
      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !isOpen()) return;
        event.preventDefault();
        setMenuDirect(false, true);
      }, { signal });
      document.addEventListener('click', (event) => {
        if (!isOpen() || nv.contains(event.target)) return;
        setMenuDirect(false, false);
      }, { signal });
    }

    nv.addEventListener('nav:menu', (event) => {
      const detail = (event && event.detail) || {};
      if (detail.open) {
        nv.classList.remove('is-hidden');
        window.setTimeout(() => {
          const first = items[0];
          // Si le panneau a été refermé entre-temps, on ne déplace pas le focus.
          if (isOpen() && first && panelMode()) first.focus({ preventScroll: true });
        }, 70);
      } else if (detail.restoreFocus && burger) {
        burger.focus({ preventScroll: true });
      }
    }, { signal });

    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Tab' || !isOpen() || !panelMode()) return;
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
      if (next && (isOpen() || focusInLinks)) return;
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

    // Les largeurs changent au redimensionnement ou quand la police arrive :
    // on remesure alors la pastille (jamais pendant un survol).
    let resizing = false;
    const refreshPill = () => {
      resizing = false;
      measure();
      if (!hovered) paintPill(currentLink(), true);
    };
    const requestRefresh = () => {
      if (resizing) return;
      resizing = true;
      window.requestAnimationFrame(refreshPill);
    };

    window.addEventListener('resize', requestRefresh, { passive: true, signal });
    window.addEventListener('resize', () => {
      if (!panelMode() && isOpen()) closeMenu(false);
    }, { passive: true, signal });
    nv.addEventListener('focusin', () => setHidden(false), { signal });

    if (bar && 'ResizeObserver' in window) {
      const ro = new ResizeObserver(requestRefresh);
      ro.observe(bar);
      signal.addEventListener('abort', () => ro.disconnect(), { once: true });
    }

    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (!signal.aborted) requestRefresh();
      }).catch(() => {});
    }

    // ---------------------------------------------------------------------
    // Démarrage
    // ---------------------------------------------------------------------
    if (!panelMode() && isOpen()) closeMenu(false);
    requestScroll();

    // La pastille est peinte dans la même frame que le retrait du repli CSS :
    // l'état courant est donc déjà à sa place au premier rendu utile.
    window.requestAnimationFrame(() => {
      if (signal.aborted) return;
      measure();
      paintPill(currentLink(), true);
      document.documentElement.classList.add('nv-js');
    });
  };

  initNav();
  window.addEventListener('pjax:load', initNav);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) initNav();
  });
  window.addEventListener('pagehide', () => {
    document.documentElement.classList.remove('nav-open');
  });
})();
