(async () => {
  // If panel already exists, handle it like AutoScribe does: snap back or pulse.
  if (document.getElementById('screencraft-panel-root')) {
    const root = document.getElementById('screencraft-panel-root');
    const panel = root.shadowRoot?.querySelector('.autoscribe-floating');
    if (root.getAttribute('data-has-been-dragged') === 'true' && typeof root.snapToTopRight === 'function') {
      root.snapToTopRight();
      if (typeof root.resetDragState === 'function') root.resetDragState();
    } else if (panel) {
      panel.style.transform = 'scale(1.05)';
      setTimeout(() => { panel.style.transform = 'scale(1)'; }, 150);
    }
    return;
  }

  const QUALITY_MAP = {
    auto: null,
    '480p': { width: 854, height: 480 },
    '720p': { width: 1280, height: 720 },
    '1080p': { width: 1920, height: 1080 }
  };

  // ── Recording state ────────────────────────────────────────────────────
  let selectedSource = 'tab';
  let isRecording = false;
  let mediaRecorder = null;
  let recordedChunks = [];
  let allTracks = [];
  let rafId = null;
  let audioCtx = null;
  let timerInterval = null;
  let recordStartTime = null;
  let pausedAccum = 0;
  let pauseStartedAt = null;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const stopAllTracks = () => {
    allTracks.forEach(t => { try { t.stop(); } catch (_) { } });
    allTracks = [];
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (audioCtx) { try { audioCtx.close(); } catch (_) { } audioCtx = null; }
  };

  const makeVideoEl = stream => {
    const v = document.createElement('video');
    v.srcObject = stream;
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    return v;
  };

  const buildComposite = async (screenStream, cameraStream, quality) => {
    const screenVideo = makeVideoEl(screenStream);
    await screenVideo.play().catch(() => { });
    if (!screenVideo.videoWidth) {
      await new Promise(res => { screenVideo.onloadedmetadata = res; });
    }

    const q = QUALITY_MAP[quality];
    const width = q ? q.width : screenVideo.videoWidth;
    const height = q ? q.height : screenVideo.videoHeight;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    let cameraVideo = null;
    if (cameraStream) {
      cameraVideo = makeVideoEl(cameraStream);
      await cameraVideo.play().catch(() => { });
    }

    const bubbleR = Math.round(Math.min(width, height) * 0.14);
    const bubbleMargin = Math.round(bubbleR * 0.4);

    const draw = () => {
      ctx.drawImage(screenVideo, 0, 0, width, height);
      if (cameraVideo && cameraVideo.videoWidth) {
        const cx = width - bubbleMargin - bubbleR;
        const cy = height - bubbleMargin - bubbleR;
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, bubbleR, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        const vw = cameraVideo.videoWidth, vh = cameraVideo.videoHeight;
        const side = Math.min(vw, vh);
        const sx = (vw - side) / 2, sy = (vh - side) / 2;
        ctx.drawImage(cameraVideo, sx, sy, side, side, cx - bubbleR, cy - bubbleR, bubbleR * 2, bubbleR * 2);
        ctx.restore();
        ctx.beginPath();
        ctx.arc(cx, cy, bubbleR, 0, Math.PI * 2);
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.stroke();
      }
      rafId = requestAnimationFrame(draw);
    };
    draw();

    return canvas.captureStream(30);
  };

  const mixAudio = streams => {
    const tracks = streams.flatMap(s => (s ? s.getAudioTracks() : []));
    if (tracks.length === 0) return null;
    if (tracks.length === 1) return tracks[0];
    audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    streams.forEach(s => {
      if (!s || s.getAudioTracks().length === 0) return;
      audioCtx.createMediaStreamSource(new MediaStream(s.getAudioTracks())).connect(dest);
    });
    return dest.stream.getAudioTracks()[0] || null;
  };

  const pickMimeType = () => {
    const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return candidates.find(c => MediaRecorder.isTypeSupported(c)) || 'video/webm';
  };

  const downloadBlob = blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `ScreenCraft-${stamp}.webm`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };

  const createCountdownOverlay = () => {
    const host = document.createElement('div');
    host.id = 'screencraft-countdown-overlay';
    host.style.position = 'fixed';
    host.style.inset = '0';
    host.style.zIndex = '2147483647';
    host.style.pointerEvents = 'none';
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .cd-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.55);
        backdrop-filter: blur(22px);
        -webkit-backdrop-filter: blur(22px);
        opacity: 0;
        transition: opacity 0.4s ease;
      }
      .cd-backdrop.cd-show { opacity: 1; }
      .cd-edge {
        position: fixed;
        background-repeat: repeat;
        background-image: linear-gradient(90deg,
          #0b3d91 0%, #1d5fd6 25%, #5aa9ff 50%, #1d5fd6 75%, #0b3d91 100%);
      }
      .cd-edge-top {
        top: 0; left: 0; right: 0; height: 24px;
        background-size: 220% 100%;
        -webkit-mask-image: linear-gradient(180deg, #fff, transparent);
        mask-image: linear-gradient(180deg, #fff, transparent);
        animation: cd-wave-x 5.5s linear infinite;
      }
      .cd-edge-bottom {
        bottom: 0; left: 0; right: 0; height: 24px;
        background-size: 220% 100%;
        -webkit-mask-image: linear-gradient(0deg, #fff, transparent);
        mask-image: linear-gradient(0deg, #fff, transparent);
        animation: cd-wave-x 7s linear infinite reverse;
      }
      .cd-edge-left {
        top: 0; bottom: 0; left: 0; width: 24px;
        background-image: linear-gradient(180deg,
          #0b3d91 0%, #1d5fd6 25%, #5aa9ff 50%, #1d5fd6 75%, #0b3d91 100%);
        background-size: 100% 220%;
        -webkit-mask-image: linear-gradient(90deg, #fff, transparent);
        mask-image: linear-gradient(90deg, #fff, transparent);
        animation: cd-wave-y 6.2s linear infinite;
      }
      .cd-edge-right {
        top: 0; bottom: 0; right: 0; width: 24px;
        background-image: linear-gradient(180deg,
          #0b3d91 0%, #1d5fd6 25%, #5aa9ff 50%, #1d5fd6 75%, #0b3d91 100%);
        background-size: 100% 220%;
        -webkit-mask-image: linear-gradient(270deg, #fff, transparent);
        mask-image: linear-gradient(270deg, #fff, transparent);
        animation: cd-wave-y 4.8s linear infinite reverse;
      }
      @keyframes cd-wave-x { from { background-position: 0% 0; } to { background-position: -220% 0; } }
      @keyframes cd-wave-y { from { background-position: 0 0%; } to { background-position: 0 -220%; } }
      .cd-edges { opacity: 0; transition: opacity 0.4s ease; }
      .cd-edges.cd-show { opacity: 0.5; }
      .cd-card {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%) scale(0.82);
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        transition: opacity 0.3s ease, transform 0.35s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .cd-card.cd-show { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      .cd-number {
        position: relative;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
        font-size: 46px;
        font-weight: 700;
        color: #ffffff;
        text-shadow: 0 2px 16px rgba(90, 169, 255, 0.5);
        opacity: 0;
        transform: scale(1);
        transition: opacity 0.25s ease, transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .cd-number.cd-show { opacity: 1; transform: scale(1); }
    `;
    shadow.appendChild(style);

    const backdrop = document.createElement('div');
    backdrop.className = 'cd-backdrop';
    shadow.appendChild(backdrop);

    const edges = document.createElement('div');
    edges.className = 'cd-edges';
    edges.innerHTML = `
      <div class="cd-edge cd-edge-top"></div>
      <div class="cd-edge cd-edge-bottom"></div>
      <div class="cd-edge cd-edge-left"></div>
      <div class="cd-edge cd-edge-right"></div>
    `;
    shadow.appendChild(edges);

    const card = document.createElement('div');
    card.className = 'cd-card';
    card.innerHTML = `<span class="cd-number"></span>`;
    shadow.appendChild(card);

    const number = card.querySelector('.cd-number');

    requestAnimationFrame(() => {
      backdrop.classList.add('cd-show');
      edges.classList.add('cd-show');
      card.classList.add('cd-show');
    });

    return {
      setNumber(n) {
        number.classList.remove('cd-show');
        number.style.transform = 'scale(1.35)';
        requestAnimationFrame(() => {
          number.textContent = n;
          number.classList.add('cd-show');
        });
      },
      destroy() {
        backdrop.classList.remove('cd-show');
        edges.classList.remove('cd-show');
        card.classList.remove('cd-show');
        setTimeout(() => host.remove(), 350);
      }
    };
  };

  const createControlsWidget = ({ onTogglePause, onStop }) => {
    const host = document.createElement('div');
    host.id = 'screencraft-controls-widget';
    host.style.position = 'fixed';
    host.style.top = '20px';
    host.style.right = '20px';
    host.style.zIndex = '2147483647';
    document.body.appendChild(host);

    ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu'].forEach(evtType => {
      host.addEventListener(evtType, e => e.stopPropagation());
    });

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif; }
      .ctl-bar {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px;
        padding-left: 10px;
        background: #181818;
        border-radius: 12px;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
        opacity: 0;
        transform: translateY(-16px);
        transition: opacity 0.3s ease, transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .ctl-bar.ctl-show { opacity: 1; transform: translateY(0); }
      .ctl-drag { display: flex; align-items: center; cursor: grab; touch-action: none; }
      .ctl-drag-icon { width: 15px; height: 15px; fill: #555555; display: block; }
      .ctl-time-group { display: flex; align-items: center; gap: 6px; }
      .ctl-dot { width: 9px; height: 9px; border-radius: 50%; background: #ef4444; flex-shrink: 0; animation: ctl-blink 1.4s ease-in-out infinite; }
      .ctl-dot.ctl-paused { animation: none; background: #a1a1aa; }
      @keyframes ctl-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
      .ctl-time { font-size: 13px; font-weight: 500; color: #cccccc; min-width: 38px; flex-shrink: 0; margin-right: -5px; }
      .ctl-btn-group { display: flex; align-items: center; gap: 3px; }
      .ctl-btn { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: none; background: #2c2c2e; cursor: pointer; transition: background 0.15s; }
      .ctl-btn:hover { background: #39393b; }
      #ctl-pause { border-top-left-radius: 9px; border-bottom-left-radius: 9px; border-top-right-radius: 4px; border-bottom-right-radius: 4px; }
      #ctl-stop { border-top-left-radius: 4px; border-bottom-left-radius: 4px; border-top-right-radius: 9px; border-bottom-right-radius: 9px; }
      .ctl-icon { width: 17px; height: 17px; fill: #cccccc; display: block; }
      .ctl-btn-stop .ctl-icon { fill: #ef4444; }
    `;
    shadow.appendChild(style);

    const bar = document.createElement('div');
    bar.className = 'ctl-bar';
    bar.innerHTML = `
      <div class="ctl-drag" id="ctl-drag">
        <svg viewBox="0 0 16 16" class="ctl-drag-icon">
          <circle cx="5" cy="3" r="1.2"/><circle cx="5" cy="8" r="1.2"/><circle cx="5" cy="13" r="1.2"/>
          <circle cx="11" cy="3" r="1.2"/><circle cx="11" cy="8" r="1.2"/><circle cx="11" cy="13" r="1.2"/>
        </svg>
      </div>
      <div class="ctl-time-group">
        <div class="ctl-dot" id="ctl-dot"></div>
        <span class="ctl-time" id="ctl-time">00:00</span>
      </div>
      <div class="ctl-btn-group">
        <button class="ctl-btn" id="ctl-pause" title="Pause">
          <svg viewBox="0 0 24 24" class="ctl-icon ctl-icon-pause"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
          <svg viewBox="0 0 24 24" class="ctl-icon ctl-icon-play" style="display:none"><path d="M7 5v14l12-7z"/></svg>
        </button>
        <button class="ctl-btn ctl-btn-stop" id="ctl-stop" title="Stop">
          <svg viewBox="0 0 24 24" class="ctl-icon"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
        </button>
      </div>
    `;
    shadow.appendChild(bar);

    const dot = shadow.getElementById('ctl-dot');
    const timeEl = shadow.getElementById('ctl-time');
    const dragHandle = shadow.getElementById('ctl-drag');
    const btnPause = shadow.getElementById('ctl-pause');
    const btnStop = shadow.getElementById('ctl-stop');
    const iconPause = btnPause.querySelector('.ctl-icon-pause');
    const iconPlay = btnPause.querySelector('.ctl-icon-play');

    const formatTime = ms => {
      const total = Math.max(0, Math.floor(ms / 1000));
      const m = String(Math.floor(total / 60)).padStart(2, '0');
      const s = String(total % 60).padStart(2, '0');
      return `${m}:${s}`;
    };

    btnPause.addEventListener('click', e => { e.stopPropagation(); onTogglePause(); });
    btnStop.addEventListener('click', e => { e.stopPropagation(); onStop(); });

    // ── Drag (via drag handle only) ──────────────────────────────────────────
    let isDragging = false;
    let offsetX = 0, offsetY = 0;
    dragHandle.addEventListener('pointerdown', e => {
      isDragging = true;
      offsetX = e.clientX - host.offsetLeft;
      offsetY = e.clientY - host.offsetTop;
      try { dragHandle.setPointerCapture(e.pointerId); } catch (_) { }
      e.stopPropagation();
      e.preventDefault();
    });
    host.addEventListener('pointermove', e => {
      if (!isDragging) return;
      e.stopPropagation();
      const rect = host.getBoundingClientRect();
      const maxLeft = window.innerWidth - rect.width;
      const maxTop = window.innerHeight - rect.height;
      const newLeft = Math.max(0, Math.min(e.clientX - offsetX, maxLeft));
      const newTop = Math.max(0, Math.min(e.clientY - offsetY, maxTop));
      host.style.left = `${newLeft}px`;
      host.style.top = `${newTop}px`;
      host.style.right = 'auto';
    });
    host.addEventListener('pointerup', e => {
      if (!isDragging) return;
      isDragging = false;
      try { dragHandle.releasePointerCapture(e.pointerId); } catch (_) { }
      e.stopPropagation();
    });
    host.addEventListener('pointercancel', () => { isDragging = false; });

    requestAnimationFrame(() => bar.classList.add('ctl-show'));

    return {
      updateTick(elapsed, paused) {
        timeEl.textContent = formatTime(elapsed);
        dot.classList.toggle('ctl-paused', !!paused);
        iconPause.style.display = paused ? 'none' : 'block';
        iconPlay.style.display = paused ? 'block' : 'none';
        btnPause.title = paused ? 'Resume' : 'Pause';
      },
      destroy() {
        bar.classList.remove('ctl-show');
        setTimeout(() => host.remove(), 300);
      }
    };
  };

  await mountPopup();

  // ═══════════════════════════════════════════════════════════════════════════
  //  UI Mount: Scoped Floating Obsidian Draggable Card (AutoScribe scaffold)
  // ═══════════════════════════════════════════════════════════════════════════
  async function mountPopup() {
    const root = document.createElement('div');
    root.id = 'screencraft-panel-root';
    root.style.position = 'fixed';
    root.style.top = '20px';
    root.style.right = '20px';
    root.style.zIndex = '2147483647';
    document.body.appendChild(root);

    ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress', 'contextmenu', 'dblclick'].forEach(evtType => {
      root.addEventListener(evtType, e => { e.stopPropagation(); });
    });

    const shadow = root.attachShadow({ mode: 'open' });

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('popup/popup.css');
    shadow.appendChild(link);

    const container = document.createElement('div');
    container.className = 'autoscribe-floating';

    ['mousedown', 'pointerdown'].forEach(evtType => {
      container.addEventListener(evtType, e => e.preventDefault());
    });

    const htmlUrl = chrome.runtime.getURL('popup/popup.html');
    const htmlRes = await fetch(htmlUrl);
    const htmlContent = await htmlRes.text();
    container.innerHTML = htmlContent;

    shadow.appendChild(container);

    shadow.getElementById('crx-logo-img').src = chrome.runtime.getURL('icons/icon.png');

    // ── State Variables & Drag Logic (no auto-minimize / no collapse) ───────
    const handle = shadow.getElementById('crx-drag-handle');
    let isDragging = false;
    let offsetX = 0, offsetY = 0;
    let hasBeenDragged = false;

    const resizeObserver = new ResizeObserver(entries => {
      if (isDragging) return;
      for (const entry of entries) {
        const rect = root.getBoundingClientRect();
        const width = entry.contentRect.width || rect.width;
        const height = entry.contentRect.height || rect.height;
        const margin = 20;
        let left = rect.left, top = rect.top;
        const maxLeft = window.innerWidth - width - margin;
        const maxTop = window.innerHeight - height - margin;
        let targetLeft = Math.max(margin, Math.min(left, maxLeft));
        let targetTop = Math.max(margin, Math.min(top, maxTop));
        if (targetLeft !== left || targetTop !== top) {
          root.style.left = `${targetLeft}px`;
          root.style.top = `${targetTop}px`;
          root.style.right = 'auto';
        }
      }
    });
    resizeObserver.observe(container);

    const getTargetWidth = () => container.classList.contains('crx-settings-open') ? 380 : 320;

    const snapToTopRight = () => {
      const width = getTargetWidth();
      const margin = 20;
      root.style.transition = 'left 0.5s cubic-bezier(0.16, 1, 0.3, 1), top 0.5s cubic-bezier(0.16, 1, 0.3, 1)';
      root.style.left = `${window.innerWidth - width - margin}px`;
      root.style.top = `${margin}px`;
      root.style.right = 'auto';
      setTimeout(() => { root.style.transition = ''; }, 500);
    };

    root.snapToTopRight = snapToTopRight;
    root.resetDragState = () => { hasBeenDragged = false; root.removeAttribute('data-has-been-dragged'); };

    setTimeout(() => {
      container.classList.add('crx-visible');
      const initRect = root.getBoundingClientRect();
      root.style.left = `${initRect.left}px`;
      root.style.right = 'auto';
    }, 20);

    // ── Drag & Drop (via drag handle only) ───────────────────────────────────
    container.addEventListener('pointerdown', e => {
      if (!e.target.closest('#crx-drag-handle')) return;
      root.style.transition = '';
      isDragging = true;
      offsetX = e.clientX - root.offsetLeft;
      offsetY = e.clientY - root.offsetTop;
      try { handle.setPointerCapture(e.pointerId); } catch (_) { }
      handle.style.cursor = 'grabbing';
      container.style.cursor = 'grabbing';
      e.stopPropagation();
      e.preventDefault();
    });

    let dragRafId = null;
    container.addEventListener('pointermove', e => {
      if (!isDragging) return;
      e.stopPropagation();
      hasBeenDragged = true;
      root.setAttribute('data-has-been-dragged', 'true');
      const cx = e.clientX, cy = e.clientY;
      if (dragRafId) return;
      dragRafId = requestAnimationFrame(() => {
        dragRafId = null;
        const rect = root.getBoundingClientRect();
        let newLeft = cx - offsetX, newTop = cy - offsetY;
        const maxLeft = window.innerWidth - rect.width;
        const maxTop = window.innerHeight - rect.height;
        newLeft = Math.max(0, Math.min(newLeft, maxLeft));
        newTop = Math.max(0, Math.min(newTop, maxTop));
        root.style.left = `${newLeft}px`;
        root.style.top = `${newTop}px`;
        root.style.right = 'auto';
      });
    });

    container.addEventListener('pointerup', e => {
      if (!isDragging) return;
      isDragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (_) { }
      handle.style.cursor = '';
      container.style.cursor = '';
      e.stopPropagation();
    });
    container.addEventListener('pointercancel', () => { isDragging = false; });

    const handleResize = () => {
      const rect = root.getBoundingClientRect();
      const maxLeft = window.innerWidth - rect.width;
      const maxTop = window.innerHeight - rect.height;
      root.style.left = `${Math.max(0, Math.min(root.offsetLeft, maxLeft))}px`;
      root.style.top = `${Math.max(0, Math.min(root.offsetTop, maxTop))}px`;
    };
    window.addEventListener('resize', handleResize);

    // ── Close button ─────────────────────────────────────────────────────────
    shadow.getElementById('crx-close-btn').addEventListener('click', e => {
      if (isRecording) return; // don't let the panel vanish mid-recording
      try { resizeObserver.disconnect(); } catch (_) { }
      window.removeEventListener('resize', handleResize);
      container.classList.remove('crx-visible');
      setTimeout(() => { root.remove(); }, 400);
      e.stopPropagation();
    });

    // ── Settings view toggling ───────────────────────────────────────────────
    const btnSettings = shadow.getElementById('crx-settings-btn');
    const btnBack = shadow.getElementById('crx-back-btn');

    btnSettings.addEventListener('click', e => {
      e.stopPropagation();
      container.classList.add('crx-settings-open');
      btnSettings.style.display = 'none';
      btnBack.style.display = 'block';
      shadow.querySelectorAll('.crx-main-view-item').forEach(el => { el.style.display = 'none'; });
      shadow.querySelectorAll('.crx-settings-item').forEach(el => { el.style.display = 'flex'; });
    });

    btnBack.addEventListener('click', e => {
      e.stopPropagation();
      container.classList.remove('crx-settings-open');
      btnBack.style.display = 'none';
      btnSettings.style.display = 'block';
      shadow.querySelectorAll('.crx-main-view-item').forEach(el => { el.style.display = 'flex'; });
      shadow.querySelectorAll('.crx-settings-item').forEach(el => { el.style.display = 'none'; });
    });

    // ── Persistent settings ───────────────────────────────────────────────────
    const countdownToggle = shadow.getElementById('crx-toggle-countdown');
    const controlsToggle = shadow.getElementById('crx-toggle-controls');

    let settings = { quality: 'auto', countdown: true, controls: true };
    chrome.storage.local.get(['screencraft_settings'], res => {
      settings = { ...settings, ...(res.screencraft_settings || {}), quality: 'auto' };
      countdownToggle.checked = settings.countdown;
      controlsToggle.checked = settings.controls;
    });

    const saveSettings = () => chrome.storage.local.set({ screencraft_settings: settings });

    countdownToggle.addEventListener('change', () => { settings.countdown = countdownToggle.checked; saveSettings(); });
    controlsToggle.addEventListener('change', () => { settings.controls = controlsToggle.checked; saveSettings(); });

    // ── Source selector ──────────────────────────────────────────────────────
    const sourceRows = shadow.querySelectorAll('.crx-source-item');
    sourceRows.forEach(row => {
      row.addEventListener('click', e => {
        e.stopPropagation();
        if (isRecording) return;
        sourceRows.forEach(r => r.classList.remove('crx-source-active'));
        row.classList.add('crx-source-active');
        selectedSource = row.dataset.source;
      });
    });

    // ── Status helper ────────────────────────────────────────────────────────
    const status = shadow.getElementById('crx-status-text');
    const errorIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:3px"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

    const formatTime = ms => {
      const total = Math.max(0, Math.floor(ms / 1000));
      const m = String(Math.floor(total / 60)).padStart(2, '0');
      const s = String(total % 60).padStart(2, '0');
      return `${m}:${s}`;
    };

    // ── Start / Stop recording ───────────────────────────────────────────────
    const btnStart = shadow.getElementById('crx-btn-start');
    const startLabel = shadow.getElementById('crx-start-label');

    const setRecordingUIState = recording => {
      isRecording = recording;
      btnStart.classList.toggle('crx-recording-state', recording);
      startLabel.textContent = recording ? 'Stop Recording' : 'Start Recording';
      sourceRows.forEach(r => r.style.pointerEvents = recording ? 'none' : '');
      sourceRows.forEach(r => r.style.opacity = recording ? '0.5' : '');
    };

    const hidePopup = () => { container.classList.remove('crx-visible'); };
    const showPopup = () => { container.classList.add('crx-visible'); };

    let controlsWidget = null;

    const runCountdown = async () => {
      if (!settings.countdown) return;
      const overlay = createCountdownOverlay();
      for (const n of [3, 2, 1]) {
        overlay.setNumber(n);
        await sleep(700);
      }
      overlay.destroy();
    };

    const getElapsedMs = () => {
      if (!recordStartTime) return 0;
      let elapsed = Date.now() - recordStartTime - pausedAccum;
      if (pauseStartedAt) elapsed -= (Date.now() - pauseStartedAt);
      return elapsed;
    };

    const startTimer = () => {
      recordStartTime = Date.now();
      pausedAccum = 0;
      pauseStartedAt = null;
      if (timerInterval) clearInterval(timerInterval);
      const tick = () => {
        const elapsed = getElapsedMs();
        if (controlsWidget) {
          controlsWidget.updateTick(elapsed, !!pauseStartedAt);
        } else {
          status.className = 'crx-status crx-status-running';
          status.innerHTML = `<span class="crx-spinner"></span> Recording ${formatTime(elapsed)}`;
        }
      };
      tick();
      timerInterval = setInterval(tick, 1000);
    };

    const stopTimer = () => {
      if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    };

    const pauseRecording = () => {
      if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
      mediaRecorder.pause();
      pauseStartedAt = Date.now();
      if (controlsWidget) controlsWidget.updateTick(getElapsedMs(), true);
    };

    const resumeRecording = () => {
      if (!mediaRecorder || mediaRecorder.state !== 'paused') return;
      mediaRecorder.resume();
      pausedAccum += Date.now() - pauseStartedAt;
      pauseStartedAt = null;
      if (controlsWidget) controlsWidget.updateTick(getElapsedMs(), false);
    };

    const togglePause = () => { if (pauseStartedAt) resumeRecording(); else pauseRecording(); };

    const startRecording = async () => {
      const displayOptions = { video: true, audio: true };
      if (selectedSource === 'window') displayOptions.video = { displaySurface: 'window' };
      else if (selectedSource === 'screen') displayOptions.video = { displaySurface: 'monitor' };
      else if (selectedSource === 'tab') {
        try { displayOptions.preferCurrentTab = true; } catch (_) { }
      }

      let screenStream;
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia(displayOptions);
      } catch (e) {
        console.error('[ScreenCraft]', e);
        status.className = 'crx-status crx-status-error';
        status.innerHTML = `${errorIcon}${e.message || 'Recording was cancelled.'}`;
        setTimeout(() => { status.innerHTML = ''; status.className = 'crx-status'; }, 3500);
        return;
      }

      container.classList.add('crx-filling');
      hidePopup();
      allTracks.push(...screenStream.getTracks());
      await runCountdown();

      try {
        const compositeVideoStream = await buildComposite(screenStream, null, settings.quality);
        const mixedAudioTrack = mixAudio([screenStream]);

        const finalStream = new MediaStream([
          ...compositeVideoStream.getVideoTracks(),
          ...(mixedAudioTrack ? [mixedAudioTrack] : [])
        ]);

        recordedChunks = [];
        mediaRecorder = new MediaRecorder(finalStream, { mimeType: pickMimeType() });
        mediaRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) recordedChunks.push(e.data); };
        mediaRecorder.onstop = () => {
          const blob = new Blob(recordedChunks, { type: 'video/webm' });
          downloadBlob(blob);
          stopAllTracks();
          stopTimer();
          if (controlsWidget) { controlsWidget.destroy(); controlsWidget = null; }
          setRecordingUIState(false);
          showPopup();
          status.className = 'crx-status crx-status-success';
          status.innerHTML = 'Recording saved';
          setTimeout(() => { status.innerHTML = ''; status.className = 'crx-status'; }, 3000);
        };

        screenStream.getVideoTracks()[0].addEventListener('ended', () => {
          if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
        });

        mediaRecorder.start(1000);
        setRecordingUIState(true);
        startTimer();
        if (settings.controls) {
          controlsWidget = createControlsWidget({ onTogglePause: togglePause, onStop: stopRecording });
        }
      } catch (e) {
        showPopup();
        console.error('[ScreenCraft]', e);
        status.className = 'crx-status crx-status-error';
        status.innerHTML = `${errorIcon}${e.message || 'Recording was cancelled.'}`;
        setTimeout(() => { status.innerHTML = ''; status.className = 'crx-status'; }, 3500);
        stopAllTracks();
      } finally {
        container.classList.remove('crx-filling');
      }
    };

    const stopRecording = () => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    };

    btnStart.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      if (isRecording) stopRecording(); else startRecording();
    });
  }
})();
