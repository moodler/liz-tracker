// ── Space: Song ──
let songStylesSaveTimer = null;
let songAttachmentsCache = [];

function renderSpaceSong(item) {
  const description = item.description || "";

  spaceBody.innerHTML = `
    <div class="song-space" id="songSpace">
      <div class="song-main-pane">
        <div class="song-lyrics-toolbar">
          <div class="version-nav" id="songVersionNav">
            <button class="version-nav-btn" id="songVersionBack" title="Previous version" disabled>◀</button>
            <button class="version-nav-btn" id="songVersionFwd" title="Next version" disabled>▶</button>
            <span class="version-date" id="songVersionDate"></span>
          </div>
          <button class="space-btn text-revert-btn" id="songRevertBtn" title="Revert to this version" style="display:none;">Revert</button>
          <div class="toolbar-spacer"></div>
          <span class="text-comment-count" id="songCommentCount" title="Inline comments"></span>
          <span class="copy-btn-wrap"><button class="space-btn" id="songCopyBtn" title="Copy lyrics to clipboard">Copy</button><span class="copy-popup" id="songCopyPopup">Copied!</span></span>
          <button class="space-btn" id="songPreviewToggle" title="Toggle preview">Preview</button>
          <span class="text-save-indicator" id="songSaveIndicator"></span>
        </div>
        <div class="song-lyrics-editor" id="songLyricsEditor">
          <textarea id="songLyricsTextarea" placeholder="Start writing lyrics...&#10;&#10;Use section markers like [verse], [chorus], [bridge]...&#10;Stage directions in brackets like [soft vocal, whispered]">${esc(description)}</textarea>
        </div>
        <div class="song-lyrics-preview" id="songLyricsPreview" style="display:none;"></div>
      </div>
      <div class="song-sidebar">
        <div class="text-sidebar-tabs">
          <button class="text-sidebar-tab active" data-panel="discussion">Discussion</button>
          <button class="text-sidebar-tab" data-panel="details">Details</button>
        </div>
        <!-- Discussion Panel (comments) -->
        <div class="text-sidebar-panel active" id="songPanelDiscussion">
          <div class="text-discussion">
            <div class="text-discussion-thread" id="songDiscussionThread"></div>
            <div class="text-discussion-input">
              <textarea id="songCommentInput" placeholder="Add a comment..." rows="2"></textarea>
              <button id="songCommentSubmit">Send</button>
            </div>
          </div>
        </div>
        <!-- Details Panel (cover + styles) -->
        <div class="text-sidebar-panel" id="songPanelDetails">
          <div style="flex:1;overflow-y:auto;display:flex;flex-direction:column;">
            <div class="song-cover-area">
              <div class="song-cover-container" id="songCoverContainer">
                <img class="song-cover-img" id="songCoverImg" alt="Cover" />
                <div class="song-cover-placeholder">
                  <span class="cover-icon">🖼</span>
                  <span>Drop, paste, or click to<br/>add cover image</span>
                </div>
              </div>
              <input type="file" id="songCoverFileInput" accept="image/*" style="display:none;" />
              <div class="song-cover-actions" id="songCoverActions" style="display:none;">
                <button id="songCoverChange">Change</button>
                <button id="songCoverRemove">Remove</button>
              </div>
            </div>
            <div class="song-styles-area">
              <div class="song-styles-label">
                <span>Style Description</span>
                <span class="styles-save-status" id="songStylesSaveStatus"></span>
              </div>
              <textarea class="song-styles-textarea" id="songStylesTextarea" placeholder="Describe the musical style, mood, instrumentation, vocal approach..."></textarea>
            </div>
            <div class="song-link-area">
              <div class="song-styles-label"><span>Link</span></div>
              <div class="link-field-view" id="songLinkView" style="display:none;">
                <a id="songLinkAnchor" href="#" target="_blank" rel="noopener">—</a>
                <button class="link-field-edit-btn" id="songLinkEditBtn" title="Edit link">edit</button>
              </div>
              <div class="link-field-wrapper" id="songLinkEdit">
                <input type="url" id="songLinkInput" placeholder="https://..." />
                <button class="link-field-clear-btn" id="songLinkClear" title="Clear link" style="display:none;">&times;</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Initialize version navigation (functions are hoisted to outer scope)
  songVersionIndex = -1;
  updateSongVersionNav();

  // Populate discussion thread
  renderSongDiscussion(item.comments || []);

  // Update inline comment count
  updateSongCommentCount(description);

  // Load attachments (for cover image and styles.md)
  loadSongAttachments();

  // Populate link field
  populateSongLink(item.link);

  // ── Sidebar tab switching ──
  $$("#songSpace .text-sidebar-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const panel = tab.dataset.panel;
      $$("#songSpace .text-sidebar-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      $$("#songSpace .text-sidebar-panel").forEach(p => p.classList.remove("active"));
      const targetPanel = $(`#songPanel${panel.charAt(0).toUpperCase() + panel.slice(1)}`);
      if (targetPanel) targetPanel.classList.add("active");
    });
  });

  // ── Event bindings ──
  const textarea = $("#songLyricsTextarea");
  const saveIndicator = $("#songSaveIndicator");

  // Auto-save lyrics (debounced)
  textarea.addEventListener("input", () => {
    saveIndicator.textContent = "Unsaved changes...";
    saveIndicator.className = "text-save-indicator";
    updateSongCommentCount(textarea.value);
    if (spaceSaveTimer) clearTimeout(spaceSaveTimer);
    spaceSaveTimer = setTimeout(() => saveSongLyrics(), 2000);
  });

  // Cmd+S / Ctrl+S — manual save + version snapshot
  // Cmd+Shift+M — add inline comment at selection
  textarea.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      saveSongLyrics(true);
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "m" || e.key === "M")) {
      e.preventDefault();
      showCommentInput(textarea);
    }
  });

  // Selection-based inline comment toolbar
  textarea.addEventListener("mouseup", () => {
    setTimeout(() => showCommentToolbar(textarea), 10);
  });
  textarea.addEventListener("keyup", (e) => {
    if (e.shiftKey || e.key === "Shift") {
      setTimeout(() => showCommentToolbar(textarea), 10);
    }
  });

  // Comment count — click to scroll to first comment in textarea
  $("#songCommentCount").addEventListener("click", () => {
    const match = textarea.value.match(/\{>>/);
    if (match) {
      textarea.focus();
      textarea.selectionStart = match.index;
      textarea.selectionEnd = match.index;
      const linesBefore = textarea.value.substring(0, match.index).split("\n").length;
      const lineHeight = parseFloat(window.getComputedStyle(textarea).lineHeight) || 24;
      textarea.scrollTop = Math.max(0, (linesBefore - 3) * lineHeight);
    }
  });

  // Copy button — copies full description/artifact to clipboard
  // Uses fallback for non-secure contexts (HTTP on LAN IP) where navigator.clipboard is unavailable
  $("#songCopyBtn").addEventListener("click", () => {
    const text = textarea.value;
    const showPopup = () => {
      const popup = $("#songCopyPopup");
      if (popup) { popup.classList.add("show"); setTimeout(() => popup.classList.remove("show"), 1800); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(showPopup).catch(() => {
        // Clipboard API rejected (non-secure context?) — use execCommand fallback
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.left = "-9999px";
        document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); showPopup(); } catch { toast("Failed to copy", "error"); }
        document.body.removeChild(ta);
      });
    } else {
      // No Clipboard API — use legacy execCommand fallback
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.left = "-9999px";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); showPopup(); } catch { toast("Failed to copy", "error"); }
      document.body.removeChild(ta);
    }
  });

  // Preview toggle
  let previewMode = false;
  $("#songPreviewToggle").addEventListener("click", () => {
    previewMode = !previewMode;
    const editorEl = $("#songLyricsEditor");
    const previewEl = $("#songLyricsPreview");
    if (previewMode) {
      previewEl.innerHTML = renderLyricsPreview(textarea.value);
      editorEl.style.display = "none";
      previewEl.style.display = "";
      $("#songPreviewToggle").textContent = "Edit";
    } else {
      editorEl.style.display = "";
      previewEl.style.display = "none";
      $("#songPreviewToggle").textContent = "Preview";
    }
  });

  // Version navigation — back/forward arrows
  $("#songVersionBack").addEventListener("click", () => {
    if (songVersionIndex === -1) {
      // Currently viewing current — go to newest version
      navigateSongVersion(spaceVersions.length - 1);
    } else if (songVersionIndex > 0) {
      navigateSongVersion(songVersionIndex - 1);
    }
  });

  $("#songVersionFwd").addEventListener("click", () => {
    if (songVersionIndex === -1) return; // already at current
    if (songVersionIndex >= spaceVersions.length - 1) {
      // At newest version — go to current
      navigateSongVersion(-1);
    } else {
      navigateSongVersion(songVersionIndex + 1);
    }
  });

  // Revert to currently viewed version
  const revertBtn = $("#songRevertBtn");
  revertBtn.addEventListener("click", async () => {
    if (songVersionIndex === -1) return;
    const ver = spaceVersions[songVersionIndex];
    if (!ver) return;
    if (!confirm(`Revert to version ${ver.version}? The current content will be saved as a new version.`)) return;
    try {
      await apiPost(`/items/${spaceItemId}/versions/revert`, {
        version_id: ver.id,
        actor: DEFAULT_AUTHOR,
      });
      // Update local state
      if (spaceItemData) spaceItemData.description = ver.description;
      textarea.value = ver.description;
      textarea.disabled = false;
      // Reload versions list
      try {
        spaceVersions = await apiGet(`/items/${spaceItemId}/versions`);
      } catch {}
      songVersionIndex = -1;
      updateSongVersionNav();
      toast("Reverted to version " + ver.version, "success");
    } catch (e) {
      toast("Failed to revert: " + (e.message || e), "error");
    }
  });

  // Comment submit (discussion)
  $("#songCommentSubmit").addEventListener("click", () => submitSongComment());
  $("#songCommentInput").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submitSongComment();
    }
  });

  // Cover image — click to upload
  const coverContainer = $("#songCoverContainer");
  const coverFileInput = $("#songCoverFileInput");
  coverContainer.addEventListener("click", () => coverFileInput.click());
  coverFileInput.addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) {
      uploadSongCover(e.target.files[0]);
    }
  });

  // Cover image — drag & drop
  coverContainer.addEventListener("dragover", (e) => {
    e.preventDefault();
    coverContainer.classList.add("drag-over");
  });
  coverContainer.addEventListener("dragleave", () => {
    coverContainer.classList.remove("drag-over");
  });
  coverContainer.addEventListener("drop", (e) => {
    e.preventDefault();
    coverContainer.classList.remove("drag-over");
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      if (file.type.startsWith("image/")) {
        uploadSongCover(file);
      } else {
        toast("Please drop an image file", "error");
      }
    }
  });

  // Cover image — paste (listen on the whole space overlay)
  const pasteHandler = (e) => {
    // Only handle paste when the song space is open and Details tab is active
    if (!spaceOverlay.classList.contains("open")) return;
    if (!$("#songPanelDetails") || !$("#songPanelDetails").classList.contains("active")) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) uploadSongCover(file);
        break;
      }
    }
  };
  document.addEventListener("paste", pasteHandler);
  // Store handler ref for cleanup
  spaceBody._songPasteHandler = pasteHandler;

  // Cover actions
  if ($("#songCoverChange")) {
    $("#songCoverChange").addEventListener("click", (e) => {
      e.stopPropagation();
      coverFileInput.click();
    });
  }
  if ($("#songCoverRemove")) {
    $("#songCoverRemove").addEventListener("click", (e) => {
      e.stopPropagation();
      removeSongCover();
    });
  }

  // Styles textarea — auto-save (debounced)
  const stylesTextarea = $("#songStylesTextarea");
  stylesTextarea.addEventListener("input", () => {
    const statusEl = $("#songStylesSaveStatus");
    if (statusEl) statusEl.textContent = "unsaved...";
    if (songStylesSaveTimer) clearTimeout(songStylesSaveTimer);
    songStylesSaveTimer = setTimeout(() => saveSongStyles(), 1500);
  });

  // Link field — event bindings
  $("#songLinkInput").addEventListener("input", () => {
    const val = $("#songLinkInput").value.trim();
    $("#songLinkClear").style.display = val ? "" : "none";
  });
  $("#songLinkClear").addEventListener("click", () => {
    $("#songLinkInput").value = "";
    $("#songLinkClear").style.display = "none";
    saveSongLink("");
  });
  $("#songLinkEditBtn").addEventListener("click", () => {
    $("#songLinkView").style.display = "none";
    $("#songLinkEdit").style.display = "";
    $("#songLinkInput").focus();
  });
  $("#songLinkInput").addEventListener("blur", () => {
    const val = $("#songLinkInput").value.trim();
    if (val) {
      populateSongLink(val);
    }
    saveSongLink(val);
  });
  // Enter key saves the link
  $("#songLinkInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("#songLinkInput").blur();
    }
  });
}

/** Populate the Song space link field (view/edit toggle like standard view). */
function populateSongLink(link) {
  const linkInput = $("#songLinkInput");
  const linkClear = $("#songLinkClear");
  const linkView = $("#songLinkView");
  const linkEdit = $("#songLinkEdit");
  const linkAnchor = $("#songLinkAnchor");
  if (!linkInput) return;

  linkInput.value = link || "";
  linkClear.style.display = link ? "" : "none";

  if (link) {
    linkAnchor.href = link;
    let displayText;
    try {
      const url = new URL(link);
      displayText = url.hostname + (url.pathname !== "/" ? url.pathname : "");
      if (displayText.length > 50) displayText = displayText.substring(0, 47) + "...";
    } catch {
      displayText = link;
    }
    linkAnchor.textContent = displayText;
    linkAnchor.title = link;
    linkView.style.display = "";
    linkEdit.style.display = "none";
  } else {
    linkView.style.display = "none";
    linkEdit.style.display = "";
  }
}

/** Save the link field value for the current song item. */
async function saveSongLink(val) {
  if (!spaceItemId) return;
  try {
    await apiPatch(`/items/${spaceItemId}`, {
      link: val || null,
      actor: DEFAULT_AUTHOR,
    });
    if (spaceItemData) spaceItemData.link = val || null;
    loadTracker();
  } catch (e) {
    toast("Failed to save link: " + e.message, "error");
  }
}

/** Load attachments and populate cover image + styles from them. */
async function loadSongAttachments() {
  if (!spaceItemId) return;
  try {
    songAttachmentsCache = await apiGet(`/items/${spaceItemId}/attachments`);
    // Look for cover image
    const coverAtt = songAttachmentsCache.find(a =>
      /^cover\.(png|jpg|jpeg|webp)$/i.test(a.filename)
    );
    if (coverAtt) {
      const coverImg = $("#songCoverImg");
      const coverContainer = $("#songCoverContainer");
      const coverActions = $("#songCoverActions");
      if (coverImg && coverContainer) {
        coverImg.src = `/api/v1/attachments/${coverAtt.id}`;
        coverContainer.classList.add("has-cover");
        if (coverActions) coverActions.style.display = "";
      }
    }
    // Look for styles.md
    const stylesAtt = songAttachmentsCache.find(a => a.filename === "styles.md");
    if (stylesAtt) {
      try {
        const resp = await fetch(`/api/v1/attachments/${stylesAtt.id}`);
        const stylesText = await resp.text();
        const stylesTextarea = $("#songStylesTextarea");
        if (stylesTextarea) stylesTextarea.value = stylesText;
      } catch { /* ignore */ }
    }
  } catch { songAttachmentsCache = []; }
}

/** Upload a cover image file for the song. */
async function uploadSongCover(file) {
  if (!spaceItemId) return;
  try {
    // Determine filename based on type
    const ext = file.type === "image/png" ? "png" : (file.type === "image/webp" ? "webp" : "jpg");
    const filename = `cover.${ext}`;

    // Delete any existing cover attachment first
    for (const att of songAttachmentsCache) {
      if (/^cover\.(png|jpg|jpeg|webp)$/i.test(att.filename)) {
        try { await apiDelete(`/attachments/${att.id}`); } catch { /* ignore */ }
      }
    }

    // Upload using multipart/form-data
    const formData = new FormData();
    formData.append("file", file, filename);
    formData.append("uploaded_by", DEFAULT_AUTHOR);

    const resp = await fetch(`/api/v1/items/${spaceItemId}/attachments`, {
      method: "POST",
      headers: authToken ? { "Authorization": `Bearer ${authToken}` } : {},
      body: formData,
    });
    if (!resp.ok) throw new Error("Upload failed");
    const att = await resp.json();

    // Update cache
    songAttachmentsCache = songAttachmentsCache.filter(a => !/^cover\.(png|jpg|jpeg|webp)$/i.test(a.filename));
    songAttachmentsCache.push(att);

    // Update UI
    const coverImg = $("#songCoverImg");
    const coverContainer = $("#songCoverContainer");
    const coverActions = $("#songCoverActions");
    if (coverImg && coverContainer) {
      coverImg.src = `/api/v1/attachments/${att.id}`;
      coverContainer.classList.add("has-cover");
      if (coverActions) coverActions.style.display = "";
    }
    toast("Cover image uploaded", "success");
  } catch (e) {
    toast("Failed to upload cover: " + e.message, "error");
  }
}

/** Remove the cover image. */
async function removeSongCover() {
  if (!spaceItemId) return;
  try {
    for (const att of songAttachmentsCache) {
      if (/^cover\.(png|jpg|jpeg|webp)$/i.test(att.filename)) {
        await apiDelete(`/attachments/${att.id}`);
      }
    }
    songAttachmentsCache = songAttachmentsCache.filter(a => !/^cover\.(png|jpg|jpeg|webp)$/i.test(a.filename));
    const coverImg = $("#songCoverImg");
    const coverContainer = $("#songCoverContainer");
    const coverActions = $("#songCoverActions");
    if (coverImg) coverImg.src = "";
    if (coverContainer) coverContainer.classList.remove("has-cover");
    if (coverActions) coverActions.style.display = "none";
    toast("Cover image removed");
  } catch (e) {
    toast("Failed to remove cover: " + e.message, "error");
  }
}

/** Save the styles description as a styles.md attachment. */
async function saveSongStyles() {
  if (!spaceItemId) return;
  const stylesTextarea = $("#songStylesTextarea");
  if (!stylesTextarea) return;
  const content = stylesTextarea.value;
  const statusEl = $("#songStylesSaveStatus");

  try {
    if (statusEl) { statusEl.textContent = "saving..."; statusEl.style.color = "var(--highlight)"; }

    // Delete existing styles.md
    for (const att of songAttachmentsCache) {
      if (att.filename === "styles.md") {
        try { await apiDelete(`/attachments/${att.id}`); } catch { /* ignore */ }
      }
    }

    // Upload new styles.md as JSON (base64)
    const b64 = btoa(unescape(encodeURIComponent(content)));
    const att = await apiPost(`/items/${spaceItemId}/attachments`, {
      filename: "styles.md",
      data: b64,
      mime_type: "text/markdown",
      uploaded_by: DEFAULT_AUTHOR,
    });

    // Update cache
    songAttachmentsCache = songAttachmentsCache.filter(a => a.filename !== "styles.md");
    songAttachmentsCache.push(att);

    if (statusEl) { statusEl.textContent = "saved"; statusEl.style.color = "#00b894"; }
    setTimeout(() => { if (statusEl && statusEl.textContent === "saved") statusEl.textContent = ""; }, 2000);
  } catch (e) {
    if (statusEl) { statusEl.textContent = "save failed"; statusEl.style.color = ""; }
    toast("Failed to save styles: " + e.message, "error");
  }
}

/** Render lyrics with syntax highlighting for section markers, stage directions, and CriticMarkup comments. */
function renderLyricsPreview(text) {
  const sectionTags = ["verse", "chorus", "bridge", "intro", "outro", "silence", "solo", "drop", "pre-chorus", "hook", "interlude"];
  const lines = text.split("\n");
  let html = "";
  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[([\w\s-]+)\]\s*$/);
    if (sectionMatch) {
      const tag = sectionMatch[1].trim().toLowerCase();
      const isSection = sectionTags.some(s => tag.startsWith(s));
      if (isSection) {
        html += `<div><span class="lyric-section-tag">${esc(sectionMatch[1].trim())}</span></div>`;
        continue;
      }
    }
    const stageMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (stageMatch && !line.match(/^\s*\[(verse|chorus|bridge|intro|outro|silence|solo|drop|pre-chorus|hook|interlude)/i)) {
      html += `<div><span class="lyric-stage-direction">[${esc(stageMatch[1])}]</span></div>`;
      continue;
    }
    // Render CriticMarkup inline comments within the line
    let rendered = esc(line);
    // CriticMarkup: highlight+comment combo {== text ==}{>> note <<}
    rendered = rendered.replace(
      /\{==(.+?)==\}\{&gt;&gt;(.+?)&lt;&lt;\}/g,
      (_, text, note) => `<mark class="critic-highlight">${text.trim()}</mark><span class="critic-comment-badge" tabindex="0">💬<span class="critic-comment-popover">${note.trim()}</span></span>`
    );
    // CriticMarkup: standalone comment {>> note <<}
    rendered = rendered.replace(
      /\{&gt;&gt;(.+?)&lt;&lt;\}/g,
      (_, note) => `<span class="critic-comment-badge" tabindex="0">💬<span class="critic-comment-popover">${note.trim()}</span></span>`
    );
    html += `<div>${line.trim() === "" ? "&nbsp;" : rendered}</div>`;
  }
  return html;
}

/** Render discussion thread (comments) in song space. */
function renderSongDiscussion(comments) {
  const thread = $("#songDiscussionThread");
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
    div.dataset.commentId = c.id;
    div.innerHTML = `
      <div class="text-comment-header">
        <span class="text-comment-author">${esc(c.author)}</span>
        <span class="text-comment-time">${formatTime(c.created_at)}</span>
      </div>
      <div class="text-comment-body">${renderMarkdown(c.body)}</div>
      ${renderReactionChips(c.id, c.reactions, "comment-reactions")}
    `;
    thread.appendChild(div);
  });
  bindReactionChips(thread);
  bindReactionTriggers(thread);
  thread.scrollTop = thread.scrollHeight;
}

/** Save song lyrics (auto-save or manual). */
async function saveSongLyrics(createVersion = false) {
  if (!spaceItemId) return;
  const textarea = $("#songLyricsTextarea");
  if (!textarea || textarea.disabled) return;
  const newDesc = textarea.value;
  const saveIndicator = $("#songSaveIndicator");

  try {
    saveIndicator.textContent = "Saving...";
    saveIndicator.className = "text-save-indicator saving";
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
      // Update version nav (back button may now be enabled)
      updateSongVersionNav();
      saveIndicator.textContent = `v${ver.version} saved`;
    } else {
      // Backend auto-creates versions on description change — refresh version list
      try {
        const prevCount = spaceVersions.length;
        spaceVersions = await apiGet(`/items/${spaceItemId}/versions`);
        if (spaceVersions.length > prevCount) {
          updateSongVersionNav();
        }
      } catch (e2) { /* version refresh is non-critical */ }
      saveIndicator.textContent = "Saved";
    }
    saveIndicator.className = "text-save-indicator saved";
    setTimeout(() => {
      if (saveIndicator.textContent === "Saved" || saveIndicator.textContent.startsWith("v")) {
        saveIndicator.textContent = "";
      }
    }, 3000);
  } catch (e) {
    saveIndicator.textContent = "Save failed!";
    saveIndicator.className = "text-save-indicator";
    toast("Failed to save lyrics: " + e.message, "error");
  }
}

/** Submit a comment in the song discussion. */
async function submitSongComment() {
  const input = $("#songCommentInput");
  if (!input) return;
  const body = input.value.trim();
  if (!body || !spaceItemId) return;
  const author = (() => {
    try { return localStorage.getItem(STORAGE_AUTHOR_KEY) || DEFAULT_AUTHOR; }
    catch { return DEFAULT_AUTHOR; }
  })();
  try {
    await apiPost(`/items/${spaceItemId}/comments`, {
      author,
      body,
    });
    input.value = "";
    const item = await apiGet(`/items/${spaceItemId}`);
    spaceItemData = item;
    renderSongDiscussion(item.comments || []);
    toast("Comment posted");
  } catch (e) {
    toast("Failed to post comment: " + e.message, "error");
  }
}


/** Update inline comment count display for song space. */
function updateSongCommentCount(text) {
  const el = $("#songCommentCount");
  if (!el) return;
  const matches = text.match(/\{>>.+?<<\}/g);
  const count = matches ? matches.length : 0;
  el.textContent = count > 0 ? `💬 ${count} comment${count !== 1 ? "s" : ""}` : "";
  el.title = count > 0 ? `${count} inline comment${count !== 1 ? "s" : ""} — click to scroll to first` : "";
}

registerSpacePlugin({
  name: "song",
  label: "Song",
  icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="18" r="3"/><circle cx="20" cy="16" r="3"/><path d="M11 18V5l9-2v13"/></svg>',
  description: "Songwriting workspace with lyrics editor and conversation",
  capabilities: { coverImage: true, versionHistory: true, liveRefresh: true },
  render: renderSpaceSong,
  refreshDiscussion: renderSongDiscussion,
  refreshDashboard: null,
  cleanup: () => {
    if (songStylesSaveTimer) { clearTimeout(songStylesSaveTimer); songStylesSaveTimer = null; }
    if (spaceBody._songPasteHandler) {
      document.removeEventListener("paste", spaceBody._songPasteHandler);
      spaceBody._songPasteHandler = null;
    }
    const commentToolbar = document.getElementById("inlineCommentToolbar");
    if (commentToolbar) commentToolbar.style.display = "none";
    const commentPopover = document.getElementById("inlineCommentPopover");
    if (commentPopover) commentPopover.style.display = "none";
  },
});
