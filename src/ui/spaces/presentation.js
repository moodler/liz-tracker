// ── Space: Presentation ──
let presSaveTimer = null;

function renderSpacePresentation(item) {
  const description = item.description || "";
  const spaceData = item.space_data ? (typeof item.space_data === "string" ? JSON.parse(item.space_data) : item.space_data) : {};
  const deckSlug = spaceData.deck_slug || "";
  const deckUrl = spaceData.deck_url || "";

  spaceBody.innerHTML = `
    <div class="pres-space" id="presSpace">
      <div class="pres-main-pane">
        <div class="pres-tab-bar">
          <button class="pres-tab active" data-tab="description">Description</button>
          <button class="pres-tab" data-tab="slides">Slides</button>
          <button class="pres-tab" data-tab="deck">Deck</button>
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
        <!-- Tab 2: Slides (read-only MDX viewer) -->
        <div class="pres-tab-panel" id="presTabSlides">
          <div class="pres-editor-toolbar">
            <span style="font-size:0.8rem;color:var(--text-dim);">Deck source (read-only)</span>
            <div class="toolbar-spacer"></div>
            <span class="copy-btn-wrap"><button class="space-btn" id="presMdxCopyBtn" title="Copy MDX to clipboard">Copy</button><span class="copy-popup" id="presMdxCopyPopup">Copied!</span></span>
          </div>
          <div id="presMdxContent" class="pres-mdx-viewer">
            <div class="pres-mdx-empty">Loading deck source...</div>
          </div>
        </div>
        <!-- Tab 3: Deck (thumbnails + preview) -->
        <div class="pres-tab-panel" id="presTabDeck">
          ${deckSlug ? `
            <div class="pres-deck-toolbar">
              <span class="pres-deck-info">${esc(deckSlug)}</span>
              <button class="space-btn" id="presDeckOverview" title="Open overview">Overview</button>
              <button class="space-btn" id="presDeckPresenter" title="Open presenter view">Presenter</button>
              <button class="space-btn pres-deck-open-btn" id="presDeckPreview" title="Open live preview">Open Deck</button>
              <button class="space-btn" id="presDeckConfig" title="Change deck">&#9881;</button>
            </div>
            <div class="pres-deck-content" id="presDeckContent">
              <div class="pres-deck-loading">Loading thumbnails...</div>
            </div>
          ` : `
            <div class="pres-deck-empty" id="presDeckEmpty">
              <div>No deck linked yet</div>
              <div class="pres-deck-config" id="presDeckConfigForm">
                <label>Deck Slug</label>
                <input type="text" id="presDeckSlugInput" placeholder="e.g. 2026-03-moodlemoot-china" value="${esc(deckSlug)}">
                <label>DeckWright URL</label>
                <input type="text" id="presDeckUrlInput" placeholder="e.g. http://192.168.50.19:2222" value="${esc(deckUrl)}">
                <button class="space-btn pres-deck-open-btn" id="presDeckSaveConfig">Link Deck</button>
              </div>
            </div>
          `}
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

      // Lazy-load MDX content on first Slides tab visit
      if (target === "slides" && !presSlidesMdxLoaded) {
        loadPresMdx();
      }
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

  // ── Tab 2: Slides (read-only MDX) ──
  // Copy MDX button
  const mdxCopyBtn = $("#presMdxCopyBtn");
  if (mdxCopyBtn) {
    mdxCopyBtn.addEventListener("click", () => {
      const mdxEl = $("#presMdxContent");
      if (!mdxEl) return;
      const text = mdxEl.textContent || "";
      const showPopup = () => {
        const popup = $("#presMdxCopyPopup");
        if (popup) { popup.classList.add("show"); setTimeout(() => popup.classList.remove("show"), 1800); }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(showPopup).catch(() => { toast("Failed to copy", "error"); });
      }
    });
  }

  // ── Tab 3: Deck (thumbnails + preview) ──
  if (deckSlug && deckUrl) {
    // Open deck buttons
    const previewBtn = $("#presDeckPreview");
    if (previewBtn) previewBtn.addEventListener("click", () => window.open(`${deckUrl}/${deckSlug}/`, "_blank"));

    const overviewBtn = $("#presDeckOverview");
    if (overviewBtn) overviewBtn.addEventListener("click", () => window.open(`${deckUrl}/${deckSlug}/overview`, "_blank"));

    const presenterBtn = $("#presDeckPresenter");
    if (presenterBtn) presenterBtn.addEventListener("click", () => window.open(`${deckUrl}/${deckSlug}/presenter`, "_blank"));

    // Config gear button — show config form inline
    const configBtn = $("#presDeckConfig");
    if (configBtn) {
      configBtn.addEventListener("click", () => {
        const content = $("#presDeckContent");
        if (!content) return;
        content.innerHTML = `
          <div class="pres-deck-config">
            <label>Deck Slug</label>
            <input type="text" id="presDeckSlugInput" value="${esc(deckSlug)}">
            <label>DeckWright URL</label>
            <input type="text" id="presDeckUrlInput" value="${esc(deckUrl)}">
            <button class="space-btn pres-deck-open-btn" id="presDeckSaveConfig">Save</button>
          </div>
        `;
        $("#presDeckSaveConfig").addEventListener("click", () => savePresDeckConfig());
      });
    }

    // Load thumbnails
    loadPresDeckThumbnails(deckSlug, deckUrl);
  } else {
    // Config form for linking a deck
    const saveBtn = $("#presDeckSaveConfig");
    if (saveBtn) saveBtn.addEventListener("click", () => savePresDeckConfig());
  }

  // ── Discussion ──
  $("#presCommentSubmit").addEventListener("click", () => submitPresComment());
  $("#presCommentInput").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submitPresComment();
    }
  });
}

// ── MDX Loading ──
let presSlidesMdxLoaded = false;

async function loadPresMdx() {
  if (!spaceItemId) return;
  const mdxEl = $("#presMdxContent");
  if (!mdxEl) return;

  try {
    const data = await apiGet(`/items/${spaceItemId}/presentation/deck-mdx`);
    presSlidesMdxLoaded = true;
    if (data.mdx) {
      mdxEl.textContent = data.mdx;
      mdxEl.classList.remove("pres-mdx-empty");
    } else {
      mdxEl.innerHTML = `<div class="pres-mdx-empty">${esc(data.error || "No deck content available")}</div>`;
    }
  } catch (e) {
    mdxEl.innerHTML = `<div class="pres-mdx-empty">Failed to load deck source</div>`;
  }
}

// ── Deck Thumbnails ──
let presThumbnailPollTimer = null;

async function loadPresDeckThumbnails(slug, baseUrl) {
  const content = $("#presDeckContent");
  if (!content) return;

  try {
    const resp = await fetch(`${baseUrl}/api/thumbnails?deck=${encodeURIComponent(slug)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    if (data.status === "generating") {
      content.innerHTML = '<div class="pres-deck-loading">Generating thumbnails...</div>';
      // Poll until ready
      if (presThumbnailPollTimer) clearTimeout(presThumbnailPollTimer);
      presThumbnailPollTimer = setTimeout(() => loadPresDeckThumbnails(slug, baseUrl), 3000);
      return;
    }

    if (data.thumbnails && data.thumbnails.length > 0) {
      content.innerHTML = `<div class="pres-deck-thumbnails" id="presDeckThumbs"></div>`;
      const grid = $("#presDeckThumbs");
      data.thumbnails.forEach((thumbUrl, i) => {
        const div = document.createElement("div");
        div.className = "pres-deck-thumb";
        div.title = `Slide ${i + 1} — click to open at this slide`;
        div.innerHTML = `
          <img src="${esc(baseUrl + thumbUrl)}" alt="Slide ${i + 1}" loading="lazy">
          <div class="pres-deck-thumb-label">Slide ${i + 1}</div>
        `;
        div.addEventListener("click", () => {
          window.open(`${baseUrl}/${slug}/#${i + 1}`, "_blank");
        });
        grid.appendChild(div);
      });
    } else {
      content.innerHTML = '<div class="pres-deck-loading">No slides found in this deck</div>';
    }
  } catch (e) {
    content.innerHTML = `<div class="pres-deck-loading">Failed to load thumbnails: ${esc(e.message || String(e))}</div>`;
  }
}

// ── Deck Config ──
async function savePresDeckConfig() {
  if (!spaceItemId) return;
  const slugInput = $("#presDeckSlugInput");
  const urlInput = $("#presDeckUrlInput");
  const saveBtn = $("#presDeckSaveConfig");
  if (!slugInput || !urlInput) return;

  const slug = slugInput.value.trim();
  const url = urlInput.value.trim().replace(/\/+$/, ""); // strip trailing slash

  if (!slug) { toast("Deck slug is required", "error"); return; }
  if (!url) { toast("DeckWright URL is required", "error"); return; }

  // Show saving feedback on button
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
  }

  try {
    await apiPatch(`/items/${spaceItemId}/presentation/deck`, {
      deck_slug: slug,
      deck_url: url,
    });
    toast("Deck linked!", "success");
    // Full re-render to show the deck thumbnails view
    if (typeof openSpaceOverlay === "function") openSpaceOverlay(spaceItemId);
  } catch (e) {
    toast("Failed to save deck config: " + (e.message || e), "error");
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Link Deck";
    }
  }
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
    toast("Failed to post comment: " + (e.message || e), "error");
  }
}


registerSpacePlugin({
  name: "presentation",
  label: "Presentation",
  icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  description: "Tab-based workspace for developing presentations with DeckWright",
  capabilities: { versionHistory: true, liveRefresh: true },
  render: renderSpacePresentation,
  refreshDiscussion: renderPresDiscussion,
  refreshDashboard: null,
  cleanup: () => {
    if (presSaveTimer) { clearTimeout(presSaveTimer); presSaveTimer = null; }
    if (presThumbnailPollTimer) { clearTimeout(presThumbnailPollTimer); presThumbnailPollTimer = null; }
    presSlidesMdxLoaded = false;
  },
});
