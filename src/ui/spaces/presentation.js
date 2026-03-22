// ── Space: Presentation ──
let presSaveTimer = null;
let presSlidesSaveTimer = null;

function renderSpacePresentation(item) {
  const description = item.description || "";
  const spaceData = item.space_data ? (typeof item.space_data === "string" ? JSON.parse(item.space_data) : item.space_data) : {};
  const slidesMd = spaceData.slides_md || "";
  const artifactUrl = spaceData.artifact_url || "";

  spaceBody.innerHTML = `
    <div class="pres-space" id="presSpace">
      <div class="pres-main-pane">
        <div class="pres-tab-bar">
          <button class="pres-tab active" data-tab="description">Description</button>
          <button class="pres-tab" data-tab="slides">Slides</button>
          <button class="pres-tab" data-tab="artifact">Artifact</button>
        </div>
        <!-- Tab 1: Description -->
        <div class="pres-tab-panel active" id="presTabDescription">
          <div class="pres-editor-toolbar">
            <div class="version-nav" id="presVersionNav">
              <button class="version-nav-btn" id="presVersionBack" title="Previous version" disabled>◀</button>
              <button class="version-nav-btn" id="presVersionFwd" title="Next version" disabled>▶</button>
              <span class="version-date" id="presVersionDate"></span>
            </div>
            <button class="space-btn pres-revert-btn" id="presRevertBtn" title="Revert to this version" style="display:none;">Revert</button>
            <div class="toolbar-spacer"></div>
            <span class="pres-word-count" id="presWordCount"></span>
            <span class="copy-btn-wrap"><button class="space-btn" id="presCopyBtn" title="Copy text to clipboard">Copy</button><span class="copy-popup" id="presCopyPopup">Copied!</span></span>
            <button class="space-btn" id="presPreviewToggle" title="Toggle preview">Preview</button>
            <span class="pres-save-indicator" id="presDescSaveIndicator"></span>
          </div>
          <div class="pres-editor-area" id="presEditorArea">
            <textarea id="presDescTextarea" placeholder="Start writing...&#10;&#10;Use this tab for brainstorming and overall structure.">${esc(description)}</textarea>
          </div>
          <div class="pres-preview-area" id="presPreviewArea" style="display:none;"></div>
        </div>
        <!-- Tab 2: Slides -->
        <div class="pres-tab-panel" id="presTabSlides">
          <div class="pres-editor-toolbar">
            <div class="toolbar-spacer"></div>
            <span class="pres-save-indicator" id="presSlidesSaveIndicator"></span>
          </div>
          <div class="pres-editor-area">
            <textarea id="presSlidesTextarea" placeholder="Write your slides in Markdown...&#10;&#10;Use --- to separate slides">${esc(slidesMd)}</textarea>
          </div>
        </div>
        <!-- Tab 3: Artifact -->
        <div class="pres-tab-panel" id="presTabArtifact">
          <div class="pres-artifact-toolbar">
            <input type="text" id="presArtifactUrl" placeholder="Enter artifact URL (https://...)" value="${esc(artifactUrl)}">
            <button class="space-btn" id="presArtifactLoad">Load</button>
            <button class="space-btn" id="presArtifactOpen" title="Open in new tab">↗</button>
          </div>
          <div class="pres-artifact-frame" id="presArtifactFrame">
            ${artifactUrl ? `<iframe id="presArtifactIframe" src="${esc(artifactUrl)}" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>` : '<div class="pres-artifact-empty">Enter an artifact URL above to embed it here</div>'}
          </div>
        </div>
      </div>
      <div class="pres-sidebar">
        <div class="pres-sidebar-tabs">
          <button class="pres-sidebar-tab active" data-panel="discussion">Discussion</button>
        </div>
        <div class="pres-sidebar-panel active" id="presPanelDiscussion">
          <div class="pres-discussion">
            <div class="pres-discussion-thread" id="presDiscussionThread"></div>
            <div class="pres-discussion-input">
              <textarea id="presCommentInput" placeholder="Add a comment..." rows="2"></textarea>
              <button id="presCommentSubmit">Send</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Initialize version navigation
  textVersionIndex = -1;
  updatePresVersionNav();

  // Populate discussion thread
  renderPresDiscussion(item.comments || []);

  // Update word count
  updatePresWordCount(description);

  // ── Tab switching ──
  $$("#presSpace .pres-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      $$("#presSpace .pres-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      $$("#presSpace .pres-tab-panel").forEach(p => p.classList.remove("active"));
      const panel = $(`#presTab${target.charAt(0).toUpperCase() + target.slice(1)}`);
      if (panel) panel.classList.add("active");
    });
  });

  // ── Tab 1: Description ──
  const descTextarea = $("#presDescTextarea");
  const descSaveIndicator = $("#presDescSaveIndicator");

  // Auto-save (debounced)
  descTextarea.addEventListener("input", () => {
    descSaveIndicator.textContent = "Unsaved changes...";
    descSaveIndicator.className = "pres-save-indicator";
    updatePresWordCount(descTextarea.value);
    if (presSaveTimer) clearTimeout(presSaveTimer);
    presSaveTimer = setTimeout(() => savePresDescription(), 2000);
  });

  // Cmd+S — manual save + version snapshot
  descTextarea.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      savePresDescription(true);
    }
  });

  // Copy button
  $("#presCopyBtn").addEventListener("click", () => {
    const text = descTextarea.value;
    const showPopup = () => {
      const popup = $("#presCopyPopup");
      if (popup) { popup.classList.add("show"); setTimeout(() => popup.classList.remove("show"), 1800); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(showPopup).catch(() => {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.left = "-9999px";
        document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); showPopup(); } catch { toast("Failed to copy", "error"); }
        document.body.removeChild(ta);
      });
    } else {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.left = "-9999px";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); showPopup(); } catch { toast("Failed to copy", "error"); }
      document.body.removeChild(ta);
    }
  });

  // Preview toggle
  let presPreviewMode = false;
  $("#presPreviewToggle").addEventListener("click", () => {
    presPreviewMode = !presPreviewMode;
    const editorEl = $("#presEditorArea");
    const previewEl = $("#presPreviewArea");
    if (presPreviewMode) {
      previewEl.innerHTML = renderMarkdown(descTextarea.value);
      editorEl.style.display = "none";
      previewEl.style.display = "";
      $("#presPreviewToggle").textContent = "Edit";
    } else {
      editorEl.style.display = "";
      previewEl.style.display = "none";
      $("#presPreviewToggle").textContent = "Preview";
    }
  });

  // Version navigation
  $("#presVersionBack").addEventListener("click", () => {
    if (textVersionIndex === -1) {
      navigatePresVersion(spaceVersions.length - 1);
    } else if (textVersionIndex > 0) {
      navigatePresVersion(textVersionIndex - 1);
    }
  });

  $("#presVersionFwd").addEventListener("click", () => {
    if (textVersionIndex === -1) return;
    if (textVersionIndex >= spaceVersions.length - 1) {
      navigatePresVersion(-1);
    } else {
      navigatePresVersion(textVersionIndex + 1);
    }
  });

  // Revert to viewed version
  $("#presRevertBtn").addEventListener("click", async () => {
    if (textVersionIndex === -1) return;
    const ver = spaceVersions[textVersionIndex];
    if (!ver) return;
    if (!confirm(`Revert to version ${ver.version}? The current content will be saved as a new version.`)) return;
    try {
      await apiPost(`/items/${spaceItemId}/versions/revert`, {
        version_id: ver.id,
        actor: DEFAULT_AUTHOR,
      });
      if (spaceItemData) spaceItemData.description = ver.description;
      descTextarea.value = ver.description;
      descTextarea.disabled = false;
      updatePresWordCount(ver.description);
      try {
        spaceVersions = await apiGet(`/items/${spaceItemId}/versions`);
      } catch {}
      textVersionIndex = -1;
      updatePresVersionNav();
      toast("Reverted to version " + ver.version, "success");
    } catch (e) {
      toast("Failed to revert: " + (e.message || e), "error");
    }
  });

  // ── Tab 2: Slides ──
  const slidesTextarea = $("#presSlidesTextarea");
  const slidesSaveIndicator = $("#presSlidesSaveIndicator");

  slidesTextarea.addEventListener("input", () => {
    slidesSaveIndicator.textContent = "Unsaved changes...";
    slidesSaveIndicator.className = "pres-save-indicator";
    if (presSlidesSaveTimer) clearTimeout(presSlidesSaveTimer);
    presSlidesSaveTimer = setTimeout(() => savePresSlides(), 2000);
  });

  slidesTextarea.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      savePresSlides();
    }
  });

  // ── Tab 3: Artifact ──
  const artifactUrlInput = $("#presArtifactUrl");

  $("#presArtifactLoad").addEventListener("click", () => loadPresArtifact());
  artifactUrlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      loadPresArtifact();
    }
  });

  $("#presArtifactOpen").addEventListener("click", () => {
    const url = artifactUrlInput.value.trim();
    if (url) window.open(url, "_blank");
  });

  // ── Discussion ──
  $("#presCommentSubmit").addEventListener("click", () => submitPresComment());
  $("#presCommentInput").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submitPresComment();
    }
  });
}

/** Update word count for presentation description. */
function updatePresWordCount(text) {
  const el = $("#presWordCount");
  if (!el) return;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  el.textContent = `${words} word${words !== 1 ? "s" : ""}`;
}

/** Update version navigation UI for presentation space. */
function updatePresVersionNav() {
  const backBtn = $("#presVersionBack");
  const fwdBtn = $("#presVersionFwd");
  const dateEl = $("#presVersionDate");
  const revertBtn = $("#presRevertBtn");
  if (!backBtn || !fwdBtn || !dateEl) return;

  const hasVersions = spaceVersions && spaceVersions.length > 0;
  backBtn.disabled = !hasVersions || textVersionIndex === 0;
  fwdBtn.disabled = textVersionIndex === -1;

  if (textVersionIndex === -1) {
    dateEl.textContent = hasVersions ? `${spaceVersions.length} version${spaceVersions.length !== 1 ? "s" : ""}` : "";
    if (revertBtn) revertBtn.style.display = "none";
  } else {
    const ver = spaceVersions[textVersionIndex];
    if (ver) {
      dateEl.textContent = `v${ver.version} — ${formatTime(ver.created_at)}`;
    }
    if (revertBtn) revertBtn.style.display = "";
  }
}

/** Navigate to a specific version in presentation description. */
function navigatePresVersion(index) {
  const textarea = $("#presDescTextarea");
  if (!textarea) return;

  if (index === -1) {
    // Back to current
    textVersionIndex = -1;
    textarea.value = spaceItemData ? spaceItemData.description || "" : "";
    textarea.disabled = false;
  } else if (spaceVersions[index]) {
    textVersionIndex = index;
    textarea.value = spaceVersions[index].description || "";
    textarea.disabled = true;
  }
  updatePresVersionNav();
}

/** Render discussion thread for presentation space. */
function renderPresDiscussion(comments) {
  const thread = $("#presDiscussionThread");
  if (!thread) return;
  thread.innerHTML = "";
  if (!comments || comments.length === 0) {
    thread.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:40px 20px;font-size:0.85rem;">No comments yet.</div>';
    return;
  }
  comments.forEach(c => {
    if (c.body && c.body.startsWith("[Version ") && c.body.includes(" saved]")) {
      const div = document.createElement("div");
      div.className = "text-version-marker";
      div.innerHTML = `<span>${esc(c.body)}</span>`;
      thread.appendChild(div);
      return;
    }
    const div = document.createElement("div");
    div.className = "text-comment";
    div.dataset.author = c.author;
    div.innerHTML = `
      <div class="text-comment-header">
        <span class="text-comment-author">${esc(c.author)}</span>
        <span class="text-comment-time">${formatTime(c.created_at)}</span>
      </div>
      <div class="text-comment-body">${renderMarkdown(c.body)}</div>
    `;
    thread.appendChild(div);
  });
  thread.scrollTop = thread.scrollHeight;
}

/** Save presentation description (auto-save or manual). */
async function savePresDescription(createVersion = false) {
  if (!spaceItemId) return;
  const textarea = $("#presDescTextarea");
  if (!textarea || textarea.disabled) return;
  const newDesc = textarea.value;
  const saveIndicator = $("#presDescSaveIndicator");

  try {
    saveIndicator.textContent = "Saving...";
    saveIndicator.className = "pres-save-indicator saving";
    await apiPatch(`/items/${spaceItemId}`, {
      description: newDesc,
      actor: DEFAULT_AUTHOR,
    });
    if (spaceItemData) spaceItemData.description = newDesc;

    if (createVersion) {
      const ver = await apiPost(`/items/${spaceItemId}/versions`, {
        description: newDesc,
        saved_by: DEFAULT_AUTHOR,
      });
      spaceVersions.push(ver);
      updatePresVersionNav();
      saveIndicator.textContent = `v${ver.version} saved`;
    } else {
      try {
        const prevCount = spaceVersions.length;
        spaceVersions = await apiGet(`/items/${spaceItemId}/versions`);
        if (spaceVersions.length > prevCount) {
          updatePresVersionNav();
        }
      } catch (e2) { /* version refresh is non-critical */ }
      saveIndicator.textContent = "Saved";
    }
    saveIndicator.className = "pres-save-indicator saved";
    setTimeout(() => {
      if (saveIndicator.textContent === "Saved" || saveIndicator.textContent.startsWith("v")) {
        saveIndicator.textContent = "";
      }
    }, 3000);
  } catch (e) {
    saveIndicator.textContent = "Save failed!";
    saveIndicator.className = "pres-save-indicator";
    toast("Failed to save: " + e.message, "error");
  }
}

/** Save slides markdown content. */
async function savePresSlides() {
  if (!spaceItemId) return;
  const textarea = $("#presSlidesTextarea");
  if (!textarea) return;
  const slidesSaveIndicator = $("#presSlidesSaveIndicator");

  try {
    slidesSaveIndicator.textContent = "Saving...";
    slidesSaveIndicator.className = "pres-save-indicator saving";
    await apiPatch(`/items/${spaceItemId}/presentation/slides`, {
      slides_md: textarea.value,
      actor: DEFAULT_AUTHOR,
    });
    slidesSaveIndicator.textContent = "Saved";
    slidesSaveIndicator.className = "pres-save-indicator saved";
    setTimeout(() => {
      if (slidesSaveIndicator.textContent === "Saved") {
        slidesSaveIndicator.textContent = "";
      }
    }, 3000);
  } catch (e) {
    slidesSaveIndicator.textContent = "Save failed!";
    slidesSaveIndicator.className = "pres-save-indicator";
    toast("Failed to save slides: " + e.message, "error");
  }
}

/** Load artifact URL into iframe and save it. */
async function loadPresArtifact() {
  const urlInput = $("#presArtifactUrl");
  const frame = $("#presArtifactFrame");
  if (!urlInput || !frame) return;

  const url = urlInput.value.trim();
  if (url && !url.startsWith("http://") && !url.startsWith("https://")) {
    toast("URL must start with http:// or https://", "error");
    return;
  }

  // Save URL to space_data
  if (spaceItemId) {
    try {
      await apiPatch(`/items/${spaceItemId}/presentation/artifact`, {
        artifact_url: url,
        actor: DEFAULT_AUTHOR,
      });
    } catch (e) {
      toast("Failed to save artifact URL: " + e.message, "error");
      return;
    }
  }

  // Update iframe
  if (url) {
    frame.innerHTML = `<iframe id="presArtifactIframe" src="${esc(url)}" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>`;
  } else {
    frame.innerHTML = '<div class="pres-artifact-empty">Enter an artifact URL above to embed it here</div>';
  }
}

/** Submit a comment in the presentation discussion. */
async function submitPresComment() {
  const input = $("#presCommentInput");
  if (!input) return;
  const body = input.value.trim();
  if (!body || !spaceItemId) return;
  const author = (() => {
    try { return localStorage.getItem(STORAGE_AUTHOR_KEY) || DEFAULT_AUTHOR; }
    catch { return DEFAULT_AUTHOR; }
  })();
  try {
    await apiPost(`/items/${spaceItemId}/comments`, { author, body });
    input.value = "";
    const item = await apiGet(`/items/${spaceItemId}`);
    spaceItemData = item;
    renderPresDiscussion(item.comments || []);
    toast("Comment posted");
  } catch (e) {
    toast("Failed to post comment: " + e.message, "error");
  }
}


registerSpacePlugin({
  name: "presentation",
  label: "Presentation",
  icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  description: "Tab-based workspace for developing presentations",
  capabilities: { versionHistory: true, liveRefresh: true },
  render: renderSpacePresentation,
  refreshDiscussion: renderPresDiscussion,
  refreshDashboard: null,
  cleanup: () => {
    if (presSaveTimer) { clearTimeout(presSaveTimer); presSaveTimer = null; }
    if (presSlidesSaveTimer) { clearTimeout(presSlidesSaveTimer); presSlidesSaveTimer = null; }
  },
});
