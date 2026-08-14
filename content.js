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

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const stopAllTracks = () => {
    allTracks.forEach(t => { try { t.stop(); } catch (_) {} });
    allTracks = [];
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (audioCtx) { try { audioCtx.close(); } catch (_) {} audioCtx = null; }
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
    await screenVideo.play().catch(() => {});
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
      await cameraVideo.play().catch(() => {});
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

    shadow.getElementById('crx-logo-img').src = chrome.runtime.getURL('icons/icon128.png');

    // ── State Variables & Snapping / Inactivity Logic ───────────────────────
    const handle = shadow.getElementById('crx-drag-handle');
    let isDragging = false;
    let offsetX = 0, offsetY = 0, startX = 0, startY = 0;
    let hasMoved = false;
    let inactivityTimeout = null;
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

    const getTargetWidth = () => {
      if (container.classList.contains('crx-collapsed')) return 40;
      if (container.classList.contains('crx-settings-open')) return 380;
      return 320;
    };
    const getTargetHeight = () => container.classList.contains('crx-collapsed') ? 40 : 320;

    const snapToNearestEdge = () => {
      const rect = root.getBoundingClientRect();
      const width = getTargetWidth(), height = getTargetHeight();
      const x = rect.left, y = rect.top;
      const distLeft = x, distRight = window.innerWidth - x - width;
      const distTop = y, distBottom = window.innerHeight - y - height;
      const minDist = Math.min(distLeft, distRight, distTop, distBottom);
      const margin = 20;
      let targetLeft = x, targetTop = y;
      if (minDist === distLeft) targetLeft = margin;
      else if (minDist === distRight) targetLeft = window.innerWidth - width - margin;
      else if (minDist === distTop) targetTop = margin;
      else targetTop = window.innerHeight - height - margin;
      const maxLeft = window.innerWidth - width - margin;
      const maxTop = window.innerHeight - height - margin;
      targetLeft = Math.max(margin, Math.min(targetLeft, maxLeft));
      targetTop = Math.max(margin, Math.min(targetTop, maxTop));
      root.style.transition = 'left 0.5s cubic-bezier(0.16, 1, 0.3, 1), top 0.5s cubic-bezier(0.16, 1, 0.3, 1)';
      root.style.left = `${targetLeft}px`;
      root.style.top = `${targetTop}px`;
      root.style.right = 'auto';
      setTimeout(() => { root.style.transition = ''; }, 500);
    };

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

    const collapsePanel = (isAutomatic = false) => {
      if (container.classList.contains('crx-collapsed')) return;
      if (isAutomatic && isRecording) {
        // Never block the recording — but keep the floating icon at a
        // predictable, normal spot (top-right) instead of wherever it
        // happened to be, so it doesn't feel like it "jumps" randomly.
      }
      container.classList.remove('crx-settings-open');
      const btnBack = shadow.getElementById('crx-back-btn');
      const btnSettings = shadow.getElementById('crx-settings-btn');
      if (btnBack) btnBack.style.display = 'none';
      if (btnSettings) btnSettings.style.display = 'block';
      shadow.querySelectorAll('.crx-main-view-item').forEach(el => { el.style.display = 'flex'; });
      shadow.querySelectorAll('.crx-settings-item').forEach(el => { el.style.display = 'none'; });

      const status = shadow.getElementById('crx-status-text');
      if (status && !isRecording) { status.innerHTML = ''; status.className = 'crx-status'; }

      container.classList.add('crx-collapsed');

      if (inactivityTimeout) { clearTimeout(inactivityTimeout); inactivityTimeout = null; }

      if (hasBeenDragged) snapToNearestEdge();
      else if (isAutomatic) snapToTopRight();
      else snapToNearestEdge();
    };

    const startInactivityTimer = () => {
      if (inactivityTimeout) clearTimeout(inactivityTimeout);
      inactivityTimeout = setTimeout(() => {
        if (document.getElementById('screencraft-panel-root')) collapsePanel(true);
      }, 60000);
    };

    const resetInactivityTimer = () => {
      if (!container.classList.contains('crx-collapsed')) startInactivityTimer();
    };

    const expandPanel = () => {
      if (!container.classList.contains('crx-collapsed')) return;
      container.classList.remove('crx-collapsed');
      startInactivityTimer();
      if (!hasBeenDragged) snapToNearestEdge();
    };

    setTimeout(() => {
      container.classList.add('crx-visible');
      startInactivityTimer();
      const initRect = root.getBoundingClientRect();
      root.style.left = `${initRect.left}px`;
      root.style.right = 'auto';
    }, 20);

    container.addEventListener('click', () => { resetInactivityTimer(); });

    shadow.getElementById('crx-logo-img').addEventListener('click', e => {
      if (!container.classList.contains('crx-collapsed')) {
        e.stopPropagation();
        collapsePanel(false);
      }
    });

    // ── Drag & Drop ──────────────────────────────────────────────────────────
    container.addEventListener('pointerdown', e => {
      const isCollapsed = container.classList.contains('crx-collapsed');
      if (!isCollapsed && !e.target.closest('#crx-drag-handle')) return;
      root.style.transition = '';
      isDragging = true;
      hasMoved = false;
      startX = e.clientX; startY = e.clientY;
      offsetX = e.clientX - root.offsetLeft;
      offsetY = e.clientY - root.offsetTop;
      const captureTarget = isCollapsed ? container : handle;
      try { captureTarget.setPointerCapture(e.pointerId); } catch (_) {}
      if (!isCollapsed) handle.style.cursor = 'grabbing';
      container.style.cursor = 'grabbing';
      e.stopPropagation();
      e.preventDefault();
      resetInactivityTimer();
    });

    let dragRafId = null;
    container.addEventListener('pointermove', e => {
      if (!isDragging) return;
      e.stopPropagation();
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        hasMoved = true;
        hasBeenDragged = true;
        root.setAttribute('data-has-been-dragged', 'true');
      }
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
      const isCollapsed = container.classList.contains('crx-collapsed');
      const captureTarget = isCollapsed ? container : handle;
      try { captureTarget.releasePointerCapture(e.pointerId); } catch (_) {}
      if (!isCollapsed) handle.style.cursor = '';
      container.style.cursor = '';
      e.stopPropagation();
      if (isCollapsed) {
        if (!hasMoved) expandPanel();
        else snapToNearestEdge();
      }
    });
    container.addEventListener('pointercancel', () => { isDragging = false; });

    const handleResize = () => {
      if (container.classList.contains('crx-collapsed')) {
        snapToNearestEdge();
      } else {
        const rect = root.getBoundingClientRect();
        const maxLeft = window.innerWidth - rect.width;
        const maxTop = window.innerHeight - rect.height;
        root.style.left = `${Math.max(0, Math.min(root.offsetLeft, maxLeft))}px`;
        root.style.top = `${Math.max(0, Math.min(root.offsetTop, maxTop))}px`;
      }
    };
    window.addEventListener('resize', handleResize);

    // ── Close button ─────────────────────────────────────────────────────────
    shadow.getElementById('crx-close-btn').addEventListener('click', e => {
      if (isRecording) return; // don't let the panel vanish mid-recording
      if (inactivityTimeout) { clearTimeout(inactivityTimeout); inactivityTimeout = null; }
      try { resizeObserver.disconnect(); } catch (_) {}
      window.removeEventListener('resize', handleResize);
      container.classList.remove('crx-visible');
      setTimeout(() => { root.remove(); }, 400);
      e.stopPropagation();
    });

    // ── Minimize button ──────────────────────────────────────────────────────
    shadow.getElementById('crx-minimize-btn').addEventListener('click', e => {
      e.stopPropagation();
      collapsePanel(true);
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
    const qualitySelect = shadow.getElementById('crx-select-quality');
    const countdownToggle = shadow.getElementById('crx-toggle-countdown');
    const controlsToggle = shadow.getElementById('crx-toggle-controls');

    let settings = { quality: 'auto', countdown: true, controls: true };
    chrome.storage.local.get(['screencraft_settings'], res => {
      settings = { ...settings, ...(res.screencraft_settings || {}) };
      qualitySelect.value = settings.quality;
      countdownToggle.checked = settings.countdown;
      controlsToggle.checked = settings.controls;
    });

    const saveSettings = () => chrome.storage.local.set({ screencraft_settings: settings });

    qualitySelect.addEventListener('change', () => { settings.quality = qualitySelect.value; saveSettings(); });
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
      container.classList.toggle('crx-is-recording', recording);
      sourceRows.forEach(r => r.style.pointerEvents = recording ? 'none' : '');
      sourceRows.forEach(r => r.style.opacity = recording ? '0.5' : '');
    };

    const runCountdown = async () => {
      if (!settings.countdown) return;
      for (const n of [3, 2, 1]) {
        status.className = 'crx-status crx-status-running';
        status.innerHTML = `Starting in ${n}…`;
        await sleep(700);
      }
    };

    const startTimer = () => {
      recordStartTime = Date.now();
      if (timerInterval) clearInterval(timerInterval);
      const tick = () => {
        if (!settings.controls) return;
        status.className = 'crx-status crx-status-running';
        status.innerHTML = `<span class="crx-spinner"></span> Recording ${formatTime(Date.now() - recordStartTime)}`;
      };
      tick();
      timerInterval = setInterval(tick, 1000);
    };

    const stopTimer = () => {
      if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    };

    const startRecording = async () => {
      container.classList.add('crx-filling');
      await runCountdown();

      try {
        const displayOptions = { video: true, audio: true };
        if (selectedSource === 'window') displayOptions.video = { displaySurface: 'window' };
        else if (selectedSource === 'screen') displayOptions.video = { displaySurface: 'monitor' };
        else if (selectedSource === 'tab') {
          try { displayOptions.preferCurrentTab = true; } catch (_) {}
        }

        const screenStream = await navigator.mediaDevices.getDisplayMedia(displayOptions);
        allTracks.push(...screenStream.getTracks());

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
          setRecordingUIState(false);
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
      } catch (e) {
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
