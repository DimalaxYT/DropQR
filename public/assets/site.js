'use strict';

// Navigation PJAX + comportements globaux du site.
//
// Règles importantes corrigées ici:
// - on ne précharge QUE des pages statiques sûres (liste blanche). Un lien
//   /download, /view ou /t/:id ne doit JAMAIS être préchargé: une requête
//   préventive téléchargerait le fichier et pourrait déclencher sa suppression
//   avant même que l'utilisateur clique.
// - le cache PJAX stocke le HTML brut, pas le Document parsé: les nœuds d'un
//   Document caché étaient déplacés dans la page courante, ce qui cassait une
//   seconde visite de la même page.
// - chaque initialisation nettoie les écouteurs globaux de la précédente via
//   un AbortController: plus de fuite d'écouteurs scroll/resize.

const pjaxCache = new Map(); // pathname+search -> { text, storedAt }
const pjaxInflight = new Map(); // pathname+search -> Promise<string|null>
const PJAX_CACHE_TTL_MS = 60 * 1000;
const pjaxParser = window.DOMParser ? new DOMParser() : null;

// Seules ces pages peuvent être préchargées en arrière-plan.
const PREFETCH_WHITELIST = new Set(['/', '/upload', '/receive', '/help', '/mentions', '/dashboard']);

const isSafePrefetchPath = (pathname) => PREFETCH_WHITELIST.has(pathname);

// Récupère le HTML d'une page en dédupliquant les requêtes : si un
// préchargement est déjà en vol, le clic réutilise la même promesse au lieu
// d'en lancer une seconde (c'est ce qui donnait l'impression d'un clic lent).
const requestPageHtml = (url, silent) => {
  const key = url.pathname + url.search;
  if (pjaxInflight.has(key)) return pjaxInflight.get(key);
  const task = (async () => {
    try {
      const res = await fetch(url.href, { headers: { 'X-PJAX': 'true' } });
      if (!res.ok) throw new Error('Page not found');
      const text = await res.text();
      pjaxCache.set(key, { text, storedAt: Date.now() });
      return text;
    } catch (error) {
      // Un préchargement qui échoue est sans conséquence : pas de bruit console.
      if (!silent) console.error('PJAX fetch error', error);
      return null;
    } finally {
      pjaxInflight.delete(key);
    }
  })();
  pjaxInflight.set(key, task);
  return task;
};

let siteTeardownController = null;
let siteObserver = null;

const initSite = () => {
  // Nettoie les écouteurs enregistrés lors de la page précédente.
  if (siteTeardownController) siteTeardownController.abort();
  siteTeardownController = new AbortController();
  const { signal } = siteTeardownController;
  if (siteObserver) {
    siteObserver.disconnect();
    siteObserver = null;
  }

  // matchMedia n'existe pas partout (navigateurs anciens, environnements de
  // test) : on répond « non » plutôt que de casser toute la page.
  const media = (query) => {
    try {
      return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
    } catch (_error) {
      return false;
    }
  };
  const reducedMotion = media('(prefers-reduced-motion: reduce)');
  const root = document.documentElement;

  const contactLinks = [...document.querySelectorAll('[data-discord-contact]')];
  const authSlots = [...document.querySelectorAll('[data-discord-auth]')];
  const maxSizeLabels = [...document.querySelectorAll('[data-max-file-size]')];

  // Bouton / état "Se connecter avec Discord" dans la barre de navigation.
  if (authSlots.length) {
    fetch('/api/auth/me', { cache: 'no-store', credentials: 'same-origin' })
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => {
        if (!payload || signal.aborted || !payload.configured) return;
        authSlots.forEach((slot) => {
          slot.textContent = '';
          if (payload.user) {
            const chip = document.createElement('span');
            chip.className = 'discord-chip';

            const avatar = document.createElement('img');
            avatar.src = payload.user.avatar;
            avatar.alt = '';
            avatar.width = 26;
            avatar.height = 26;
            avatar.referrerPolicy = 'no-referrer';

            const name = document.createElement('span');
            name.className = 'discord-chip-name';
            name.textContent = payload.user.globalName || payload.user.username;
            name.title = `Connecté avec Discord: @${payload.user.username}`;

            const logout = document.createElement('button');
            logout.type = 'button';
            logout.className = 'discord-logout';
            logout.textContent = '×';
            logout.title = 'Se déconnecter';
            logout.setAttribute('aria-label', 'Se déconnecter de Discord');
            logout.addEventListener('click', async () => {
              logout.disabled = true;
              try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); }
              catch (_error) {}
              window.location.reload();
            });

            chip.append(avatar, name, logout);
            slot.appendChild(chip);
          } else {
            const link = document.createElement('a');
            link.className = 'discord-auth-btn';
            link.href = `/api/auth/discord/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
            link.textContent = 'Discord';
            link.title = 'Se connecter avec Discord (pour que le staff sache qui envoie)';
            slot.appendChild(link);
          }
        });
      })
      .catch(() => {});
  }

  if (contactLinks.length || maxSizeLabels.length) {
    fetch('/api/config', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((config) => {
        if (!config || signal.aborted) return;
        if (config.discordContactUrl) {
          contactLinks.forEach((link) => {
            link.href = config.discordContactUrl;
            link.hidden = false;
            link.textContent = 'Discord';
          });
        }
        if (config.maxFileSizeHuman) {
          maxSizeLabels.forEach((label) => { label.textContent = config.maxFileSizeHuman; });
        }
      })
      .catch(() => {});
  }

  // La barre de navigation est gérée par assets/nav.js (chargé sur toutes les
  // pages, y compris la landing) : menu, pastille, progression, scroll-spy.

  // Sommaire Aide / Mentions: surligne la section visible.
  const docLinks = [...document.querySelectorAll('.docs-nav a[href^="#"]')];
  if (docLinks.length && 'IntersectionObserver' in window) {
    const byId = new Map(docLinks.map((link) => [link.getAttribute('href').slice(1), link]));
    const spy = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        docLinks.forEach((link) => link.classList.remove('current'));
        const link = byId.get(entry.target.id);
        if (link) link.classList.add('current');
      });
    }, { rootMargin: '-35% 0px -55% 0px' });
    byId.forEach((_link, id) => { const section = document.getElementById(id); if (section) spy.observe(section); });
    signal.addEventListener('abort', () => spy.disconnect());
  }

  const parallaxItems = [...document.querySelectorAll('[data-parallax]')];
  const revealItems = [...document.querySelectorAll('.stat-card, .feature-card, .info-strip, .doc-section .card')];

  if (!reducedMotion) {
    root.classList.add('motion-ready');
    const firstViewport = window.innerHeight * 0.92;
    revealItems.forEach((item, index) => {
      item.classList.add('reveal-item');
      item.style.setProperty('--reveal-delay', `${Math.min(index, 8) * 35}ms`);
      if (item.getBoundingClientRect().top < firstViewport) item.classList.add('is-visible');
    });
  } else {
    revealItems.forEach((item) => item.classList.add('is-visible'));
  }

  if ('IntersectionObserver' in window && !reducedMotion) {
    siteObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          siteObserver.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    revealItems.forEach((item) => siteObserver.observe(item));
  } else {
    revealItems.forEach((item) => item.classList.add('is-visible'));
  }

  const prefetched = new Set();
  const internalLinks = [...document.querySelectorAll('a[href]')]
    .map((link) => {
      let url = null;
      try { url = new URL(link.getAttribute('href'), window.location.href); } catch (_error) { return null; }
      return { link, url };
    })
    .filter((entry) => entry
      && entry.url.origin === window.location.origin
      && !entry.link.target
      && !entry.link.hasAttribute('download')
      && !entry.link.hasAttribute('data-no-pjax')
      && !entry.url.searchParams.has('view')
      && isSafePrefetchPath(entry.url.pathname))
    .filter((entry, index, links) => links.findIndex((other) => other.url.href === entry.url.href) === index);

  const prefetchPage = (url) => {
    const key = url.pathname + url.search;
    if (prefetched.has(key)) return;
    prefetched.add(key);
    if (!pjaxParser || !isSafePrefetchPath(url.pathname) || signal.aborted) return;
    requestPageHtml(url, true).catch(() => {});
  };

  internalLinks.forEach(({ link, url }) => {
    // Préchargement à l'approche du clic (survol, doigt posé, tabulation).
    link.addEventListener('pointerenter', () => prefetchPage(url), { passive: true, signal });
    link.addEventListener('pointerdown', () => prefetchPage(url), { passive: true, signal });
    link.addEventListener('focus', () => prefetchPage(url), { signal });
  });

  const warmNavigation = () => {
    if (signal.aborted) return;
    // On ne réchauffe que les pages de la barre de navigation : précharger tous
    // les liens de la page saturait la connexion et retardait les clics.
    const warm = internalLinks.filter(({ link }) => link.closest('#nv'));
    warm.forEach(({ url }, index) => {
      window.setTimeout(() => prefetchPage(url), index * 120);
    });
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback(warmNavigation, { timeout: 900 });
  else window.setTimeout(warmNavigation, 250);

  if (!reducedMotion && parallaxItems.length) {
    let frame = null;
    const updateParallax = () => {
      frame = null;
      if (signal.aborted) return;
      const viewport = window.innerHeight || 1;
      parallaxItems.forEach((item) => {
        const speed = Number(item.dataset.speed || -0.08);
        const rect = item.getBoundingClientRect();
        const previous = parseFloat(item.style.getPropertyValue('--parallax-y')) || 0;
        const layoutTop = rect.top - previous;
        const rawDistance = (layoutTop + rect.height / 2 - viewport / 2) * speed;
        const distance = Math.max(-72, Math.min(72, rawDistance));
        item.style.setProperty('--parallax-y', `${distance.toFixed(2)}px`);
      });
    };

    const requestParallax = () => {
      if (frame === null) frame = window.requestAnimationFrame(updateParallax);
    };

    window.addEventListener('scroll', requestParallax, { passive: true, signal });
    window.addEventListener('resize', requestParallax, { passive: true, signal });
    window.addEventListener('pageshow', requestParallax, { passive: true, signal });
    requestParallax();
  }
};

initSite();
window.addEventListener('pjax:load', initSite);

(() => {
  if (!pjaxParser) return;

  let isNavigating = false;

  const readCached = (key) => {
    const entry = pjaxCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.storedAt > PJAX_CACHE_TTL_MS) {
      pjaxCache.delete(key);
      return null;
    }
    return entry.text;
  };

  const fetchPage = async (url) => {
    const cached = readCached(url.pathname + url.search);
    if (cached !== null) return cached;
    return requestPageHtml(url);
  };

  const navigate = async (url) => {
    if (isNavigating) return;
    isNavigating = true;

    // Retour visuel immédiat (voir nav.css) : le clic ne reste jamais muet,
    // même si la requête met du temps.
    document.documentElement.classList.add('pjax-loading');

    // Filet de sécurité : au-delà de 2,5 s on laisse le navigateur faire une
    // navigation classique (sa propre barre de chargement rassure l'utilisateur)
    // plutôt que de laisser la page figée.
    const html = await Promise.race([
      fetchPage(url),
      new Promise((resolve) => window.setTimeout(() => resolve(null), 2500))
    ]);

    if (html === null) {
      isNavigating = false;
      document.documentElement.classList.remove('pjax-loading');
      window.location.href = url.href; // Fallback: chargement classique.
      return;
    }

    // On parse à chaque navigation: les nœuds cachés ne sont jamais réutilisés.
    const doc = pjaxParser.parseFromString(html, 'text/html');
    const shell = document.querySelector('.shell');
    const main = shell ? shell.querySelector('main') : null;
    const newShell = doc.querySelector('.shell');
    const newMain = newShell ? newShell.querySelector('main') : null;
    // Les deux pages doivent partager la même feuille de style: la landing
    // (WebGL, landing.css) exige toujours un chargement complet.
    const styleOf = (d) => [...d.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute('href').split('?')[0]).join('|');
    const sameLayout = styleOf(doc) === styleOf(document);

    if (shell && main && newMain && sameLayout) {
      document.body.className = doc.body.className;
      document.title = doc.title;
      // Remplace tout le contenu du shell (en-tête de page + main + footer).
      shell.replaceChildren(...newShell.childNodes);

      const newNav = doc.getElementById('nv');
      const oldNav = document.getElementById('nv');
      if (newNav && oldNav) {
        oldNav.innerHTML = newNav.innerHTML;
      }

      const newFooter = doc.querySelector('footer.site-footer');
      const oldFooter = document.querySelector('footer.site-footer');
      if (newFooter && oldFooter) {
        oldFooter.innerHTML = newFooter.innerHTML;
      }

      const knownScripts = new Set(Array.from(document.querySelectorAll('script[src]')).map((s) => s.src.split('?')[0]));
      const newScripts = Array.from(doc.querySelectorAll('script[src]'));

      for (const s of newScripts) {
        const srcBase = s.src.split('?')[0];
        if (!knownScripts.has(srcBase)) {
          const newScript = document.createElement('script');
          newScript.src = s.src;
          document.body.appendChild(newScript);
          knownScripts.add(srcBase);
        }
      }

      // Les scripts de page viennent d'être injectés: leur init s'exécute à
      // l'insertion, puis pjax:load relance initSite + les inits (protégées
      // contre le double appel par chaque script de page).
      window.dispatchEvent(new Event('pjax:load'));
    } else {
      window.location.href = url.href;
      return;
    }

    document.documentElement.classList.remove('pjax-loading');
    isNavigating = false;
  };


  document.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a || !a.href || a.target || a.hasAttribute('download') || a.hasAttribute('data-no-pjax')) return;

    const url = new URL(a.href);
    if (url.origin !== window.location.origin) return;
    // Changement de version PC / mobile: toujours un chargement complet.
    if (url.searchParams.has('view')) return;
    if (url.pathname.startsWith('/api') || url.pathname.startsWith('/download') || url.pathname.startsWith('/view')) return;
    // La landing (scène WebGL) se charge toujours normalement.
    if (url.pathname === '/' || url.pathname === '/home.html') return;

    // Handle hash links on the SAME page
    if (url.pathname === window.location.pathname && url.hash) {
      // Allow default browser behavior for anchor jumps
      return;
    }

    e.preventDefault();
    if (url.pathname !== window.location.pathname || url.search !== window.location.search) {
      history.pushState({}, '', url.href);
      navigate(url).then(() => {
        if (url.hash) {
          const target = document.getElementById(url.hash.substring(1));
          if (target) target.scrollIntoView();
        } else {
          window.scrollTo(0, 0);
        }
      });
    } else {
      window.scrollTo(0, 0);
    }
  });

  window.addEventListener('popstate', () => {
    navigate(new URL(window.location.href)).then(() => {
      const url = new URL(window.location.href);
      if (url.hash) {
        const target = document.getElementById(url.hash.substring(1));
        if (target) target.scrollIntoView();
      } else {
        window.scrollTo(0, 0);
      }
    });
  });
})();
