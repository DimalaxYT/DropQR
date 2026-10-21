'use strict';

// DropQR — page Recevoir.
//
// Un seul fichier pour les deux versions (PC et téléphone) : les éléments sont
// optionnels et détectés un par un, donc le même code pilote les deux mises en
// page. Responsabilités :
//   - recherche d'un transfert par code (avec annulation des requêtes obsolètes) ;
//   - états du deck Code Slots : loading / error / success ;
//   - panneau résultat : type de fichier, compte à rebours vivant, métadonnées,
//     téléchargement, copie du lien, partage natif ;
//   - état vide et état d'erreur dédiés ;
//   - codes récents (localStorage), cliquables ;
//   - collage presse-papiers et scan de QR (caméra ou image, jsQR chargé à la demande) ;
//   - raccourcis clavier, toasts, synchronisation de l'URL (?code=...).

(() => {
  const RECENT_KEY = 'dropqr.recent.v1';
  const RECENT_MAX = 4;
  const SCAN_INTERVAL_MS = 110;

  // ---------------------------------------------------------------------------
  // Utilitaires
  // ---------------------------------------------------------------------------
  const normalize = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);

  // Extrait un code (ou l'URL de partage) d'un texte : code brut, ?code=, /c/CODE,
  // /code/CODE, ou lien de partage /t/ID.
  const extractFromText = (text) => {
    const value = String(text || '').trim();
    if (!value) return { code: '', shareUrl: '' };
    try {
      const url = new URL(value);
      const fromQuery = url.searchParams.get('code');
      if (fromQuery) return { code: normalize(fromQuery), shareUrl: '' };
      const direct = url.pathname.match(/\/(?:c|code)\/([A-Za-z0-9-]+)/);
      if (direct) return { code: normalize(direct[1]), shareUrl: '' };
      if (/\/(?:t|share)\/[A-Za-z0-9_-]+/.test(url.pathname)) return { code: '', shareUrl: url.href };
      return { code: '', shareUrl: '' };
    } catch (_error) {
      return { code: normalize(value), shareUrl: '' };
    }
  };

  const formatDate = (value) => {
    try {
      return new Date(value).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    } catch (_error) {
      return '—';
    }
  };

  const formatSpan = (seconds) => {
    const total = Math.max(0, Math.floor(seconds));
    if (total >= 3600) {
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      return minutes ? `${hours} h ${String(minutes).padStart(2, '0')}` : `${hours} h`;
    }
    if (total >= 60) {
      const minutes = Math.floor(total / 60);
      const rest = total % 60;
      return rest ? `${minutes} min ${String(rest).padStart(2, '0')}` : `${minutes} min`;
    }
    return `${total} s`;
  };

  const formatAgo = (timestamp) => {
    const seconds = Math.max(0, Math.round((Date.now() - Number(timestamp || 0)) / 1000));
    if (seconds < 60) return "à l'instant";
    if (seconds < 3600) return `il y a ${Math.floor(seconds / 60)} min`;
    if (seconds < 86400) return `il y a ${Math.floor(seconds / 3600)} h`;
    return `il y a ${Math.floor(seconds / 86400)} j`;
  };

  const kindOf = (mime, name) => {
    const type = String(mime || '').toLowerCase();
    if (type.startsWith('video/')) return 'video';
    if (type.startsWith('image/')) return 'image';
    if (type.startsWith('audio/')) return 'audio';
    if (/zip|rar|7z|tar|gzip|compressed/.test(type)) return 'archive';
    const ext = String(name || '').split('.').pop().toLowerCase();
    if (['mp4', 'mov', 'mkv', 'webm', 'avi'].includes(ext)) return 'video';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'avif', 'svg'].includes(ext)) return 'image';
    if (['mp3', 'wav', 'flac', 'm4a', 'ogg'].includes(ext)) return 'audio';
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive';
    return 'file';
  };

  const extOf = (name) => {
    const parts = String(name || '').split('.');
    if (parts.length < 2) return 'FILE';
    return parts.pop().slice(0, 4).toUpperCase() || 'FILE';
  };

  const vibrate = (pattern) => {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (_error) {
      /* API absente : sans importance */
    }
  };

  // Les Media Queries ne sont pas garanties (navigateurs anciens, environnements
  // de test) : on répond « non » plutôt que de casser la page.
  const media = (query) => {
    try {
      return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
    } catch (_error) {
      return false;
    }
  };

  const prefersReducedMotion = () => media('(prefers-reduced-motion: reduce)');
  const isSmallScreen = () => media('(max-width: 900px)');
  const isPointerFine = () => media('(pointer: fine)');

  const readRecent = () => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(RECENT_KEY) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((item) => item && /^[A-Z0-9]{4,12}$/.test(String(item.code || '')))
        .slice(0, RECENT_MAX);
    } catch (_error) {
      return [];
    }
  };

  const writeRecent = (items) => {
    try {
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(items.slice(0, RECENT_MAX)));
    } catch (_error) {
      /* stockage plein ou désactivé : on continue sans historique */
    }
  };

  // ---------------------------------------------------------------------------
  // Initialisation (relancée après chaque navigation PJAX)
  // ---------------------------------------------------------------------------
  let documentController = null;
  let cleanupPrevious = null;

  const initReceivePage = () => {
    const form = document.getElementById('receiveForm');
    const input = document.getElementById('transferCode');
    if (!form || !input) return;
    if (form.dataset.rxInit === '1') return;
    form.dataset.rxInit = '1';

    // Navigation PJAX : on coupe d'abord la minuterie, la caméra et les
    // écouteurs de l'instance précédente, sinon ils s'empilent.
    if (cleanupPrevious) {
      cleanupPrevious();
      cleanupPrevious = null;
    }

    // Les écouteurs attachés à document survivent aux navigations PJAX : on les
    // recrée proprement à chaque initialisation, sinon ils s'empilent.
    if (documentController) documentController.abort();
    documentController = new AbortController();
    const docSignal = documentController.signal;

    const $ = (id) => document.getElementById(id);
    const status = $('receiveStatus');
    const empty = $('rxEmpty');
    const errorPanel = $('rxError');
    const errorTitle = $('rxErrorTitle');
    const errorMessage = $('rxErrorMessage');
    const retry = $('rxRetry');
    const result = $('receiveResult');
    const codeBadge = $('resultCodeBadge');
    const fileName = $('receiveFileName');
    const fileIcon = $('rxFileIcon');
    const size = $('receiveSize');
    const expiry = $('receiveExpiry');
    const downloads = $('receiveDownloads');
    const cleanup = $('receiveCleanup');
    const downloadButton = $('downloadButton');
    const copyButton = $('copyReceiveLink');
    const shareButton = $('shareReceiveLink');
    const note = $('rxResultNote');
    const video = $('receiveVideo');
    const countdown = $('rxCountdown');
    const countdownBar = $('rxCountdownBar');
    const countdownLabel = $('rxCountdownLabel');
    const refreshButton = $('rxRefresh');
    const pasteButton = $('pasteCode');
    const scanButton = $('scanQr');
    const recentWrap = $('recentWrap');
    const recentList = $('recentList');
    const clearRecent = $('clearRecent');
    const toastEl = $('rxToast');
    const scanOverlay = $('scanOverlay');
    const scanVideo = $('scanVideo');
    const scanHint = $('scanHint');
    const scanClose = $('scanClose');
    const scanManual = $('scanManual');
    const scanFileInput = $('scanFileInput');
    const scanView = scanOverlay ? scanOverlay.querySelector('.rx-scan-view') : null;

    let current = null;
    let controller = null;
    let countdownTimer = 0;
    let deadline = 0;
    let totalSeconds = 0;
    let toastTimer = 0;

    // -------------------------------------------------------------------------
    // Feedback
    // -------------------------------------------------------------------------
    function setStatus(message, type = '') {
      if (!status) return;
      status.className = `status rx-status ${type}`.trim();
      status.textContent = message;
    }

    function toast(message, isError = false) {
      if (!toastEl) return;
      toastEl.textContent = message;
      toastEl.classList.toggle('is-error', isError);
      toastEl.classList.add('is-visible');
      if (toastTimer) window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => toastEl.classList.remove('is-visible'), 2600);
    }

    function busy(state) {
      form.classList.toggle('is-busy', state);
      if (refreshButton) refreshButton.disabled = state;
    }

    // -------------------------------------------------------------------------
    // Code Slots
    // -------------------------------------------------------------------------
    function setCode(value, options) {
      if (input.codeSlots) input.codeSlots.setValue(value, options);
      else input.value = normalize(value);
    }

    function codeStatus(value, options) {
      if (input.codeSlots) input.codeSlots.setStatus(value, options);
    }

    function focusCode() {
      if (input.codeSlots) input.codeSlots.focus();
      else input.focus();
    }

    // -------------------------------------------------------------------------
    // Panneaux
    // -------------------------------------------------------------------------
    function showEmpty() {
      if (empty) empty.classList.remove('hidden');
      if (errorPanel) errorPanel.classList.add('hidden');
      if (result) result.classList.add('hidden');
    }

    function showError(title, message) {
      if (empty) empty.classList.add('hidden');
      if (result) result.classList.add('hidden');
      if (!errorPanel) {
        setStatus(message, 'error');
        return;
      }
      if (errorTitle) errorTitle.textContent = title;
      if (errorMessage) errorMessage.textContent = message;
      errorPanel.classList.remove('hidden');
      errorPanel.classList.remove('is-in');
      void errorPanel.offsetWidth;
      errorPanel.classList.add('is-in');
    }

    function stopCountdown() {
      if (countdownTimer) {
        window.clearInterval(countdownTimer);
        countdownTimer = 0;
      }
    }

    function paintCountdown() {
      if (!countdown || !countdownLabel) return;
      // Le panneau a pu être remplacé par une navigation PJAX : on s'arrête.
      if (!document.contains(countdown)) {
        stopCountdown();
        return;
      }
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      const ratio = totalSeconds > 0 ? Math.max(0, Math.min(1, left / totalSeconds)) : 0;
      if (countdownBar) countdownBar.style.setProperty('--rx-left', `${(ratio * 100).toFixed(2)}%`);
      countdown.classList.toggle('is-warning', left > 0 && left <= 60);
      countdown.classList.toggle('is-over', left <= 0);

      if (left <= 0) {
        countdownLabel.textContent = 'Expiré — le fichier a été supprimé';
        if (downloadButton) {
          downloadButton.classList.add('is-disabled');
          downloadButton.setAttribute('aria-disabled', 'true');
        }
        stopCountdown();
        return;
      }

      countdownLabel.textContent = `Expire dans ${formatSpan(left)}`;
    }

    function startCountdown(payload) {
      stopCountdown();
      const remaining = Number.isFinite(payload.secondsRemaining)
        ? payload.secondsRemaining
        : Math.max(0, Math.round((new Date(payload.expiresAt).getTime() - Date.now()) / 1000));
      deadline = Date.now() + remaining * 1000;
      totalSeconds = Math.max(remaining, Math.round((Number(payload.ttlMinutes) || 0) * 60));
      paintCountdown();
      if (remaining <= 0) return;
      countdownTimer = window.setInterval(paintCountdown, 1000);
    }

    // -------------------------------------------------------------------------
    // Rendu du résultat
    // -------------------------------------------------------------------------
    function renderResult(payload) {
      current = payload;
      if (empty) empty.classList.add('hidden');
      if (errorPanel) errorPanel.classList.add('hidden');

      if (codeBadge) codeBadge.textContent = payload.code || '—';
      if (fileName) fileName.textContent = payload.fileName || 'Fichier';
      if (size) size.textContent = payload.sizeHuman || '—';
      if (expiry) expiry.textContent = formatDate(payload.expiresAt);
      if (downloads) downloads.textContent = String(payload.downloads || 0);
      if (cleanup) cleanup.textContent = payload.deleteAfterDownload ? 'Après téléchargement' : 'À expiration';

      if (fileIcon) {
        fileIcon.textContent = extOf(payload.fileName);
        fileIcon.dataset.kind = kindOf(payload.mimeType, payload.fileName);
      }

      const isVideo = String(payload.mimeType || '').toLowerCase().startsWith('video/');
      if (video && isVideo && payload.previewUrl) {
        video.src = payload.previewUrl;
        video.classList.remove('hidden');
      } else if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.classList.add('hidden');
      }

      if (downloadButton) {
        downloadButton.href = payload.downloadUrl || '#';
        downloadButton.classList.remove('is-disabled');
        downloadButton.removeAttribute('aria-disabled');
        const label = downloadButton.querySelector('span');
        if (label) label.textContent = isVideo ? 'Télécharger la vidéo' : 'Télécharger';
      }

      if (copyButton) copyButton.dataset.url = payload.shareUrl || '';
      if (shareButton) {
        shareButton.classList.toggle('hidden', typeof navigator.share !== 'function');
      }

      if (note) {
        const parts = [];
        parts.push(
          payload.deleteAfterDownload
            ? 'Supprimé <strong>après le premier téléchargement</strong>.'
            : 'Supprimé <strong>automatiquement à expiration</strong>.'
        );
        if (payload.downloads > 0) {
          parts.push(`Déjà téléchargé <strong>${payload.downloads}</strong> fois.`);
        }
        note.innerHTML = parts.join(' ');
      }

      startCountdown(payload);

      if (result) {
        result.classList.remove('hidden');
        result.classList.remove('is-in');
        void result.offsetWidth;
        result.classList.add('is-in');
      }

      if (isSmallScreen() && result && typeof result.scrollIntoView === 'function' && !prefersReducedMotion()) {
        window.setTimeout(() => result.scrollIntoView({ behavior: 'smooth', block: 'start' }), 140);
      }
    }

    // -------------------------------------------------------------------------
    // Historique local
    // -------------------------------------------------------------------------
    function renderRecent() {
      if (!recentWrap || !recentList) return;
      const items = readRecent();
      recentWrap.classList.toggle('hidden', items.length === 0);
      recentList.textContent = '';
      items.forEach((item) => {
        const li = document.createElement('li');
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'rx-chip';
        chip.title = `Rechercher ${item.code}`;

        const code = document.createElement('code');
        code.textContent = item.code;
        chip.appendChild(code);

        if (item.name) {
          const name = document.createElement('span');
          name.textContent = item.name;
          chip.appendChild(name);
        }

        const time = document.createElement('time');
        time.textContent = formatAgo(item.at);
        chip.appendChild(time);

        chip.addEventListener('click', () => {
          setCode(item.code, { cascade: true });
          requestSubmit();
        });

        li.appendChild(chip);
        recentList.appendChild(li);
      });
    }

    function rememberRecent(payload) {
      const code = normalize(payload.code);
      if (!code) return;
      const items = readRecent().filter((item) => item.code !== code);
      items.unshift({ code, name: payload.fileName || '', at: Date.now() });
      writeRecent(items);
      renderRecent();
    }

    // -------------------------------------------------------------------------
    // URL
    // -------------------------------------------------------------------------
    function syncUrl(code) {
      try {
        const url = new URL(window.location.href);
        if (code) url.searchParams.set('code', code);
        else url.searchParams.delete('code');
        const next = `${url.pathname}${url.search}${url.hash}`;
        if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
          window.history.replaceState(window.history.state, '', next);
        }
      } catch (_error) {
        /* history indisponible : on continue */
      }
    }

    // -------------------------------------------------------------------------
    // Recherche
    // -------------------------------------------------------------------------
    function requestSubmit() {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }

    async function lookup(rawCode, options = {}) {
      const code = normalize(rawCode);
      if (!code) {
        setStatus('Entre un code pour lancer la recherche.', 'error');
        codeStatus('error');
        focusCode();
        return;
      }

      if (controller) controller.abort();
      controller = new AbortController();
      const { signal } = controller;

      busy(true);
      setCode(code, { cascade: options.cascade === true });
      if (options.silent) {
        setStatus('Actualisation…');
      } else {
        setStatus('Recherche du fichier…');
        codeStatus('loading');
      }

      try {
        const response = await fetch(`/api/codes/${encodeURIComponent(code)}`, {
          cache: 'no-store',
          signal,
          credentials: 'same-origin'
        });
        const payload = await response.json().catch(() => ({}));

        if (response.status === 404) {
          throw Object.assign(new Error('Code introuvable. Vérifie les caractères puis réessaie.'), {
            title: 'Code introuvable.',
            status: 404
          });
        }
        if (response.status === 410) {
          throw Object.assign(new Error("Ce transfert a expiré ou a déjà été supprimé. Demande un nouveau lien à l'expéditeur."), {
            title: 'Transfert expiré.',
            status: 410
          });
        }
        if (response.status === 429) {
          throw Object.assign(new Error('Trop de recherches en peu de temps. Attends quelques secondes.'), {
            title: 'Doucement…',
            status: 429
          });
        }
        if (!response.ok) {
          throw Object.assign(new Error(payload.error || `Erreur serveur HTTP ${response.status}.`), {
            title: 'Recherche impossible.',
            status: response.status
          });
        }

        renderResult(payload);
        setStatus(options.silent ? 'Informations actualisées.' : 'Fichier trouvé — tu peux le télécharger.', 'success');
        codeStatus('success', { persist: true });
        rememberRecent(payload);
        syncUrl(code);
        vibrate([10, 26, 10]);
        busy(false);
        return true;
      } catch (error) {
        if (error && error.name === 'AbortError') return false;

        const title = error.title || 'Recherche impossible.';
        const message = error.message || 'Réessaie dans un instant.';
        stopCountdown();
        if (video && !video.classList.contains('hidden')) {
          video.pause();
          video.removeAttribute('src');
          video.classList.add('hidden');
        }
        current = null;
        showError(title, message);
        setStatus(message, 'error');
        codeStatus('error');
        vibrate([28, 44, 28]);
        if (isPointerFine()) focusCode();
        return false;
      } finally {
        if (!signal.aborted) busy(false);
      }
    }

    // -------------------------------------------------------------------------
    // Collage
    // -------------------------------------------------------------------------
    function applyText(text, { submit = true } = {}) {
      const { code, shareUrl } = extractFromText(text);
      if (shareUrl) {
        window.location.href = shareUrl;
        return true;
      }
      if (!code) return false;
      setCode(code, { cascade: true });
      if (submit) requestSubmit();
      return true;
    }

    async function pasteFromClipboard() {
      if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
        const manual = window.prompt('Colle le code ou le lien DropQR :', '');
        if (manual && !applyText(manual)) toast('Aucun code DropQR reconnu.', true);
        return;
      }
      try {
        const text = await navigator.clipboard.readText();
        if (!applyText(text)) {
          toast('Aucun code DropQR dans le presse-papiers.', true);
          focusCode();
        }
      } catch (_error) {
        toast('Le navigateur bloque le presse-papiers — colle avec Ctrl+V.', true);
        focusCode();
      }
    }

    // -------------------------------------------------------------------------
    // Scanner de QR
    // -------------------------------------------------------------------------
    let scanStream = null;
    let scanFrameId = 0;
    let scanCanvas = null;
    let scanContext = null;
    let scanLastTry = 0;
    let scanDecoderPromise = null;
    let scanActive = false;

    function decoder() {
      if (window.jsQR) return Promise.resolve(window.jsQR);
      if (scanDecoderPromise) return scanDecoderPromise;
      scanDecoderPromise = new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-jsqr]');
        if (existing) {
          existing.addEventListener('load', () => resolve(window.jsQR));
          existing.addEventListener('error', () => reject(new Error('decodeur')));
          return;
        }
        const script = document.createElement('script');
        script.src = '/assets/vendor/jsqr.js';
        script.async = true;
        script.dataset.jsqr = '1';
        script.addEventListener('load', () => (window.jsQR ? resolve(window.jsQR) : reject(new Error('decodeur'))));
        script.addEventListener('error', () => reject(new Error('decodeur')));
        document.head.appendChild(script);
      }).catch((error) => {
        scanDecoderPromise = null;
        throw error;
      });
      return scanDecoderPromise;
    }

    function setScanHint(message, isError = false) {
      if (!scanHint) return;
      scanHint.textContent = message;
      if (scanView) {
        scanView.classList.toggle('is-off', isError);
        scanView.classList.toggle('is-paused', isError);
      }
    }

    function stopScan() {
      scanActive = false;
      if (scanFrameId) {
        window.cancelAnimationFrame(scanFrameId);
        scanFrameId = 0;
      }
      if (scanStream) {
        scanStream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch (_error) {
            /* ignore */
          }
        });
        scanStream = null;
      }
      if (scanVideo) {
        scanVideo.pause();
        scanVideo.removeAttribute('src');
        scanVideo.srcObject = null;
      }
    }

    function closeScanner() {
      stopScan();
      if (!scanOverlay) return;
      scanOverlay.classList.add('hidden');
      document.documentElement.classList.remove('rx-scan-open');
      focusCode();
    }

    function handleScanPayload(text) {
      const { code, shareUrl } = extractFromText(text);
      if (shareUrl) {
        window.location.href = shareUrl;
        return;
      }
      if (!code) {
        setScanHint("Ce QR n'est pas un DropQR. Réessaie avec le bon code.", true);
        window.setTimeout(() => {
          if (scanOverlay && !scanOverlay.classList.contains('hidden')) {
            setScanHint('Place le QR dans le cadre.');
          }
        }, 2200);
        return;
      }
      closeScanner();
      toast(`QR reconnu : ${code}`);
      vibrate(18);
      setCode(code, { cascade: true });
      requestSubmit();
    }

    function scanTick() {
      if (!scanActive) return;
      scanFrameId = window.requestAnimationFrame(scanTick);
      const now = performance.now();
      if (now - scanLastTry < SCAN_INTERVAL_MS) return;
      scanLastTry = now;

      if (!scanVideo || scanVideo.readyState < 2 || !scanVideo.videoWidth) return;
      if (!scanContext) {
        scanCanvas = document.createElement('canvas');
        scanContext = scanCanvas.getContext('2d', { willReadFrequently: true });
        if (!scanContext) {
          setScanHint('Décodage indisponible dans ce navigateur — choisis une image.', true);
          stopScan();
          return;
        }
      }

      const width = Math.min(640, scanVideo.videoWidth);
      const height = Math.round((width / scanVideo.videoWidth) * scanVideo.videoHeight);
      scanCanvas.width = width;
      scanCanvas.height = height;
      scanContext.drawImage(scanVideo, 0, 0, width, height);

      let imageData;
      try {
        imageData = scanContext.getImageData(0, 0, width, height);
      } catch (_error) {
        return;
      }

      const found = window.jsQR(imageData.data, width, height, { inversionAttempts: 'attemptBoth' });
      if (found && found.data) {
        scanActive = false;
        if (scanFrameId) window.cancelAnimationFrame(scanFrameId);
        scanFrameId = 0;
        handleScanPayload(found.data);
      }
    }

    async function startCamera() {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        setScanHint('Pas de caméra ici — choisis une image ou saisis le code.', true);
        return;
      }
      try {
        setScanHint('Autorise la caméra pour scanner le QR…');
        scanStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false
        });
        if (!scanVideo) return;
        scanVideo.srcObject = scanStream;
        await scanVideo.play().catch(() => {});
        if (scanView) {
          scanView.classList.remove('is-off');
          scanView.classList.remove('is-paused');
        }
        setScanHint('Place le QR dans le cadre.');
        scanActive = true;
        scanLastTry = 0;
        scanTick();
      } catch (error) {
        const denied = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
        setScanHint(
          denied
            ? 'Accès caméra refusé — choisis une image ou saisis le code.'
            : 'Caméra indisponible — choisis une image ou saisis le code.',
          true
        );
      }
    }

    async function openScanner() {
      if (!scanOverlay) return;
      scanOverlay.classList.remove('hidden');
      document.documentElement.classList.add('rx-scan-open');
      setScanHint('Chargement du décodeur…');
      if (scanClose) scanClose.focus();

      try {
        await decoder();
      } catch (_error) {
        setScanHint('Décodeur QR indisponible — saisis le code à la main.', true);
        return;
      }
      startCamera();
    }

    function scanImage(file) {
      if (!file) return;
      setScanHint('Lecture de l’image…');
      decoder()
        .then((jsQR) => {
          const url = URL.createObjectURL(file);
          const image = new Image();
          image.onload = () => {
            try {
              const canvas = document.createElement('canvas');
              const width = Math.min(1024, image.naturalWidth || image.width);
              const height = Math.round((width / (image.naturalWidth || width)) * (image.naturalHeight || width));
              canvas.width = width;
              canvas.height = height;
              const ctx = canvas.getContext('2d', { willReadFrequently: true });
              if (!ctx) throw new Error('canvas');
              ctx.drawImage(image, 0, 0, width, height);
              const data = ctx.getImageData(0, 0, width, height);
              const found = jsQR(data.data, width, height, { inversionAttempts: 'attemptBoth' });
              if (found && found.data) handleScanPayload(found.data);
              else setScanHint('Aucun QR DropQR lisible sur cette image. Réessaie avec une photo plus nette.', true);
            } catch (_error) {
              setScanHint('Impossible de lire cette image.', true);
            } finally {
              URL.revokeObjectURL(url);
            }
          };
          image.onerror = () => {
            URL.revokeObjectURL(url);
            setScanHint('Impossible de lire cette image.', true);
          };
          image.src = url;
        })
        .catch(() => setScanHint('Décodeur QR indisponible — saisis le code à la main.', true));
    }

    if (scanButton) scanButton.addEventListener('click', openScanner);
    if (scanClose) scanClose.addEventListener('click', closeScanner);
    if (scanManual) {
      scanManual.addEventListener('click', () => {
        closeScanner();
        focusCode();
      });
    }
    if (scanFileInput) {
      scanFileInput.addEventListener('change', () => {
        const file = scanFileInput.files && scanFileInput.files[0];
        scanImage(file);
        scanFileInput.value = '';
      });
    }
    if (scanOverlay) {
      scanOverlay.addEventListener('click', (event) => {
        if (event.target === scanOverlay) closeScanner();
      });
    }
    document.addEventListener(
      'visibilitychange',
      () => {
        if (!scanOverlay || scanOverlay.classList.contains('hidden')) return;
        if (document.hidden) {
          stopScan();
          setScanHint('Caméra en pause — reviens sur l’onglet pour reprendre.');
        } else {
          startCamera();
        }
      },
      { signal: docSignal }
    );

    // -------------------------------------------------------------------------
    // Actions du résultat
    // -------------------------------------------------------------------------
    if (copyButton) {
      copyButton.addEventListener('click', async () => {
        const url = copyButton.dataset.url || (current && current.shareUrl);
        if (!url) return;
        try {
          await navigator.clipboard.writeText(url);
          copyButton.textContent = 'Copié';
          toast('Lien copié.');
          window.setTimeout(() => {
            copyButton.textContent = 'Copier le lien';
          }, 1500);
        } catch (_error) {
          window.prompt('Copie le lien :', url);
        }
      });
    }

    if (shareButton) {
      shareButton.addEventListener('click', async () => {
        const url = (current && current.shareUrl) || copyButton?.dataset.url;
        if (!url) return;
        try {
          await navigator.share({
            title: current ? current.fileName : 'DropQR',
            text: current ? `${current.fileName} — via DropQR` : 'Fichier partagé avec DropQR',
            url
          });
        } catch (error) {
          if (error && error.name === 'AbortError') return;
          try {
            await navigator.clipboard.writeText(url);
            toast('Lien copié à la place.');
          } catch (_error) {
            window.prompt('Copie le lien :', url);
          }
        }
      });
    }

    // Transfert à usage unique : après un téléchargement, on vérifie
    // discrètement que le fichier a bien été supprimé côté serveur.
    if (downloadButton) {
      downloadButton.addEventListener('click', () => {
        if (!current || !current.deleteAfterDownload) return;
        const watched = current.code;
        window.setTimeout(async () => {
          if (!current || current.code !== watched) return;
          let response = null;
          try {
            response = await fetch(`/api/codes/${encodeURIComponent(watched)}`, { cache: 'no-store' });
          } catch (_error) {
            return;
          }
          if (response.status !== 404 && response.status !== 410) return;
          if (downloadButton) {
            downloadButton.classList.add('is-disabled');
            downloadButton.setAttribute('aria-disabled', 'true');
          }
          if (countdownLabel) countdownLabel.textContent = 'Fichier supprimé après téléchargement';
          if (countdown) countdown.classList.add('is-over');
          if (note) note.innerHTML = 'Fichier <strong>supprimé après le téléchargement</strong>. Merci !';
          setStatus('Transfert terminé — le fichier a été supprimé du serveur.', 'success');
        }, 6000);
      });
    }

    if (refreshButton) {
      refreshButton.addEventListener('click', () => {
        if (current && current.code) lookup(current.code, { silent: true });
      });
    }

    if (retry) {
      retry.addEventListener('click', () => {
        showEmpty();
        if (input.codeSlots) input.codeSlots.clear();
        else input.value = '';
        codeStatus('idle');
        setStatus('');
        syncUrl('');
        focusCode();
      });
    }

    if (pasteButton) pasteButton.addEventListener('click', pasteFromClipboard);

    if (clearRecent) {
      clearRecent.addEventListener('click', () => {
        writeRecent([]);
        renderRecent();
        toast('Codes récents effacés.');
      });
    }

    // -------------------------------------------------------------------------
    // Formulaire et clavier
    // -------------------------------------------------------------------------
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      lookup(input.value);
    });

    input.addEventListener('input', () => {
      if (current || (result && !result.classList.contains('hidden'))) {
        // On repart d'une saisie neuve : le panneau redevient une invite.
        showEmpty();
        current = null;
        stopCountdown();
      }
      if (errorPanel && !errorPanel.classList.contains('hidden')) showEmpty();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (scanOverlay && !scanOverlay.classList.contains('hidden')) {
          closeScanner();
          return;
        }
        if (document.activeElement === input || input.value) {
          if (input.codeSlots) input.codeSlots.clear();
          else input.value = '';
          setStatus('');
          codeStatus('idle');
          showEmpty();
          syncUrl('');
          current = null;
          stopCountdown();
        }
        return;
      }

      if (event.key === '/' && document.activeElement !== input && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
        event.preventDefault();
        focusCode();
      }
    }, { signal: docSignal });

    // Collage n'importe où dans la page : on le redirige vers le champ.
    document.addEventListener('paste', (event) => {
      if (event.target === input) return;
      if (scanOverlay && !scanOverlay.classList.contains('hidden')) return;
      const text = event.clipboardData && event.clipboardData.getData('text');
      if (!text || !/^[\x20-\x7E\s]+$/.test(text)) return;
      if (applyText(text)) event.preventDefault();
    }, { signal: docSignal });

    // -------------------------------------------------------------------------
    // Démarrage
    // -------------------------------------------------------------------------
    cleanupPrevious = () => {
      stopCountdown();
      stopScan();
    };

    renderRecent();
    showEmpty();

    const initial = normalize(new URLSearchParams(window.location.search).get('code'));
    if (initial) {
      lookup(initial, { cascade: true });
    } else if (isPointerFine() && !isSmallScreen()) {
      // Sur ordinateur seulement : le curseur est prêt, pas de clavier virtuel
      // qui surgit sur téléphone.
      window.setTimeout(focusCode, 260);
    }
  };

  initReceivePage();
  window.addEventListener('pjax:load', initReceivePage);
  window.addEventListener('pagehide', () => {
    document.documentElement.classList.remove('rx-scan-open');
  });
})();
