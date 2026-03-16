// ── Space: Text ──
let textSaveTimer = null;

function renderSpaceText(item) {
  const description = item.description || "";

  spaceBody.innerHTML = `
    <div class="text-space" id="textSpace">
      <div class="text-main-pane">
        <div class="text-editor-toolbar">
          <div class="version-nav" id="textVersionNav">
            <button class="version-nav-btn" id="textVersionBack" title="Previous version" disabled>◀</button>
            <button class="version-nav-btn" id="textVersionFwd" title="Next version" disabled>▶</button>
            <span class="version-date" id="textVersionDate"></span>
          </div>
          <button class="space-btn text-revert-btn" id="textRevertBtn" title="Revert to this version" style="display:none;">Revert</button>
          <div class="toolbar-spacer"></div>
          <span class="text-word-count" id="textWordCount"></span>
          <span class="text-comment-count" id="textCommentCount" title="Inline comments"></span>
          <span class="copy-btn-wrap"><button class="space-btn" id="textCopyBtn" title="Copy text to clipboard">Copy</button><span class="copy-popup" id="textCopyPopup">Copied!</span></span>
          <button class="space-btn" id="textPreviewToggle" title="Toggle preview">Preview</button>
          <span class="text-save-indicator" id="textSaveIndicator"></span>
        </div>
        <div class="text-editor-area" id="textEditorArea">
          <textarea id="textEditorTextarea" placeholder="Start writing...&#10;&#10;Use Markdown for formatting:&#10;# Heading&#10;**bold**, *italic*&#10;- bullet points&#10;> blockquotes">${esc(description)}</textarea>
        </div>
        <div class="text-preview-area" id="textPreviewArea" style="display:none;"></div>
      </div>
      <div class="text-sidebar">
        <div class="text-sidebar-tabs">
          <button class="text-sidebar-tab active" data-panel="discussion">Discussion</button>
        </div>
        <!-- Discussion Panel (comments) -->
        <div class="text-sidebar-panel active" id="textPanelDiscussion">
          <div class="text-discussion">
            <div class="text-discussion-thread" id="textDiscussionThread"></div>
            <div class="text-discussion-input">
              <textarea id="textCommentInput" placeholder="Add a comment..." rows="2"></textarea>
              <button id="textCommentSubmit">Send</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Initialize version navigation (functions are hoisted to outer scope)
  textVersionIndex = -1;
  updateTextVersionNav();

  // Populate discussion thread
  renderTextDiscussion(item.comments || []);

  // Update word count and comment count
  updateTextWordCount(description);
  updateTextCommentCount(description);

  // ── Sidebar tab switching ──
  $$("#textSpace .text-sidebar-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const panel = tab.dataset.panel;
      $$("#textSpace .text-sidebar-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      $$("#textSpace .text-sidebar-panel").forEach(p => p.classList.remove("active"));
      const targetPanel = $(`#textPanel${panel.charAt(0).toUpperCase() + panel.slice(1)}`);
      if (targetPanel) targetPanel.classList.add("active");
    });
  });

  // ── Event bindings ──
  const textarea = $("#textEditorTextarea");
  const saveIndicator = $("#textSaveIndicator");

  // Auto-save (debounced)
  textarea.addEventListener("input", () => {
    saveIndicator.textContent = "Unsaved changes...";
    saveIndicator.className = "text-save-indicator";
    updateTextWordCount(textarea.value);
    updateTextCommentCount(textarea.value);
    if (textSaveTimer) clearTimeout(textSaveTimer);
    textSaveTimer = setTimeout(() => saveTextContent(), 2000);
  });

  // Cmd+S / Ctrl+S — manual save + version snapshot
  // Cmd+Shift+M — add inline comment at selection
  textarea.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      saveTextContent(true);
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "m" || e.key === "M")) {
      e.preventDefault();
      showTextCommentInput(textarea);
    }
  });

  // Selection-based inline comment toolbar
  textarea.addEventListener("mouseup", () => {
    setTimeout(() => showTextCommentToolbar(textarea), 10);
  });
  textarea.addEventListener("keyup", (e) => {
    if (e.shiftKey || e.key === "Shift") {
      setTimeout(() => showTextCommentToolbar(textarea), 10);
    }
  });

  // Comment count — click to scroll to first comment in textarea
  $("#textCommentCount").addEventListener("click", () => {
    const match = textarea.value.match(/\{>>/);
    if (match) {
      textarea.focus();
      textarea.selectionStart = match.index;
      textarea.selectionEnd = match.index;
      // Scroll the textarea to bring the comment into view
      const linesBefore = textarea.value.substring(0, match.index).split("\n").length;
      const lineHeight = parseFloat(window.getComputedStyle(textarea).lineHeight) || 24;
      textarea.scrollTop = Math.max(0, (linesBefore - 3) * lineHeight);
    }
  });

  // Copy button — copies full description/artifact to clipboard
  // Uses fallback for non-secure contexts (HTTP on LAN IP) where navigator.clipboard is unavailable
  $("#textCopyBtn").addEventListener("click", () => {
    const text = textarea.value;
    const showPopup = () => {
      const popup = $("#textCopyPopup");
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
  let textPreviewMode = false;
  $("#textPreviewToggle").addEventListener("click", () => {
    textPreviewMode = !textPreviewMode;
    const editorEl = $("#textEditorArea");
    const previewEl = $("#textPreviewArea");
    if (textPreviewMode) {
      previewEl.innerHTML = renderMarkdown(textarea.value);
      editorEl.style.display = "none";
      previewEl.style.display = "";
      $("#textPreviewToggle").textContent = "Edit";
    } else {
      editorEl.style.display = "";
      previewEl.style.display = "none";
      $("#textPreviewToggle").textContent = "Preview";
    }
  });

  // Version navigation — back/forward arrows
  $("#textVersionBack").addEventListener("click", () => {
    if (textVersionIndex === -1) {
      navigateTextVersion(spaceVersions.length - 1);
    } else if (textVersionIndex > 0) {
      navigateTextVersion(textVersionIndex - 1);
    }
  });

  $("#textVersionFwd").addEventListener("click", () => {
    if (textVersionIndex === -1) return;
    if (textVersionIndex >= spaceVersions.length - 1) {
      navigateTextVersion(-1);
    } else {
      navigateTextVersion(textVersionIndex + 1);
    }
  });

  // Revert to currently viewed version
  const textRevertBtn = $("#textRevertBtn");
  textRevertBtn.addEventListener("click", async () => {
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
      textarea.value = ver.description;
      textarea.disabled = false;
      updateTextWordCount(ver.description);
      try {
        spaceVersions = await apiGet(`/items/${spaceItemId}/versions`);
      } catch {}
      textVersionIndex = -1;
      updateTextVersionNav();
      toast("Reverted to version " + ver.version, "success");
    } catch (e) {
      toast("Failed to revert: " + (e.message || e), "error");
    }
  });

  // Comment submit (discussion)
  $("#textCommentSubmit").addEventListener("click", () => submitTextComment());
  $("#textCommentInput").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submitTextComment();
    }
  });

}

/** Update word count display for text space (excludes CriticMarkup annotations). */
function updateTextWordCount(text) {
  const el = $("#textWordCount");
  if (!el) return;
  // Strip CriticMarkup annotations before counting words
  const clean = text
    .replace(/\{==(.+?)==\}\{>>(.+?)<<\}/g, "$1") // highlight+comment → just the highlighted text
    .replace(/\{>>(.+?)<<\}/g, "");                // standalone comments → remove
  const words = clean.trim() ? clean.trim().split(/\s+/).length : 0;
  el.textContent = `${words} word${words !== 1 ? "s" : ""}`;
}

/** Update inline comment count display for text space. */
function updateTextCommentCount(text) {
  const el = $("#textCommentCount");
  if (!el) return;
  const matches = text.match(/\{>>.+?<<\}/g);
  const count = matches ? matches.length : 0;
  el.textContent = count > 0 ? `💬 ${count} comment${count !== 1 ? "s" : ""}` : "";
  el.title = count > 0 ? `${count} inline comment${count !== 1 ? "s" : ""} — click to scroll to first` : "";
}

// ── Inline Comments (CriticMarkup) ──

/** Show the floating comment toolbar when text is selected in the textarea. */
function showTextCommentToolbar(textarea) {
  hideTextCommentToolbar();
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  if (start === end) return; // No selection
  if (textarea.disabled) return;

  // Get or create toolbar element
  let toolbar = document.getElementById("textCommentToolbar");
  if (!toolbar) {
    toolbar = document.createElement("div");
    toolbar.id = "textCommentToolbar";
    toolbar.className = "text-comment-toolbar";
    toolbar.innerHTML = '<span class="text-comment-toolbar-icon">💬</span><span class="text-comment-toolbar-label">Comment</span>';
    document.body.appendChild(toolbar);
    toolbar.addEventListener("click", () => {
      hideTextCommentToolbar();
      showTextCommentInput(textarea);
    });
  }

  // Position near the selection using textarea caret coordinates
  const pos = getTextareaSelectionCoords(textarea);
  toolbar.style.left = pos.x + "px";
  toolbar.style.top = (pos.y - 36) + "px";
  toolbar.style.display = "flex";
}

/** Hide the floating comment toolbar. */
function hideTextCommentToolbar() {
  const toolbar = document.getElementById("textCommentToolbar");
  if (toolbar) toolbar.style.display = "none";
}

/** Show the comment input popover for adding an inline comment. */
function showTextCommentInput(textarea) {
  hideTextCommentToolbar();
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  if (textarea.disabled) return;

  // Store selection for when the popover submits
  const selStart = start;
  const selEnd = end;
  const hasSelection = selStart !== selEnd;

  // Get or create input popover
  let popover = document.getElementById("textCommentInputPopover");
  if (!popover) {
    popover = document.createElement("div");
    popover.id = "textCommentInputPopover";
    popover.className = "text-comment-input-popover";
    popover.innerHTML = `
      <textarea id="textCommentNoteInput" placeholder="Add your comment..." rows="2"></textarea>
      <div class="text-comment-input-actions">
        <button class="comment-cancel-btn" id="textCommentCancelBtn">Cancel</button>
        <button class="comment-add-btn" id="textCommentAddBtn">Add Comment</button>
      </div>
    `;
    document.body.appendChild(popover);
  }

  // Position near the selection
  const pos = getTextareaSelectionCoords(textarea);
  popover.style.left = Math.max(10, Math.min(pos.x - 60, window.innerWidth - 380)) + "px";
  popover.style.top = (pos.y - 100) + "px";
  popover.style.display = "flex";

  const noteInput = document.getElementById("textCommentNoteInput");
  noteInput.value = "";
  noteInput.focus();

  // Remove old listeners by replacing elements
  const addBtn = document.getElementById("textCommentAddBtn");
  const cancelBtn = document.getElementById("textCommentCancelBtn");
  const newAddBtn = addBtn.cloneNode(true);
  const newCancelBtn = cancelBtn.cloneNode(true);
  addBtn.replaceWith(newAddBtn);
  cancelBtn.replaceWith(newCancelBtn);

  const submit = () => {
    const note = noteInput.value.trim();
    if (!note) return;
    insertCriticComment(textarea, selStart, selEnd, note);
    popover.style.display = "none";
  };

  newAddBtn.addEventListener("click", submit);
  newCancelBtn.addEventListener("click", () => { popover.style.display = "none"; });
  noteInput.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      popover.style.display = "none";
      textarea.focus();
    }
  });
}

/** Insert a CriticMarkup comment into the textarea at the given selection range. */
function insertCriticComment(textarea, selStart, selEnd, note) {
  const text = textarea.value;
  const hasSelection = selStart !== selEnd;
  let newText;
  let cursorPos;

  if (hasSelection) {
    // Wrap selection: {== selected text ==}{>> note <<}
    const selected = text.slice(selStart, selEnd);
    const insertion = `{==${selected}==}{>> ${note} <<}`;
    newText = text.slice(0, selStart) + insertion + text.slice(selEnd);
    cursorPos = selStart + insertion.length;
  } else {
    // No selection: insert standalone {>> note <<} at cursor
    const insertion = `{>> ${note} <<}`;
    newText = text.slice(0, selStart) + insertion + text.slice(selStart);
    cursorPos = selStart + insertion.length;
  }

  textarea.value = newText;
  textarea.selectionStart = cursorPos;
  textarea.selectionEnd = cursorPos;
  textarea.focus();

  // Trigger input event for auto-save and count updates
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Get approximate screen coordinates for a textarea selection (for positioning popovers). */
function getTextareaSelectionCoords(textarea) {
  // Create a mirror div to measure the position
  const mirror = document.createElement("div");
  const style = window.getComputedStyle(textarea);
  // Copy relevant styles
  for (const prop of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
    "wordSpacing", "textIndent", "whiteSpace", "wordWrap", "overflowWrap",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"]) {
    mirror.style[prop] = style[prop];
  }
  mirror.style.position = "absolute";
  mirror.style.left = "-9999px";
  mirror.style.top = "-9999px";
  mirror.style.width = textarea.clientWidth + "px";
  mirror.style.overflow = "hidden";
  mirror.style.visibility = "hidden";

  // Text up to the selection start
  const textBefore = textarea.value.substring(0, textarea.selectionStart);
  const textNode = document.createTextNode(textBefore);
  mirror.appendChild(textNode);

  // Marker span at the selection position
  const marker = document.createElement("span");
  marker.textContent = "|";
  mirror.appendChild(marker);

  document.body.appendChild(mirror);
  const mirrorRect = mirror.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  document.body.removeChild(mirror);

  // Now offset relative to the textarea position
  const taRect = textarea.getBoundingClientRect();
  const scrollTop = textarea.scrollTop;
  const scrollLeft = textarea.scrollLeft;

  return {
    x: taRect.left + (markerRect.left - mirrorRect.left) - scrollLeft,
    y: taRect.top + (markerRect.top - mirrorRect.top) - scrollTop,
  };
}

/** Hide all comment popovers when clicking outside */
document.addEventListener("mousedown", (e) => {
  const toolbar = document.getElementById("textCommentToolbar");
  const popover = document.getElementById("textCommentInputPopover");
  if (toolbar && toolbar.style.display !== "none" && !toolbar.contains(e.target)) {
    const textarea = document.getElementById("textEditorTextarea");
    if (!textarea || !textarea.contains(e.target)) {
      hideTextCommentToolbar();
    }
  }
  if (popover && popover.style.display !== "none" && !popover.contains(e.target)) {
    popover.style.display = "none";
  }
});

/** Render discussion thread (comments) in text space. */
function renderTextDiscussion(comments) {
  const thread = $("#textDiscussionThread");
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

/** Save text content (auto-save or manual). */
async function saveTextContent(createVersion = false) {
  if (!spaceItemId) return;
  const textarea = $("#textEditorTextarea");
  if (!textarea || textarea.disabled) return;
  const newDesc = textarea.value;
  const saveIndicator = $("#textSaveIndicator");

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
      updateTextVersionNav();
      saveIndicator.textContent = `v${ver.version} saved`;
    } else {
      // Backend auto-creates versions on description change — refresh version list
      try {
        const prevCount = spaceVersions.length;
        spaceVersions = await apiGet(`/items/${spaceItemId}/versions`);
        if (spaceVersions.length > prevCount) {
          updateTextVersionNav();
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
    toast("Failed to save: " + e.message, "error");
  }
}

/** Submit a comment in the text discussion. */
async function submitTextComment() {
  const input = $("#textCommentInput");
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
    renderTextDiscussion(item.comments || []);
    toast("Comment posted");
  } catch (e) {
    toast("Failed to post comment: " + e.message, "error");
  }
}


registerSpacePlugin({
  name: "text",
  label: "Text",
  icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 10h16M4 14h10M4 18h12"/></svg>',
  description: "Writing workspace for articles, blogs, and long-form text",
  capabilities: { versionHistory: true, liveRefresh: true },
  render: renderSpaceText,
  refreshDiscussion: renderTextDiscussion,
  refreshDashboard: null,
  cleanup: () => {
    if (textSaveTimer) { clearTimeout(textSaveTimer); textSaveTimer = null; }
    const commentToolbar = document.getElementById("textCommentToolbar");
    if (commentToolbar) commentToolbar.style.display = "none";
    const commentPopover = document.getElementById("textCommentInputPopover");
    if (commentPopover) commentPopover.style.display = "none";
  },
});
