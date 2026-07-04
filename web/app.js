(() => {
  const ACCENT = "#3b82f6";
  const STORE_KEY = "opendirector.project.v1";
  const H = { video: 64, audio: 50, subtitle: 42 };
  const CHIP = { video: "V", audio: "A", subtitle: "T" };
  const CHIP_COLOR = { video: ACCENT, audio: "oklch(0.6 0.1 178)", subtitle: "oklch(0.62 0.13 300)" };

  let state = loadState() || defaults();
  let els = {};
  let backendStatus = null;
  let raf = null;
  let lastTick = 0;
  let toastTimer = null;
  let exportJob = null;
  let exportTimer = null;
  let previewProxyTimer = null;
  let previewDecodeTimer = null;

  document.addEventListener("DOMContentLoaded", init);
  window.addEventListener("pywebviewready", () => refreshBackend());

  function init() {
    cacheElements();
    bindEvents();
    renderAll(false);
    setTimeout(refreshBackend, 120);
  }

  function cacheElements() {
    const ids = [
      "projectMeta", "openProjectBtn", "saveProjectBtn", "importBtn", "encoderSelect", "exportBtn", "subsToggle", "backendStatus",
      "previewVideo", "previewAudio", "previewPattern", "previewDot", "previewTrackName", "currentTC", "totalTC",
      "previewCenter", "previewLabel", "previewSub", "caption", "toStartBtn", "playBtn", "toEndBtn",
      "transportTC", "selectToolBtn", "splitToolBtn", "splitPlayheadBtn", "mergeBtn", "copyBtn",
      "pasteBtn", "deleteBtn", "selectionInfo", "clipboardInfo", "undoBtn", "resetBtn", "zoomOutBtn",
      "zoomPct", "zoomInBtn", "trackHeaders", "timelineScroll", "timelineContent", "contextMenu",
      "subtitleModal", "subtitleInput", "cancelSubtitleBtn", "saveSubtitleBtn", "exportPanel",
      "exportTitle", "cancelExportBtn", "exportProgress", "exportMessage", "toast",
    ];
    ids.forEach((id) => { els[id] = document.getElementById(id); });
  }

  function bindEvents() {
    els.openProjectBtn.addEventListener("click", openProjectFile);
    els.saveProjectBtn.addEventListener("click", () => saveProject(false));
    els.importBtn.addEventListener("click", importMedia);
    els.exportBtn.addEventListener("click", startExport);
    els.encoderSelect.addEventListener("change", () => {
      state.encoder = els.encoderSelect.value;
      persist();
    });
    els.subsToggle.addEventListener("click", () => {
      state.showSubs = !state.showSubs;
      persist();
      renderAll(false);
    });
    els.toStartBtn.addEventListener("click", () => setPlayhead(0));
    els.toEndBtn.addEventListener("click", () => setPlayhead(state.total));
    els.playBtn.addEventListener("click", togglePlay);
    els.selectToolBtn.addEventListener("click", () => setTool("select"));
    els.splitToolBtn.addEventListener("click", () => setTool("split"));
    els.splitPlayheadBtn.addEventListener("click", splitPlayhead);
    els.mergeBtn.addEventListener("click", doMerge);
    els.copyBtn.addEventListener("click", doCopy);
    els.pasteBtn.addEventListener("click", doPaste);
    els.deleteBtn.addEventListener("click", doDelete);
    els.undoBtn.addEventListener("click", undo);
    els.resetBtn.addEventListener("click", doReset);
    els.zoomOutBtn.addEventListener("click", () => zoom(-6));
    els.zoomInBtn.addEventListener("click", () => zoom(6));
    els.timelineContent.addEventListener("pointerdown", onTimelinePointerDown);
    els.timelineContent.addEventListener("contextmenu", onTimelineContextMenu);
    els.contextMenu.addEventListener("pointerdown", (event) => event.stopPropagation());
    els.contextMenu.addEventListener("click", onContextMenuClick);
    document.addEventListener("pointerdown", (event) => {
      if (!event.target.closest("#contextMenu")) closeMenu();
    });
    document.addEventListener("keydown", onKeyDown);
    els.subtitleModal.addEventListener("click", (event) => {
      if (event.target === els.subtitleModal) cancelEdit();
    });
    els.cancelSubtitleBtn.addEventListener("click", cancelEdit);
    els.saveSubtitleBtn.addEventListener("click", saveEdit);
    els.subtitleInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") saveEdit();
      if (event.key === "Escape") cancelEdit();
    });
    els.cancelExportBtn.addEventListener("click", cancelExport);
    els.previewVideo.addEventListener("loadeddata", () => renderPlayback());
    els.previewVideo.addEventListener("error", onPreviewVideoError);
  }

  function defaults() {
    return {
      name: "未命名專案",
      width: 1920,
      height: 1080,
      fps: 30,
      total: 48,
      pxPerSec: 18,
      playhead: 0,
      selectedId: null,
      tool: "select",
      isPlaying: false,
      clipboard: null,
      history: [],
      menu: null,
      editing: null,
      showSubs: true,
      encoder: "auto-gpu",
      projectPath: null,
      tracks: [
        { id: "v1", type: "video", name: "影片軌 1", clips: [] },
        { id: "v2", type: "video", name: "影片軌 2", clips: [] },
        { id: "m1", type: "audio", name: "音訊軌", clips: [] },
        { id: "s1", type: "subtitle", name: "字幕軌", clips: [] },
      ],
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      const base = defaults();
      const merged = {
        ...base,
        ...saved,
        selectedId: null,
        isPlaying: false,
        history: [],
        menu: null,
        editing: null,
      };
      merged.tracks = stripRuntimeFields(merged.tracks);
      return merged;
    } catch {
      return null;
    }
  }

  // The media-server URL, its token and the proxy state are all bound to a
  // single run (ephemeral port + in-memory token map + in-memory proxy
  // cache), so they are dead after a restart. Drop them and let each clip be
  // re-resolved from `source` (repairStoredMediaUrls), which also re-attaches
  // any on-disk proxy. Otherwise a stale URL 404s → error code 4.
  function stripRuntimeFields(tracks) {
    return (tracks || []).map((track) => ({
      ...track,
      clips: (track.clips || []).map((clip) => {
        if (!clip || !clip.source) return clip;
        const { url, fileUrl, proxyUrl, proxyPath, proxyTried, proxyState, ...rest } = clip;
        return rest;
      }),
    }));
  }

  function projectPayload() {
    return {
      name: state.name,
      width: state.width,
      height: state.height,
      fps: state.fps,
      total: state.total,
      pxPerSec: state.pxPerSec,
      playhead: state.playhead,
      showSubs: state.showSubs,
      encoder: state.encoder,
      tracks: state.tracks,
    };
  }

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ ...projectPayload(), projectPath: state.projectPath }));
    } catch {
      // localStorage can be disabled in embedded runtimes.
    }
  }

  async function refreshBackend() {
    if (!apiReady()) {
      setBackendMessage("pywebview 尚未連線");
      populateEncoders([]);
      return;
    }
    try {
      const status = await window.pywebview.api.get_status();
      backendStatus = status;
      const gpu = status.gpuEncoders || [];
      populateEncoders(gpu);
      if (!status.ffmpegFound) {
        setBackendMessage("找不到 ffmpeg");
      } else if (gpu.length) {
        setBackendMessage(`ffmpeg 就緒 · GPU：${gpu[0].label}`);
      } else {
        setBackendMessage("ffmpeg 就緒 · 未偵測 GPU encoder");
      }
      repairStoredMediaUrls();
    } catch (error) {
      setBackendMessage(`後端錯誤：${error.message || error}`);
    }
  }

  async function repairStoredMediaUrls() {
    if (!apiReady()) return;
    const clips = state.tracks
      .flatMap((track) => track.clips)
      .filter((clip) => clip.source && (!clip.url || clip.url.startsWith("file:")));
    if (!clips.length) return;
    let changed = false;
    for (const clip of clips) {
      try {
        const response = await window.pywebview.api.probe_media(clip.source);
        if (response.ok && response.media) {
          Object.assign(clip, {
            url: response.media.url,
            fileUrl: response.media.fileUrl,
            hasAudio: response.media.hasAudio,
            videoCodec: response.media.videoCodec,
            audioCodec: response.media.audioCodec,
          });
          // Re-attach an already-built proxy so undecodable sources (VP9, HEVC…)
          // load straight from H.264 instead of flashing an error first.
          try {
            const ready = await window.pywebview.api.get_ready_preview(clip.source);
            if (ready.ok && ready.ready && ready.preview) {
              clip.url = ready.preview.url;
              clip.proxyUrl = ready.preview.url;
              clip.proxyPath = ready.preview.path;
              clip.proxyState = "done";
            }
          } catch {
            // No cached proxy — the decode watcher will build one on demand.
          }
          changed = true;
        }
      } catch {
        // Keep the existing clip if a stored file is no longer available.
      }
    }
    if (changed) {
      persist();
      renderAll(false);
    }
  }

  function onPreviewVideoError() {
    const active = activeVideoClip();
    if (!active) return;
    const video = els.previewVideo;
    const errorCode = video.error ? video.error.code : "unknown";
    video.classList.add("hidden");
    els.previewCenter.classList.remove("video-on");
    els.previewLabel.textContent = "正在產生預覽代理";
    els.previewSub.textContent = `WebView 無法直接播放此來源，錯誤碼 ${errorCode}`;
    startPreviewProxy(active.clip, `錯誤碼 ${errorCode}`);
  }

  // WebView2 can "load" some sources (VP9-in-MP4, HEVC, exotic pixel formats)
  // far enough to report duration and drive the progress bar, yet never render a
  // frame — and without firing an `error` event. requestVideoFrameCallback is the
  // reliable signal: if no frame is ever presented shortly after load, the source
  // is undecodable here, so we fall back to an ffmpeg H.264 proxy. A source that
  // genuinely plays presents its first frame almost immediately, so a slow-but-
  // playable file is never transcoded needlessly.
  function watchDecode(clip) {
    const video = els.previewVideo;
    clearTimeout(previewDecodeTimer);
    if (clip.proxyUrl || clip.proxyTried) return;
    let frameSeen = false;
    const hasRVFC = typeof video.requestVideoFrameCallback === "function";
    if (hasRVFC) {
      try { video.requestVideoFrameCallback(() => { frameSeen = true; }); } catch {}
    }
    previewDecodeTimer = setTimeout(() => {
      if (video.dataset.clipId !== clip.id) return;
      if (clip.proxyUrl || clip.proxyState === "running" || clip.proxyTried) return;
      if (video.error) return; // the error handler already owns this case
      const rendered = hasRVFC ? frameSeen : (video.readyState >= 2 && video.videoWidth > 0);
      if (!rendered) startPreviewProxy(clip, "WebView 無法解碼此來源");
    }, 4000);
  }

  async function startPreviewProxy(clip, reason) {
    if (!apiReady() || !clip || !clip.source || clip.proxyState === "running" || clip.proxyTried) return;
    clip.proxyTried = true;
    clip.proxyState = "running";
    els.previewVideo.pause();
    els.previewVideo.classList.add("hidden");
    els.previewCenter.classList.remove("video-on");
    els.previewLabel.textContent = "正在產生預覽代理";
    els.previewSub.textContent = reason ? `${reason} · ffmpeg H.264 proxy` : "ffmpeg H.264 proxy";
    try {
      const response = await window.pywebview.api.start_preview_proxy(clip.source);
      if (!response.ok) {
        clip.proxyState = "failed";
        els.previewLabel.textContent = "預覽代理失敗";
        els.previewSub.textContent = response.error || "ffmpeg proxy failed";
        return;
      }
      if (response.ready && response.preview) {
        applyPreviewProxy(clip, response.preview);
        return;
      }
      pollPreviewProxy(response.jobId, clip.id);
    } catch (error) {
      clip.proxyState = "failed";
      els.previewLabel.textContent = "預覽代理失敗";
      els.previewSub.textContent = error.message || String(error);
    }
  }

  function pollPreviewProxy(jobId, clipId) {
    clearInterval(previewProxyTimer);
    previewProxyTimer = setInterval(async () => {
      try {
        const response = await window.pywebview.api.get_preview_proxy_status(jobId);
        if (!response.ok) return;
        const job = response.job;
        const found = findClip(clipId);
        if (found && job.message) {
          found.clip.proxyState = job.state;
          if (found.clip.id === state.selectedId || activeVideoClip()?.clip.id === found.clip.id) {
            els.previewLabel.textContent = job.state === "done" ? "預覽代理完成" : "正在產生預覽代理";
            const pct = job.progress ? ` · ${Math.round(job.progress * 100)}%` : "";
            els.previewSub.textContent = `${job.message}${pct}`;
          }
        }
        if (job.state === "done" && found && job.preview) {
          clearInterval(previewProxyTimer);
          previewProxyTimer = null;
          applyPreviewProxy(found.clip, job.preview);
        } else if (["failed", "cancelled"].includes(job.state)) {
          clearInterval(previewProxyTimer);
          previewProxyTimer = null;
          if (found) found.clip.proxyState = "failed";
          els.previewLabel.textContent = "預覽代理失敗";
          els.previewSub.textContent = job.message || "ffmpeg proxy failed";
        }
      } catch (error) {
        clearInterval(previewProxyTimer);
        previewProxyTimer = null;
        els.previewLabel.textContent = "預覽代理失敗";
        els.previewSub.textContent = error.message || String(error);
      }
    }, 900);
  }

  function applyPreviewProxy(clip, preview) {
    clip.proxyState = "done";
    clip.proxyUrl = preview.url;
    clip.proxyPath = preview.path;
    clip.url = preview.url;
    persist();
    toast("預覽代理完成，已切換到 H.264 proxy");
    renderAll(false);
  }
  function populateEncoders(gpuEncoders) {
    const current = state.encoder || "auto-gpu";
    const autoLabel = gpuEncoders.length ? `自動 GPU (${gpuEncoders[0].label})` : "自動 GPU (無則 CPU)";
    const options = [{ value: "auto-gpu", label: autoLabel }]
      .concat(gpuEncoders.map((item) => ({ value: item.name, label: item.label })))
      .concat([{ value: "libx264", label: "CPU libx264" }]);
    els.encoderSelect.innerHTML = options.map((item) => (
      `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`
    )).join("");
    els.encoderSelect.value = options.some((item) => item.value === current) ? current : "auto-gpu";
    state.encoder = els.encoderSelect.value;
  }

  function setBackendMessage(message) {
    els.backendStatus.textContent = message;
  }

  function renderAll(save = true) {
    renderHeader();
    renderToolbar();
    renderTimeline();
    renderPlayback();
    renderMenu();
    renderModal();
    if (save) persist();
  }

  function renderHeader() {
    els.projectMeta.textContent = `${state.name} · ${state.height}p · ${formatFps(state.fps)}fps`;
    els.subsToggle.classList.toggle("off", !state.showSubs);
  }

  function renderToolbar() {
    els.selectToolBtn.classList.toggle("active", state.tool === "select");
    els.splitToolBtn.classList.toggle("active", state.tool === "split");
    const selected = findClip(state.selectedId);
    if (selected) {
      const speed = selected.clip.speed || 1;
      const speedText = Math.abs(speed - 1) > 0.001 ? ` · ${round(speed)}×` : "";
      els.selectionInfo.textContent = `${selected.clip.label || "未命名"} · ${tc(selected.clip.duration)}${speedText}`;
    } else {
      els.selectionInfo.textContent = "未選取 · —";
    }
    els.clipboardInfo.textContent = state.clipboard ? `· 剪貼簿：${state.clipboard.clip.label || "片段"}` : "";
    els.mergeBtn.classList.toggle("disabled", !canMerge());
    els.pasteBtn.classList.toggle("disabled", !state.clipboard);
    els.undoBtn.classList.toggle("disabled", !state.history.length);
    els.zoomPct.textContent = `${Math.round(state.pxPerSec / 18 * 100)}%`;
  }

  function renderTimeline() {
    const pps = state.pxPerSec;
    const width = Math.max(1, state.total * pps);
    els.trackHeaders.innerHTML = state.tracks.map((track) => {
      const h = H[track.type];
      return `
        <div class="track-header" style="height:${h}px">
          <span class="track-name">${escapeHtml(track.name)}</span>
          <span class="track-chip" style="background:${CHIP_COLOR[track.type]}">${CHIP[track.type]}</span>
        </div>`;
    }).join("");

    const ticks = renderTicks(width);
    const lanes = state.tracks.map((track) => renderLane(track, width)).join("");
    els.timelineContent.style.width = `${width}px`;
    els.timelineContent.innerHTML = `
      <div class="ruler" data-ruler style="width:${width}px">${ticks}</div>
      ${lanes}
      <div id="playhead" class="playhead" style="left:${state.playhead * pps}px">
        <div class="playhead-knob" data-playhead-knob></div>
      </div>`;
  }

  function renderTicks(width) {
    const pps = state.pxPerSec;
    const step = pps >= 34 ? 1 : pps >= 18 ? 2 : pps >= 12 ? 5 : 10;
    let html = "";
    for (let t = 0; t <= state.total + 0.001; t += step) {
      html += `<div class="tick" style="left:${t * pps}px">${rl(t)}</div>`;
    }
    return html || `<div class="tick" style="left:0">0:00</div>`;
  }

  function renderLane(track, width) {
    const h = H[track.type];
    const clips = track.clips.slice().sort((a, b) => a.start - b.start).map((clip) => renderClip(track, clip, h)).join("");
    const empty = track.clips.length ? "" : `<div class="empty-lane">${track.type === "video" ? "匯入影片" : track.type === "audio" ? "匯入音訊" : "右鍵新增字幕"}</div>`;
    return `<div class="lane ${track.type}" data-track-id="${track.id}" style="height:${h}px;width:${width}px">${empty}${clips}</div>`;
  }

  function renderClip(track, clip, laneHeight) {
    const selected = clip.id === state.selectedId;
    const speed = clip.speed || 1;
    const hasSpeed = Math.abs(speed - 1) > 0.001;
    const width = Math.max(10, clip.duration * state.pxPerSec);
    const bg = clipBackground(track.type, clip);
    const topbar = clipTopbar(track.type, clip);
    const splitClass = state.tool === "split" ? " split-mode" : "";
    return `
      <div class="clip${selected ? " selected" : ""}${splitClass}"
        data-clip-id="${clip.id}"
        style="left:${clip.start * state.pxPerSec}px;height:${laneHeight - 10}px;width:${width}px;background:${bg}">
        <div class="clip-topbar" style="background:${topbar}"></div>
        ${track.type === "audio" ? `<div class="wave"></div>` : ""}
        ${hasSpeed ? `<div class="speed-badge">${round(speed)}×</div>` : ""}
        <div class="clip-label">${escapeHtml(clip.label || "片段")}</div>
        <div class="handle left" data-handle="left"></div>
        <div class="handle right" data-handle="right"></div>
      </div>`;
  }

  function clipBackground(type, clip) {
    if (type === "video") {
      const hue = clip.hue || 250;
      return `linear-gradient(180deg, oklch(0.5 0.12 ${hue}), oklch(0.4 0.1 ${hue}))`;
    }
    if (type === "audio") return "linear-gradient(180deg, oklch(0.42 0.07 178), oklch(0.34 0.06 178))";
    return "linear-gradient(180deg, oklch(0.46 0.1 300), oklch(0.38 0.09 300))";
  }

  function clipTopbar(type, clip) {
    if (type === "video") return `oklch(0.74 0.15 ${clip.hue || 250})`;
    if (type === "audio") return "oklch(0.62 0.1 178)";
    return "oklch(0.66 0.14 300)";
  }

  function renderPlayback() {
    const active = activeVideoClip();
    const subtitle = activeSubtitle();
    const current = tc(state.playhead);
    const total = tc(state.total);
    els.currentTC.textContent = current;
    els.totalTC.textContent = total;
    els.transportTC.textContent = current;
    els.playBtn.innerHTML = state.isPlaying
      ? `<svg width="18" height="18" viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>`
      : `<svg width="18" height="18" viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z" fill="currentColor"/></svg>`;
    const playhead = document.getElementById("playhead");
    if (playhead) playhead.style.left = `${state.playhead * state.pxPerSec}px`;

    if (active) {
      const { track, clip } = active;
      els.previewDot.classList.remove("off");
      els.previewTrackName.textContent = track.name;
      els.previewLabel.textContent = clip.label || "片段";
      els.previewSub.textContent = `${tc(clip.start)} – ${tc(clip.start + clip.duration)}`;
      const hue = clip.hue || 250;
      els.previewPattern.style.background = `repeating-linear-gradient(135deg, oklch(0.30 0.05 ${hue}) 0 16px, oklch(0.235 0.04 ${hue}) 16px 32px)`;
      syncPreviewVideo(clip);
    } else {
      els.previewDot.classList.add("off");
      els.previewTrackName.textContent = "";
      const audioActive = activeAudioClip();
      if (audioActive) {
        els.previewLabel.textContent = audioActive.clip.label || "音訊";
        els.previewSub.textContent = `音訊 · ${tc(audioActive.clip.start)} – ${tc(audioActive.clip.start + audioActive.clip.duration)}`;
      } else {
        els.previewLabel.textContent = hasAnyMedia() ? "無訊號" : "匯入媒體開始剪輯";
        els.previewSub.textContent = "";
      }
      els.previewPattern.style.background = "repeating-linear-gradient(135deg, #161619 0 16px, #121215 16px 32px)";
      syncPreviewVideo(null);
    }

    // Audio-track clips (music / imported MP3s) have no video element of their
    // own — drive them through a dedicated <audio> so the preview actually has
    // sound, mirroring what the export's audio filters mix together.
    syncPreviewAudio(activeAudioClip());

    if (subtitle && state.showSubs) {
      els.caption.textContent = subtitle.label || "";
      els.caption.classList.remove("hidden");
    } else {
      els.caption.textContent = "";
      els.caption.classList.add("hidden");
    }
  }

  function renderMenu() {
    const menu = state.menu;
    if (!menu) {
      els.contextMenu.classList.add("hidden");
      els.contextMenu.innerHTML = "";
      return;
    }
    const x = Math.max(8, Math.min(menu.x, window.innerWidth - 204));
    const y = Math.max(8, Math.min(menu.y, window.innerHeight - 250));
    els.contextMenu.style.left = `${x}px`;
    els.contextMenu.style.top = `${y}px`;
    els.contextMenu.classList.remove("hidden");

    if (menu.kind === "clip") {
      const found = findClip(menu.id);
      if (!found) return closeMenu();
      const isMedia = found.track.type === "video" || found.track.type === "audio";
      const isSubtitle = found.track.type === "subtitle";
      const speedHtml = isMedia ? `
        <div class="section-title">播放速度</div>
        <div class="speed-grid">
          ${[0.25, 0.5, 1, 1.5, 2, 4].map((speed) => {
            const active = Math.abs((found.clip.speed || 1) - speed) < 0.001;
            return `<button class="speed-btn${active ? " active" : ""}" data-action="speed" data-speed="${speed}">${speed === 1 ? "正常" : `${speed}×`}</button>`;
          }).join("")}
        </div>
        <div class="menu-divider"></div>` : "";
      els.contextMenu.innerHTML = `
        ${speedHtml}
        ${isSubtitle ? `<button class="menu-item accent" data-action="edit-subtitle">編輯字幕文字</button>` : ""}
        <button class="menu-item" data-action="copy">複製片段</button>
        <button class="menu-item danger" data-action="delete">刪除片段</button>`;
      return;
    }

    const track = getTrack(menu.trackId);
    const canPasteHere = state.clipboard && track && state.clipboard.type === track.type;
    els.contextMenu.innerHTML = `
      ${track && track.type === "subtitle" ? `<button class="menu-item accent" data-action="add-subtitle">＋ 新增字幕</button>` : ""}
      ${canPasteHere ? `<button class="menu-item" data-action="paste-here">在此貼上</button>` : ""}`;
  }

  function renderModal() {
    if (!state.editing) {
      els.subtitleModal.classList.add("hidden");
      return;
    }
    els.subtitleModal.classList.remove("hidden");
    if (document.activeElement !== els.subtitleInput) {
      els.subtitleInput.value = state.editing.value || "";
      setTimeout(() => {
        els.subtitleInput.focus();
        els.subtitleInput.select();
      }, 0);
    }
  }

  function syncPreviewVideo(clip) {
    const video = els.previewVideo;
    if (!clip || !clip.url) {
      video.pause();
      video.removeAttribute("src");
      delete video.dataset.clipId;
      delete video.dataset.url;
      video.classList.add("hidden");
      els.previewCenter.classList.remove("video-on");
      return;
    }
    // A proxy is being built because this source can't be decoded here. Keep the
    // (black) source hidden so the "產生預覽代理 …%" placeholder stays visible
    // instead of every render re-showing a black frame.
    if (clip.proxyState === "running" && !clip.proxyUrl) {
      video.pause();
      video.classList.add("hidden");
      els.previewCenter.classList.remove("video-on");
      return;
    }
    if (video.dataset.clipId !== clip.id || video.dataset.url !== clip.url) {
      video.pause();
      video.src = clip.url;
      video.dataset.clipId = clip.id;
      video.dataset.url = clip.url;
      video.load();
      watchDecode(clip);
    }
    const speed = clip.speed || 1;
    const desired = Math.max(0, (clip.sourceIn || 0) + (state.playhead - clip.start) * speed);
    video.playbackRate = speed;
    // While playing, the <video> is the master clock (see advancePlayhead), so
    // we must not seek it every frame — that fights playback and aborts the
    // in-flight range request. Only correct a large divergence (a scrub during
    // playback, or a freshly loaded clip). While paused, seek precisely so the
    // still frame matches the playhead.
    const threshold = state.isPlaying ? 0.5 : 0.05;
    if (Number.isFinite(desired) && video.readyState > 0 && Math.abs(video.currentTime - desired) > threshold) {
      try { video.currentTime = desired; } catch {}
    }
    video.classList.remove("hidden");
    els.previewCenter.classList.add("video-on");
    if (state.isPlaying) {
      const promise = video.play();
      if (promise && promise.catch) promise.catch(() => {});
    } else {
      video.pause();
    }
  }

  function syncPreviewAudio(active) {
    const audio = els.previewAudio;
    const clip = active && active.clip;
    if (!clip || !clip.url) {
      audio.pause();
      if (audio.dataset.clipId) {
        audio.removeAttribute("src");
        delete audio.dataset.clipId;
        delete audio.dataset.url;
        audio.load();
      }
      return;
    }
    if (audio.dataset.clipId !== clip.id || audio.dataset.url !== clip.url) {
      audio.pause();
      audio.src = clip.url;
      audio.dataset.clipId = clip.id;
      audio.dataset.url = clip.url;
      audio.load();
    }
    const speed = clip.speed || 1;
    const desired = Math.max(0, (clip.sourceIn || 0) + (state.playhead - clip.start) * speed);
    audio.playbackRate = speed;
    // Same rule as the video: while playing the element is the clock, so only
    // correct a big divergence; while paused, seek precisely to the playhead.
    const threshold = state.isPlaying ? 0.5 : 0.05;
    if (Number.isFinite(desired) && audio.readyState > 0 && Math.abs(audio.currentTime - desired) > threshold) {
      try { audio.currentTime = desired; } catch {}
    }
    if (state.isPlaying) {
      const promise = audio.play();
      if (promise && promise.catch) promise.catch(() => {});
    } else {
      audio.pause();
    }
  }

  function onTimelinePointerDown(event) {
    if (event.button === 2) return;
    const knob = event.target.closest("[data-playhead-knob]");
    const ruler = event.target.closest("[data-ruler]");
    if (knob || ruler) {
      seekDrag(event);
      return;
    }
    const handle = event.target.closest("[data-handle]");
    if (handle) {
      const clipEl = event.target.closest("[data-clip-id]");
      if (clipEl) startTrim(event, clipEl.dataset.clipId, handle.dataset.handle);
      return;
    }
    const clipEl = event.target.closest("[data-clip-id]");
    if (clipEl) {
      const id = clipEl.dataset.clipId;
      if (state.tool === "split") {
        const found = findClip(id);
        if (!found) return;
        const rect = clipEl.getBoundingClientRect();
        const time = found.clip.start + (event.clientX - rect.left) / state.pxPerSec;
        splitAt(id, time);
      } else {
        startMove(event, id);
      }
    }
  }

  function onTimelineContextMenu(event) {
    const clipEl = event.target.closest("[data-clip-id]");
    if (clipEl) {
      event.preventDefault();
      openClipMenu(event, clipEl.dataset.clipId);
      return;
    }
    const laneEl = event.target.closest("[data-track-id]");
    if (laneEl) {
      event.preventDefault();
      const rect = laneEl.getBoundingClientRect();
      const time = Math.max(0, (event.clientX - rect.left) / state.pxPerSec);
      state.menu = { kind: "lane", x: event.clientX, y: event.clientY, trackId: laneEl.dataset.trackId, time };
      renderMenu();
    }
  }

  function onContextMenuClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button || !state.menu) return;
    const action = button.dataset.action;
    if (action === "speed") setSpeed(state.menu.id, Number(button.dataset.speed));
    if (action === "copy") doCopy();
    if (action === "delete") doDelete();
    if (action === "edit-subtitle") openEdit(state.menu.id);
    if (action === "add-subtitle") addSubtitle(state.menu.trackId, state.menu.time);
    if (action === "paste-here") pasteAt(state.menu.trackId, state.menu.time);
    closeMenu();
  }

  function onKeyDown(event) {
    const tag = event.target && event.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (event.code === "Space") {
      event.preventDefault();
      togglePlay();
    } else if (event.key === "Delete" || event.key === "Backspace") {
      if (state.selectedId) {
        event.preventDefault();
        doDelete();
      }
    } else if ((event.key === "c" || event.key === "C") && (event.metaKey || event.ctrlKey)) {
      if (state.selectedId) {
        event.preventDefault();
        doCopy();
      }
    } else if ((event.key === "v" || event.key === "V") && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      doPaste();
    } else if ((event.key === "z" || event.key === "Z") && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      undo();
    } else if ((event.key === "s" || event.key === "S") && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      saveProject(event.shiftKey);
    } else if ((event.key === "o" || event.key === "O") && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      openProjectFile();
    } else if ((event.key === "s" || event.key === "S") && !event.altKey) {
      splitPlayhead();
    } else if (event.key === "Escape") {
      state.selectedId = null;
      closeMenu();
      renderAll();
    }
  }

  async function saveProject(saveAs = false) {
    if (!apiReady()) {
      toast("需要透過 Python pywebview 啟動才能儲存專案");
      return;
    }
    try {
      const target = saveAs ? null : (state.projectPath || null);
      const response = await window.pywebview.api.save_project(projectPayload(), target);
      if (!response.ok) {
        toast(response.error || "儲存專案失敗");
        return;
      }
      if (response.cancelled || !response.path) return;
      state.projectPath = response.path;
      const stem = fileStem(response.path);
      if (stem) state.name = stem;
      persist();
      renderHeader();
      toast(`已儲存專案：${response.path}`);
    } catch (error) {
      toast(error.message || String(error));
    }
  }

  async function openProjectFile() {
    if (!apiReady()) {
      toast("需要透過 Python pywebview 啟動才能開啟專案");
      return;
    }
    try {
      const response = await window.pywebview.api.open_project();
      if (!response.ok) {
        toast(response.error || "開啟專案失敗");
        return;
      }
      if (response.cancelled || !response.project) return;
      applyLoadedProject(response.project, response.path);
      const missing = response.missingMedia || [];
      if (missing.length) {
        toast(`已開啟專案，但有 ${missing.length} 個媒體檔案找不到`);
      } else {
        toast(`已開啟專案：${fileStem(response.path) || response.path}`);
      }
    } catch (error) {
      toast(error.message || String(error));
    }
  }

  function applyLoadedProject(project, path) {
    stopPlayback();
    state = {
      ...defaults(),
      ...project,
      tracks: stripRuntimeFields(project.tracks),
      projectPath: path || null,
      selectedId: null,
      isPlaying: false,
      history: [],
      clipboard: null,
      menu: null,
      editing: null,
    };
    state.playhead = clamp(Number(state.playhead) || 0, 0, state.total || 0);
    persist();
    renderAll(false);
    repairStoredMediaUrls();
  }

  function fileStem(value) {
    const name = String(value || "").split(/[\\/]/).pop() || "";
    return name.replace(/\.[^.]+$/, "");
  }

  async function importMedia() {
    if (!apiReady()) {
      toast("需要透過 Python pywebview 啟動才能匯入媒體");
      return;
    }
    try {
      const response = await window.pywebview.api.choose_media();
      if (!response.ok) {
        toast(response.error || "匯入失敗");
        return;
      }
      const files = response.files || [];
      if (!files.length) return;
      const wasEmpty = !hasAnyMedia();
      let imported = 0;
      for (const file of files) {
        if (file.ok === false) {
          toast(file.error || "有媒體無法讀取");
          continue;
        }
        if (!imported) pushHistory();
        addMediaClip(file);
        imported += 1;
      }
      if (!imported) return;
      if (wasEmpty) state.playhead = 0;
      normalizeTotal();
      state.selectedId = lastMediaClipId();
      renderAll();
      toast(`已匯入 ${imported} 個媒體`);
    } catch (error) {
      toast(error.message || String(error));
    }
  }

  function addMediaClip(media) {
    const targetType = media.kind === "audio" ? "audio" : "video";
    const track = state.tracks.find((item) => item.type === targetType) || state.tracks[0];
    const start = nextTrackEnd(track);
    const duration = Math.max(0.3, Number(media.duration) || 1);
    const clip = {
      id: nid(),
      start,
      duration,
      sourceIn: 0,
      speed: 1,
      label: stripExtension(media.name || "媒體"),
      source: media.path,
      url: media.url,
      hue: hueFromName(media.name || media.path || ""),
      hasAudio: !!media.hasAudio,
      mediaKind: media.kind,
      sourceDuration: duration,
    };
    if (targetType === "video") {
      if (media.width && media.height) {
        state.width = Number(media.width) || state.width;
        state.height = Number(media.height) || state.height;
      }
      if (media.fps) state.fps = Math.round(Number(media.fps) * 1000) / 1000;
    }
    track.clips.push(clip);
  }

  function lastMediaClipId() {
    let id = null;
    for (const track of state.tracks) {
      for (const clip of track.clips) {
        if (clip.source) id = clip.id;
      }
    }
    return id;
  }

  async function startExport() {
    if (!apiReady()) {
      toast("需要透過 Python pywebview 啟動才能輸出");
      return;
    }
    if (!hasAnyMedia()) {
      toast("請先匯入媒體");
      return;
    }
    try {
      const save = await window.pywebview.api.choose_export_path(`${state.name || "opendirector"}-export.mp4`);
      if (!save.ok) {
        toast(save.error || "無法選擇輸出位置");
        return;
      }
      if (!save.path) return;
      const options = {
        output: save.path,
        encoder: els.encoderSelect.value || state.encoder || "auto-gpu",
        width: state.width,
        height: state.height,
        fps: state.fps,
        crf: 20,
        preset: "medium",
        includeSubtitles: state.showSubs,
      };
      const response = await window.pywebview.api.start_export(exportProject(), options);
      if (!response.ok) {
        toast(response.error || "輸出失敗");
        return;
      }
      exportJob = response.jobId;
      showExportPanel("輸出中", "ffmpeg 準備中", 0);
      pollExport();
      exportTimer = setInterval(pollExport, 700);
    } catch (error) {
      toast(error.message || String(error));
    }
  }

  async function pollExport() {
    if (!exportJob || !apiReady()) return;
    try {
      const response = await window.pywebview.api.get_export_status(exportJob);
      if (!response.ok) return;
      const job = response.job;
      showExportPanel(job.state === "done" ? "輸出完成" : "輸出中", job.message || "", job.progress || 0);
      if (["done", "failed", "cancelled"].includes(job.state)) {
        clearInterval(exportTimer);
        exportTimer = null;
        exportJob = null;
        if (job.state === "done") toast(`輸出完成：${job.output}`);
        if (job.state === "failed") toast(job.message || "輸出失敗");
      }
    } catch (error) {
      clearInterval(exportTimer);
      exportTimer = null;
      toast(error.message || String(error));
    }
  }

  async function cancelExport() {
    if (!exportJob || !apiReady()) return;
    await window.pywebview.api.cancel_export(exportJob);
    exportJob = null;
    clearInterval(exportTimer);
    exportTimer = null;
    hideExportPanel();
  }

  function exportProject() {
    return {
      name: state.name,
      width: state.width,
      height: state.height,
      fps: state.fps,
      total: state.total,
      tracks: state.tracks.map((track) => ({
        id: track.id,
        type: track.type,
        name: track.name,
        clips: track.clips.map((clip) => ({ ...clip })),
      })),
    };
  }

  function showExportPanel(title, message, progress) {
    els.exportPanel.classList.remove("hidden");
    els.exportTitle.textContent = title;
    els.exportMessage.textContent = message;
    els.exportProgress.style.width = `${Math.round((progress || 0) * 100)}%`;
  }

  function hideExportPanel() {
    els.exportPanel.classList.add("hidden");
  }

  function startMove(event, id) {
    const found = findClip(id);
    if (!found) return;
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
    state.selectedId = id;
    renderAll();
    const pps = state.pxPerSec;
    const x0 = event.clientX;
    const start0 = found.clip.start;
    const duration = found.clip.duration;
    let pushed = false;
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - x0;
      if (Math.abs(dx) < 2 && !moved) return;
      moved = true;
      if (!pushed) {
        pushHistory();
        pushed = true;
      }
      let next = Math.max(0, start0 + dx / pps);
      next = snap(next, id, duration);
      found.clip.start = next;
      state.total = Math.max(state.total, Math.ceil(next + duration));
      renderAll(false);
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      persist();
      renderAll(false);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  function startTrim(event, id, side) {
    const found = findClip(id);
    if (!found) return;
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
    state.selectedId = id;
    const pps = state.pxPerSec;
    const x0 = event.clientX;
    const start0 = found.clip.start;
    const duration0 = found.clip.duration;
    const sourceIn0 = found.clip.sourceIn || 0;
    const speed = found.clip.speed || 1;
    let pushed = false;
    const move = (ev) => {
      if (!pushed) {
        pushHistory();
        pushed = true;
      }
      const dx = (ev.clientX - x0) / pps;
      if (side === "left") {
        const end = start0 + duration0;
        let nextStart = Math.max(0, Math.min(end - 0.3, start0 + dx));
        let nextDuration = end - nextStart;
        nextStart = snap(nextStart, id, nextDuration);
        nextDuration = Math.max(0.3, end - nextStart);
        const delta = nextStart - start0;
        found.clip.start = nextStart;
        found.clip.duration = nextDuration;
        found.clip.sourceIn = Math.max(0, sourceIn0 + delta * speed);
      } else {
        const sourceRemaining = found.clip.sourceDuration
          ? Math.max(0.3, (found.clip.sourceDuration - (found.clip.sourceIn || 0)) / speed)
          : Infinity;
        const nextDuration = Math.min(sourceRemaining, Math.max(0.3, duration0 + dx));
        found.clip.duration = nextDuration;
        state.total = Math.max(state.total, Math.ceil(start0 + nextDuration));
      }
      renderAll(false);
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      persist();
      renderAll(false);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  function seekDrag(event) {
    event.preventDefault();
    event.stopPropagation();
    const rect = els.timelineContent.getBoundingClientRect();
    const set = (clientX) => {
      state.playhead = clamp((clientX - rect.left) / state.pxPerSec, 0, state.total);
      renderPlayback();
    };
    set(event.clientX);
    const move = (ev) => set(ev.clientX);
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      persist();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  function setTool(tool) {
    state.tool = tool;
    renderAll();
  }

  function setPlayhead(value) {
    state.playhead = clamp(value, 0, state.total);
    persist();
    renderPlayback();
  }

  function togglePlay() {
    if (state.isPlaying) {
      stopPlayback();
      return;
    }
    if (state.playhead >= state.total) state.playhead = 0;
    state.isPlaying = true;
    lastTick = performance.now();
    tick(lastTick);
  }

  function tick(now) {
    if (!state.isPlaying) return;
    const dt = (now - lastTick) / 1000;
    lastTick = now;
    advancePlayhead(dt);
    if (state.playhead >= state.total) {
      stopPlayback();
      state.playhead = state.total;
      renderPlayback();
      persist();
      return;
    }
    renderPlayback();
    raf = requestAnimationFrame(tick);
  }

  // The timeline can span multiple clips, gaps and black segments, so a wall
  // clock stays the fallback master. But while a single video clip is actually
  // playing, read the playhead straight from the element — smoother than a wall
  // clock, and it removes the per-frame corrective seeks that caused the churn.
  function advancePlayhead(dt) {
    const av = activeVideoClip();
    const aa = activeAudioClip();
    // Prefer the video element as the master clock; fall back to the audio
    // element for audio-only stretches; otherwise the wall clock carries the
    // playhead across gaps and black segments.
    if (av && mediaIsDriving(av.clip, els.previewVideo)) {
      setPlayheadFromMedia(av.clip, els.previewVideo);
    } else if (aa && mediaIsDriving(aa.clip, els.previewAudio)) {
      setPlayheadFromMedia(aa.clip, els.previewAudio);
    } else {
      state.playhead = Math.min(state.total, state.playhead + dt);
    }
  }

  function setPlayheadFromMedia(clip, el) {
    const speed = clip.speed || 1;
    const t = clip.start + (el.currentTime - (clip.sourceIn || 0)) / speed;
    // Never let a stale/backward element time drag the playhead backwards.
    state.playhead = clamp(Math.max(state.playhead, t), 0, state.total);
  }

  function mediaIsDriving(clip, el) {
    if (!clip.url || el.paused || el.ended || el.readyState < 2) return false;
    if (el.dataset.clipId !== clip.id) return false;
    const speed = clip.speed || 1;
    const srcStart = clip.sourceIn || 0;
    const srcEnd = srcStart + clip.duration * speed;
    // Trust the element only while it is inside this clip's trimmed window; once
    // it plays past the trim point, the wall clock carries us into the next gap.
    return el.currentTime >= srcStart - 0.05 && el.currentTime < srcEnd;
  }

  function stopPlayback() {
    state.isPlaying = false;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    els.previewVideo.pause();
    els.previewAudio.pause();
    renderPlayback();
    persist();
  }

  function splitPlayhead() {
    const selected = findClip(state.selectedId);
    if (selected && insideClip(selected.clip, state.playhead, 0.3)) {
      splitAt(selected.clip.id, state.playhead);
      return;
    }
    const active = activeVideoClip();
    if (active && insideClip(active.clip, state.playhead, 0.3)) {
      splitAt(active.clip.id, state.playhead);
      return;
    }
    for (const track of state.tracks) {
      const clip = track.clips.find((item) => insideClip(item, state.playhead, 0.3));
      if (clip) {
        splitAt(clip.id, state.playhead);
        return;
      }
    }
  }

  function splitAt(id, time) {
    const found = findClip(id);
    if (!found) return;
    const clip = found.clip;
    if (time <= clip.start + 0.3 || time >= clip.start + clip.duration - 0.3) return;
    pushHistory();
    const speed = clip.speed || 1;
    const first = { ...clip, duration: time - clip.start };
    const second = {
      ...clip,
      id: nid(),
      start: time,
      duration: clip.start + clip.duration - time,
      sourceIn: (clip.sourceIn || 0) + (time - clip.start) * speed,
    };
    found.track.clips = found.track.clips.filter((item) => item.id !== id).concat(first, second);
    state.selectedId = second.id;
    renderAll();
  }

  function doMerge() {
    const found = findClip(state.selectedId);
    if (!found) return;
    const clips = found.track.clips.slice().sort((a, b) => a.start - b.start);
    const index = clips.findIndex((item) => item.id === found.clip.id);
    if (index < 0 || index >= clips.length - 1) return;
    pushHistory();
    const a = clips[index];
    const b = clips[index + 1];
    const start = Math.min(a.start, b.start);
    const end = Math.max(a.start + a.duration, b.start + b.duration);
    const merged = { ...a, start, duration: end - start, label: `${a.label || "片段"} + ${b.label || "片段"}` };
    found.track.clips = found.track.clips.filter((item) => item.id !== a.id && item.id !== b.id).concat(merged);
    state.selectedId = merged.id;
    state.total = Math.max(state.total, Math.ceil(end));
    renderAll();
  }

  function doCopy() {
    const found = findClip(state.selectedId);
    if (!found) return;
    const clip = { ...found.clip };
    delete clip.id;
    state.clipboard = { trackId: found.track.id, type: found.track.type, clip };
    renderAll();
  }

  function doPaste() {
    if (!state.clipboard) return;
    pasteAt(state.clipboard.trackId, state.playhead);
  }

  function pasteAt(trackId, time) {
    const clipboard = state.clipboard;
    if (!clipboard) return;
    const track = getTrack(trackId) || state.tracks.find((item) => item.type === clipboard.type);
    if (!track) return;
    pushHistory();
    const duration = clipboard.clip.duration || 1;
    const insertAt = Math.max(0, Number(time) || 0);
    const clip = { ...clipboard.clip, id: nid(), start: insertAt };
    track.clips.push(clip);
    state.selectedId = clip.id;
    state.total = Math.max(state.total, Math.ceil(insertAt + duration));
    renderAll();
  }

  function doDelete() {
    const found = findClip(state.selectedId);
    if (!found) return;
    pushHistory();
    found.track.clips = found.track.clips.filter((item) => item.id !== found.clip.id);
    state.selectedId = null;
    normalizeTotal();
    renderAll();
  }

  function doReset() {
    pushHistory();
    const fresh = defaults();
    state.tracks = fresh.tracks;
    state.total = fresh.total;
    state.playhead = 0;
    state.selectedId = null;
    state.clipboard = null;
    stopPlayback();
    renderAll();
  }

  function undo() {
    if (!state.history.length) return;
    const snap = JSON.parse(state.history.pop());
    state.tracks = snap.tracks;
    state.total = snap.total;
    state.selectedId = null;
    stopPlayback();
    renderAll();
  }

  function zoom(delta) {
    state.pxPerSec = clamp(Math.round((state.pxPerSec + delta) * 10) / 10, 8, 48);
    renderAll();
  }

  function setSpeed(id, speed) {
    const found = findClip(id);
    if (!found) return;
    pushHistory();
    const oldSpeed = found.clip.speed || 1;
    const sourceSpan = found.clip.duration * oldSpeed;
    found.clip.speed = speed;
    found.clip.duration = Math.max(0.3, sourceSpan / speed);
    normalizeTotal();
    renderAll();
  }

  function addSubtitle(trackId, time) {
    const track = getTrack(trackId);
    if (!track || track.type !== "subtitle") return;
    pushHistory();
    const start = Math.round(Math.max(0, time || 0) * 10) / 10;
    const clip = { id: nid(), start, duration: 3, label: "新字幕" };
    track.clips.push(clip);
    state.selectedId = clip.id;
    state.editing = { id: clip.id, value: clip.label };
    state.total = Math.max(state.total, Math.ceil(start + clip.duration));
    renderAll();
  }

  function openEdit(id) {
    const found = findClip(id);
    if (!found) return;
    state.editing = { id, value: found.clip.label || "" };
    renderAll(false);
  }

  function saveEdit() {
    if (!state.editing) return;
    const found = findClip(state.editing.id);
    if (!found) return cancelEdit();
    pushHistory();
    found.clip.label = (els.subtitleInput.value || "").trim() || "字幕";
    state.editing = null;
    renderAll();
  }

  function cancelEdit() {
    state.editing = null;
    renderAll(false);
  }

  function openClipMenu(event, id) {
    const found = findClip(id);
    if (!found) return;
    state.selectedId = id;
    state.menu = { kind: "clip", x: event.clientX, y: event.clientY, id };
    renderAll();
  }

  function closeMenu() {
    if (!state.menu) return;
    state.menu = null;
    renderMenu();
  }

  function pushHistory() {
    const snap = JSON.stringify({ tracks: state.tracks, total: state.total });
    state.history = state.history.concat(snap).slice(-50);
  }

  function snap(nextStart, id, duration) {
    const threshold = 7 / state.pxPerSec;
    const found = findClip(id);
    if (!found) return Math.max(0, Math.round(nextStart * 10) / 10);
    const edges = [0, state.playhead];
    found.track.clips.forEach((clip) => {
      if (clip.id !== id) edges.push(clip.start, clip.start + clip.duration);
    });
    let best = null;
    let bestDistance = threshold;
    edges.forEach((edge) => {
      const distance = Math.abs(nextStart - edge);
      if (distance < bestDistance) {
        best = edge;
        bestDistance = distance;
      }
    });
    if (best !== null) return Math.max(0, best);
    best = null;
    bestDistance = threshold;
    edges.forEach((edge) => {
      const distance = Math.abs(nextStart + duration - edge);
      if (distance < bestDistance) {
        best = edge - duration;
        bestDistance = distance;
      }
    });
    if (best !== null) return Math.max(0, best);
    return Math.max(0, Math.round(nextStart * 10) / 10);
  }

  function activeVideoClip() {
    const videoTracks = state.tracks.filter((track) => track.type === "video");
    for (let i = videoTracks.length - 1; i >= 0; i -= 1) {
      const track = videoTracks[i];
      const clip = track.clips.find((item) => state.playhead >= item.start && state.playhead < item.start + item.duration);
      if (clip) return { track, clip };
    }
    return null;
  }

  function activeAudioClip() {
    const audioTracks = state.tracks.filter((track) => track.type === "audio");
    for (let i = audioTracks.length - 1; i >= 0; i -= 1) {
      const track = audioTracks[i];
      const clip = track.clips.find((item) => item.url && state.playhead >= item.start && state.playhead < item.start + item.duration);
      if (clip) return { track, clip };
    }
    return null;
  }

  function activeSubtitle() {
    const track = state.tracks.find((item) => item.type === "subtitle");
    if (!track) return null;
    return track.clips.find((clip) => state.playhead >= clip.start && state.playhead < clip.start + clip.duration) || null;
  }

  function findClip(id) {
    if (!id) return null;
    for (const track of state.tracks) {
      const clip = track.clips.find((item) => item.id === id);
      if (clip) return { track, clip };
    }
    return null;
  }

  function getTrack(id) {
    return state.tracks.find((track) => track.id === id) || null;
  }

  function canMerge() {
    const found = findClip(state.selectedId);
    if (!found) return false;
    const clips = found.track.clips.slice().sort((a, b) => a.start - b.start);
    const index = clips.findIndex((item) => item.id === found.clip.id);
    return index >= 0 && index < clips.length - 1;
  }

  function insideClip(clip, time, margin = 0) {
    return time > clip.start + margin && time < clip.start + clip.duration - margin;
  }

  // Recompute the timeline length from the clips so it can shrink again after
  // deletes/speed-ups instead of only ever growing. Falls back to the default
  // length for an empty project, and keeps the playhead inside the timeline.
  function normalizeTotal() {
    const end = Math.ceil(maxClipEnd());
    state.total = Math.max(1, end || defaults().total);
    state.playhead = clamp(state.playhead, 0, state.total);
  }

  function maxClipEnd() {
    return state.tracks.reduce((max, track) => (
      Math.max(max, ...track.clips.map((clip) => clip.start + clip.duration))
    ), 0);
  }

  function nextTrackEnd(track) {
    if (!track.clips.length) return 0;
    return Math.max(...track.clips.map((clip) => clip.start + clip.duration));
  }

  function hasAnyMedia() {
    return state.tracks.some((track) => track.clips.some((clip) => !!clip.source));
  }

  function apiReady() {
    return !!(window.pywebview && window.pywebview.api);
  }

  function nid() {
    return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  function stripExtension(name) {
    return String(name).replace(/\.[^.]+$/, "");
  }

  function hueFromName(name) {
    let hash = 0;
    for (const char of String(name)) hash = ((hash << 5) - hash) + char.charCodeAt(0);
    return 205 + Math.abs(hash % 80);
  }

  function tc(value) {
    const x = Math.max(0, Number(value) || 0);
    const m = Math.floor(x / 60);
    const s = Math.floor(x % 60);
    const f = Math.floor((x - Math.floor(x)) * (state.fps || 30));
    return `${pad(m)}:${pad(s)}:${pad(f)}`;
  }

  function rl(value) {
    const x = Math.max(0, Number(value) || 0);
    const m = Math.floor(x / 60);
    const s = Math.floor(x % 60);
    return `${m}:${pad(s)}`;
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function round(value) {
    return Math.round(value * 100) / 100;
  }

  function formatFps(value) {
    const fps = Number(value) || 30;
    return Number.isInteger(fps) ? String(fps) : fps.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function toast(message) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.remove("hidden");
    toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 3600);
  }

  // Test hook: exposes editing internals when loaded under the script harness
  // (scripts/test_frontend.mjs sets window.__OD_TEST__ before importing).
  // Never active inside the real app.
  if (typeof window !== "undefined" && window.__OD_TEST__) {
    window.__odTest = {
      getState: () => state,
      setState: (next) => { state = next; },
      init,
      defaults, loadState, stripRuntimeFields, projectPayload, applyLoadedProject,
      addMediaClip, splitAt, doMerge, doCopy, doPaste, pasteAt, doDelete, undo,
      setSpeed, addSubtitle, normalizeTotal, maxClipEnd, snap, findClip,
      tc, rl, fileStem, stripExtension, hueFromName,
    };
  }
})();
