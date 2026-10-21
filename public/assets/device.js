/* DropQR — détection automatique PC / téléphone (côté navigateur)
 *
 * Le serveur choisit déjà la bonne version (Client Hints + User-Agent). Ce
 * script, chargé en premier dans <head>, vérifie ce choix avec des indices que
 * seul le navigateur connaît (écran tactile, taille réelle de l'écran,
 * navigator.userAgentData) et corrige si besoin:
 *   - il écrit le cookie `dropqr_device=mobile|desktop`;
 *   - il recharge la page UNE seule fois (garde-fou sessionStorage: jamais de
 *     boucle, même sur un hébergement statique qui ignorerait le cookie).
 * Un choix manuel (liens « Version PC » / « Version mobile », cookie
 * `dropqr_view`) est toujours prioritaire.
 *
 * Il expose aussi window.DropQRDevice pour les autres scripts.
 */
(function () {
  'use strict';

  var root = document.documentElement;
  var servedAttr = root.getAttribute('data-view');
  var MOBILE_UA = /Mobi|iPhone|iPod|Android.+Mobile|Windows Phone|IEMobile|BlackBerry|BB10|Opera Mini|webOS/i;

  function readCookie(name) {
    var parts = document.cookie ? document.cookie.split(';') : [];
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i].replace(/^\s+/, '');
      if (part.indexOf(name + '=') === 0) {
        try { return decodeURIComponent(part.slice(name.length + 1)); } catch (_e) { return ''; }
      }
    }
    return '';
  }

  function mq(query) {
    try { return window.matchMedia(query).matches; } catch (_e) { return false; }
  }

  function detect() {
    var ua = navigator.userAgent || '';
    var uaData = navigator.userAgentData;
    var uaMobile = uaData && typeof uaData.mobile === 'boolean' ? uaData.mobile : MOBILE_UA.test(ua);

    // Écran uniquement tactile (pas de souris) et petit côté <= 540 px: c'est un
    // téléphone, même si l'UA a été modifié. Les tablettes restent en version PC.
    var touchOnly = mq('(pointer: coarse)') && !mq('(any-pointer: fine)') && !mq('(hover: hover)');
    var shortSide = Math.min(window.screen.width || 0, window.screen.height || 0) || Math.min(window.innerWidth, window.innerHeight);
    var phoneScreen = touchOnly && shortSide > 0 && shortSide <= 540;

    return {
      view: uaMobile || phoneScreen ? 'mobile' : 'desktop',
      touch: touchOnly,
      shortSide: shortSide,
      uaMobile: !!uaMobile
    };
  }

  var info = detect();
  var manual = readCookie('dropqr_view');
  if (manual !== 'mobile' && manual !== 'desktop') manual = '';
  // Pages communes aux deux versions (aide, mentions, téléchargement): la
  // « version » affichée est celle qu'on aurait servie.
  var served = servedAttr === 'mobile' || servedAttr === 'desktop'
    ? servedAttr
    : (manual || readCookie('dropqr_device') || info.view);
  if (served !== 'mobile' && served !== 'desktop') served = info.view;

  root.classList.add('view-' + served);
  root.setAttribute('data-device', info.view);

  // Seules les pages qui existent en deux versions déclenchent une correction.
  var switchable = root.hasAttribute('data-switchable');
  if (switchable && !manual && info.view !== served) {
    var guardKey = 'dropqr.device.fix.' + info.view;
    var alreadyTried = false;
    try { alreadyTried = sessionStorage.getItem(guardKey) === '1'; } catch (_e) { alreadyTried = true; }
    if (!alreadyTried) {
      try { sessionStorage.setItem(guardKey, '1'); } catch (_e) {}
      var secure = window.location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = 'dropqr_device=' + info.view + '; Path=/; Max-Age=2592000; SameSite=Lax' + secure;
      window.location.reload();
      return;
    }
  }

  // Liens « Version PC » / « Version mobile » (attribut data-view-switch).
  function updateSwitchLinks() {
    var other = served === 'mobile' ? 'desktop' : 'mobile';
    var links = document.querySelectorAll('[data-view-switch]');
    for (var i = 0; i < links.length; i += 1) {
      links[i].setAttribute('href', '?view=' + other);
      links[i].setAttribute('data-no-pjax', '');
      links[i].textContent = other === 'mobile' ? 'Version mobile' : 'Version PC';
      links[i].title = other === 'mobile'
        ? 'Afficher la version téléphone (choix mémorisé)'
        : 'Afficher la version ordinateur (choix mémorisé)';
    }
    var autoLinks = document.querySelectorAll('[data-view-auto]');
    for (var j = 0; j < autoLinks.length; j += 1) {
      autoLinks[j].setAttribute('href', '?view=auto');
      autoLinks[j].setAttribute('data-no-pjax', '');
      autoLinks[j].hidden = !manual;
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', updateSwitchLinks);
  else updateSwitchLinks();
  window.addEventListener('pjax:load', updateSwitchLinks);

  // ---------------------------------------------------------------------
  // Menu de la barre : un seul propriétaire
  // ---------------------------------------------------------------------
  // Ce fichier est le seul script bloquant (dans <head>) : il s'exécute avant
  // le premier rendu. C'est donc lui qui possède l'état du menu — et lui seul.
  // L'écouteur est délégué au document : il survit aux remplacements PJAX de
  // #nv, il est actif dès le premier pixel et il ne peut pas « manquer » parce
  // qu'un autre script serait arrivé en retard. nav.js ne fait que s'abonner
  // à l'événement `nav:menu` pour le focus et le verrou de défilement.
  function navRoot() {
    return document.getElementById('nv');
  }

  function setMenu(open, options) {
    var nv = navRoot();
    if (!nv) return;
    var opts = options || {};
    var wasOpen = nv.classList.contains('open');
    // La case à cocher est la source native (le CSS s'en sert directement).
    var toggle = nv.querySelector('.nv-toggle');
    if (toggle && toggle.checked !== open) toggle.checked = open;
    if (open && !wasOpen) {
      // Compense la barre de défilement qui disparaît (voir nav.css).
      var sbw = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
      document.documentElement.style.setProperty('--nv-sbw', sbw + 'px');
    }
    nv.classList.toggle('open', open);
    if (open) nv.classList.remove('is-hidden');
    var burger = nv.querySelector('.nv-burger');
    if (burger) burger.setAttribute('aria-expanded', String(open));
    document.documentElement.classList.toggle('nav-open', open);
    if (wasOpen === open) return;
    var detail = { open: open, restoreFocus: !!opts.restoreFocus };
    var evt = null;
    try {
      evt = new CustomEvent('nav:menu', { bubbles: true, detail: detail });
    } catch (_error) {
      evt = document.createEvent('CustomEvent');
      evt.initCustomEvent('nav:menu', true, false, detail);
    }
    nv.dispatchEvent(evt);
  }

  // Exposé pour nav.js (clics sur les liens, redimensionnement).
  window.__dropqrSetMenu = setMenu;

  function handleMenuClick(event) {
    var nv = navRoot();
    var target = event.target;
    if (!nv || !target || !target.closest) return;
    // Le bouton et le voile sont des <label for="nv-menu"> : le navigateur
    // bascule la case tout seul, sans une ligne de JavaScript. On se contente
    // d'écouter `change` plus bas (un seul chemin, aucun double basculement).
    // Bouton ET voile sont des <label for="nv-menu"> : le navigateur bascule la
    // case tout seul et `change` fait le reste. Toucher à l'état ici fermerait
    // puis rouvrirait le panneau (la bascule native arriverait après nous).
    if (target.closest('.nv-burger') || target.closest('.nv-scrim')) return;
    if (!nv.classList.contains('open')) return;
    if (!nv.contains(target)) setMenu(false);
  }

  document.addEventListener('click', function (event) {
    try {
      handleMenuClick(event);
    } catch (error) {
      // Un clic sur le menu ne doit jamais rester sans effet ni sans trace.
      console.error('DropQR menu:', error);
      var nv = navRoot();
      if (nv) nv.classList.toggle('open');
    }
  });

  // Après un remplacement PJAX de #nv, la case repart décochée : on réaligne
  // la classe et le verrou pour qu'aucun état fantôme ne subsiste.
  window.addEventListener('pjax:load', function () {
    var nv = navRoot();
    if (!nv) return;
    var toggle = nv.querySelector('.nv-toggle');
    var checked = !!(toggle && toggle.checked);
    nv.classList.toggle('open', checked);
    document.documentElement.classList.toggle('nav-open', checked);
    var burger = nv.querySelector('.nv-burger');
    if (burger) burger.setAttribute('aria-expanded', String(checked));
  });

  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!target || !target.classList || !target.classList.contains('nv-toggle')) return;
    setMenu(!!target.checked, { restoreFocus: !target.checked });
  });

  document.addEventListener('keydown', function (event) {
    var focused = event.target;
    // Un <label> ne réagit pas au clavier : on le compense ici.
    if (focused && focused.closest && focused.closest('.nv-burger')
      && (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar')) {
      event.preventDefault();
      var root = navRoot();
      if (root) setMenu(!root.classList.contains('open'));
      return;
    }
    if (event.key !== 'Escape') return;
    var nv = navRoot();
    if (!nv || !nv.classList.contains('open')) return;
    event.preventDefault();
    setMenu(false, { restoreFocus: true });
  });

  window.DropQRDevice = {
    served: served,
    detected: info.view,
    manual: manual || null,
    touch: info.touch,
    isMobile: served === 'mobile',
    // Change de version: 'mobile', 'desktop' ou 'auto' (oublie le choix manuel).
    switchTo: function (view) {
      var url = new URL(window.location.href);
      url.searchParams.set('view', view);
      window.location.href = url.pathname + url.search + url.hash;
    }
  };
})();
