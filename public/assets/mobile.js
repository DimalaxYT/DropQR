'use strict';

// DropQR — améliorations propres à la version téléphone.
// Les pages mobiles réutilisent upload.js / receive.js / dashboard.js (mêmes
// identifiants HTML): ce fichier n'ajoute que les gestes « natifs »:
//   - boutons Appareil photo / Galerie branchés sur le champ fichier principal;
//   - partage natif (Web Share API) du lien créé ou reçu;
//   - (la page Recevoir est entièrement gérée par receive.js, commun aux deux
//     versions : collage, scan de QR, codes récents, compte à rebours) ;
//   - défilement vers le résultat + petite vibration quand l'envoi est prêt;
//   - barre d'onglets masquée quand le clavier virtuel est ouvert.

(() => {
  const canShare = typeof navigator.share === 'function';
  const vibrate = (pattern) => { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_error) {} };

  async function shareUrl(url, title) {
    if (!url) return;
    try {
      await navigator.share({ title: title || 'DropQR', text: title ? `${title} — via DropQR` : 'Fichier partagé avec DropQR', url });
    } catch (error) {
      if (error && error.name === 'AbortError') return; // l'utilisateur a fermé la feuille
      try { await navigator.clipboard.writeText(url); } catch (_error) { window.prompt('Copie le lien:', url); }
    }
  }

  function initUpload() {
    const form = document.getElementById('uploadForm');
    const fileInput = document.getElementById('fileInput');
    if (!form || !fileInput || form.dataset.mobileInit === '1') return;
    form.dataset.mobileInit = '1';

    // Appareil photo / Galerie -> on recopie le fichier dans le champ principal
    // puis on déclenche "change": upload.js fait le reste.
    ['cameraInput', 'galleryInput'].forEach((id) => {
      const input = document.getElementById(id);
      if (!input) return;
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file) return;
        try {
          const transfer = new DataTransfer();
          transfer.items.add(file);
          fileInput.files = transfer.files;
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (_error) {
          // Très vieux navigateurs sans DataTransfer: on ouvre le sélecteur classique.
          fileInput.click();
        }
        input.value = '';
      });
    });

    const result = document.getElementById('result');
    const shareBtn = document.getElementById('shareNative');
    const copyBtn = document.getElementById('copyButton');
    const resultName = document.getElementById('resultName');

    if (shareBtn && canShare) {
      shareBtn.classList.remove('hidden');
      shareBtn.addEventListener('click', () => shareUrl(copyBtn && copyBtn.dataset.url, resultName && resultName.textContent));
    }

    // Quand le résultat apparaît: vibration + défilement jusqu'au QR.
    if (result && 'MutationObserver' in window) {
      let wasVisible = result.classList.contains('visible');
      const observer = new MutationObserver(() => {
        const visible = result.classList.contains('visible');
        if (visible && !wasVisible) {
          vibrate([18, 40, 18]);
          window.setTimeout(() => result.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
        }
        wasVisible = visible;
      });
      observer.observe(result, { attributes: true, attributeFilter: ['class'] });
    }

    // Empêche l'écran de se mettre en veille pendant un envoi (si supporté).
    let wakeLock = null;
    const progressPanel = document.getElementById('progressPanel');
    if (progressPanel && 'wakeLock' in navigator && 'MutationObserver' in window) {
      new MutationObserver(async () => {
        const uploading = progressPanel.classList.contains('visible');
        try {
          if (uploading && !wakeLock) {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
          } else if (!uploading && wakeLock) {
            await wakeLock.release();
            wakeLock = null;
          }
        } catch (_error) { wakeLock = null; }
      }).observe(progressPanel, { attributes: true, attributeFilter: ['class'] });
    }
  }

  // Clavier virtuel: la visualViewport rétrécit nettement quand il s'ouvre.
  let keyboardWatch = false;
  function initKeyboardWatch() {
    if (keyboardWatch || !window.visualViewport) return;
    keyboardWatch = true;
    const root = document.documentElement;
    const update = () => {
      const open = window.visualViewport.height < window.innerHeight * 0.78;
      root.classList.toggle('kb-open', open);
    };
    window.visualViewport.addEventListener('resize', update, { passive: true });
    update();
  }

  // Onglet actif après une navigation PJAX (la barre fait partie du shell,
  // mais on resynchronise au cas où).
  function syncTabs() {
    const path = window.location.pathname.replace(/\/+$/, '') || '/';
    document.querySelectorAll('.m-tabbar a').forEach((link) => {
      const target = new URL(link.href, window.location.href).pathname.replace(/\/+$/, '') || '/';
      const active = target === path;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  const init = () => {
    initUpload();
    initKeyboardWatch();
    syncTabs();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  window.addEventListener('pjax:load', init);
})();
