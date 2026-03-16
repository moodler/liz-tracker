// ── Space: Scheduled ──
let scheduledSaveTimer = null;

/** Parse space_data JSON for scheduled items, returning a default structure if empty/invalid. */
function parseScheduledData(item) {
  const defaults = {
    schedule: {
      frequency: "daily",
      time: "07:00",
      days_of_week: null,
      timezone: "Australia/Perth",
      cron_override: null,
    },
    status: {
      next_run: null,
      last_run: null,
      last_status: null,
      last_duration_ms: null,
      run_count: 0,
    },
    todo: [],
    ignore: [],
  };
  // Coerce array items to plain strings — prevents [object Object] when agents
  // accidentally pass objects instead of strings in todo/ignore arrays
  const coerceStrings = (arr) => arr.map(v => {
    if (typeof v === "string") return v;
    if (v && typeof v === "object") return String(v.text || v.title || v.name || v.content || v.description || v.value || JSON.stringify(v));
    return String(v);
  });
  if (!item.space_data) return defaults;
  try {
    const parsed = typeof item.space_data === "string" ? JSON.parse(item.space_data) : item.space_data;
    // Handle legacy format: { schedule: "cron_expr", last_run, next_run }
    if (typeof parsed.schedule === "string") {
      return {
        schedule: {
          ...defaults.schedule,
          frequency: "custom",
          cron_override: parsed.schedule,
        },
        status: {
          next_run: parsed.next_run || null,
          last_run: parsed.last_run || null,
          last_status: parsed.last_status || null,
          last_duration_ms: parsed.last_duration_ms || null,
          run_count: parsed.run_count || 0,
        },
        todo: Array.isArray(parsed.todo) ? coerceStrings(parsed.todo) : [],
        ignore: Array.isArray(parsed.ignore) ? coerceStrings(parsed.ignore) : [],
      };
    }
    return {
      schedule: { ...defaults.schedule, ...(parsed.schedule || {}) },
      status: { ...defaults.status, ...(parsed.status || {}) },
      todo: Array.isArray(parsed.todo) ? coerceStrings(parsed.todo) : [],
      ignore: Array.isArray(parsed.ignore) ? coerceStrings(parsed.ignore) : [],
    };
  } catch { return defaults; }
}

/** Convert schedule config to a human-readable summary. */
function describeSchedule(sched) {
  const freq = sched.frequency;
  const time = sched.time || "—";
  const tz = sched.timezone || "Australia/Perth";
  const tzShort = tz === "Australia/Perth" ? "AWST" : tz;

  if (freq === "manual") return { title: "Manual", detail: "Triggered externally — no automatic timer" };
  if (freq === "custom" && sched.cron_override) return { title: "Custom (cron)", detail: sched.cron_override };
  if (freq === "once") return { title: "Once", detail: `at ${time} ${tzShort}` };
  if (freq === "hourly") return { title: "Hourly", detail: `${tzShort}` };
  if (freq === "daily") return { title: "Daily", detail: `at ${time} ${tzShort}` };
  if (freq === "weekly") {
    const days = sched.days_of_week;
    const dayNames = days && days.length ? days.map(d => d.charAt(0).toUpperCase() + d.slice(1, 3)).join(", ") : "—";
    return { title: "Weekly", detail: `${dayNames} at ${time} ${tzShort}` };
  }
  if (freq === "monthly") return { title: "Monthly", detail: `at ${time} ${tzShort}` };
  return { title: freq, detail: "" };
}

/** Format a date/time for display in AWST. */
function formatScheduledTime(isoStr) {
  if (!isoStr) return "—";
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return "—";
    const opts = { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Australia/Perth" };
    return d.toLocaleString("en-AU", opts);
  } catch { return "—"; }
}

/** Format duration in ms to human-readable string. */
function formatDuration(ms) {
  if (ms == null || isNaN(ms)) return "—";
  if (ms < 1000) return ms + "ms";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return secs + "s";
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return mins + "m " + remSecs + "s";
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return hrs + "h " + remMins + "m";
}

/** Get effective cron expression from schedule config. */
function getEffectiveCron(sched) {
  if (sched.cron_override) return sched.cron_override;
  const [hour, minute] = (sched.time || "00:00").split(":").map(Number);
  const freq = sched.frequency;
  if (freq === "hourly") return `0 * * * *`;
  if (freq === "daily") return `${minute} ${hour} * * *`;
  if (freq === "weekly" && sched.days_of_week && sched.days_of_week.length) {
    const dayMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    const dayNums = sched.days_of_week.map(d => dayMap[d.toLowerCase()]).filter(n => n !== undefined);
    return `${minute} ${hour} * * ${dayNums.join(",")}`;
  }
  if (freq === "monthly") return `${minute} ${hour} 1 * *`;
  if (freq === "once") return null;
  if (freq === "manual") return null;
  return null;
}

/** Render a scheduled list section (TODO or IGNORE) as HTML. */
function renderScheduledListHtml(items, fieldName, icon, emptyText) {
  const listHtml = items.length
    ? items.map((text, i) => `
        <div class="scheduled-list-item" data-field="${fieldName}" data-index="${i}">
          <span class="scheduled-list-item-text">${esc(text)}</span>
          <span class="scheduled-list-item-actions">
            <button class="scheduled-list-edit-btn" title="Edit">&#x270E;</button>
            <button class="scheduled-list-delete-btn" title="Delete">&#x2715;</button>
          </span>
        </div>
      `).join("")
    : `<div class="scheduled-list-empty">${esc(emptyText)}</div>`;

  return `
    <div class="engagement-section">
      <div class="engagement-section-header">
        <span class="section-icon">${icon}</span>
        <span class="section-title">${fieldName === "todo" ? "TODO" : "IGNORE"}</span>
        <span class="section-toggle">&#x25BC;</span>
      </div>
      <div class="engagement-section-body">
        <div class="scheduled-list-items" id="scheduledList_${fieldName}">
          ${listHtml}
        </div>
        <div class="scheduled-list-add">
          <input type="text" id="scheduledListInput_${fieldName}" placeholder="Add ${fieldName === "todo" ? "a task" : "an ignore rule"}..." />
          <button id="scheduledListAdd_${fieldName}">Add</button>
        </div>
      </div>
    </div>
  `;
}

/** Bind event listeners for a scheduled list section (TODO or IGNORE). */
function bindScheduledListEvents(fieldName) {
  const addBtn = $(`#scheduledListAdd_${fieldName}`);
  const addInput = $(`#scheduledListInput_${fieldName}`);

  if (addBtn && addInput) {
    const doAdd = async () => {
      const text = addInput.value.trim();
      if (!text || !spaceItemId) return;
      const sd = parseScheduledData(spaceItemData);
      sd[fieldName].push(text);
      addInput.value = "";
      await saveScheduledSpaceData(sd);
    };
    addBtn.addEventListener("click", doAdd);
    addInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); doAdd(); }
    });
  }

  // Delegate edit/delete on list items
  const listContainer = $(`#scheduledList_${fieldName}`);
  if (listContainer) {
    listContainer.addEventListener("click", async (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const itemEl = btn.closest(".scheduled-list-item");
      if (!itemEl) return;
      const idx = parseInt(itemEl.dataset.index, 10);
      const sd = parseScheduledData(spaceItemData);

      if (btn.classList.contains("scheduled-list-delete-btn")) {
        sd[fieldName].splice(idx, 1);
        await saveScheduledSpaceData(sd);
      } else if (btn.classList.contains("scheduled-list-edit-btn")) {
        const textEl = itemEl.querySelector(".scheduled-list-item-text");
        const currentText = sd[fieldName][idx];
        const input = document.createElement("input");
        input.type = "text";
        input.className = "scheduled-list-edit-input";
        input.value = currentText;
        textEl.replaceWith(input);
        input.focus();
        input.select();

        const commitEdit = async () => {
          const newText = input.value.trim();
          if (newText && newText !== currentText) {
            const freshSd = parseScheduledData(spaceItemData);
            freshSd[fieldName][idx] = newText;
            await saveScheduledSpaceData(freshSd);
          } else {
            // Revert — just re-render
            refreshScheduledDashboard(spaceItemData);
          }
        };
        input.addEventListener("blur", commitEdit);
        input.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
          if (ev.key === "Escape") {
            input.removeEventListener("blur", commitEdit);
            refreshScheduledDashboard(spaceItemData);
          }
        });
      }
    });
  }
}

function renderSpaceScheduled(item) {
  const sd = parseScheduledData(item);
  const sched = sd.schedule;
  const status = sd.status;
  const schedDesc = describeSchedule(sched);
  const cronExpr = getEffectiveCron(sched);

  // Determine next run status
  let nextRunClass = "";
  if (status.next_run) {
    const nextDate = new Date(status.next_run);
    const now = new Date();
    if (nextDate < now) nextRunClass = "overdue";
    else if ((nextDate - now) < 3600000) nextRunClass = "soon";
  }

  // Status badge
  let lastStatusBadge = '<span class="scheduled-status-badge never">Never run</span>';
  if (status.last_status === "success") lastStatusBadge = '<span class="scheduled-status-badge success">Success</span>';
  else if (status.last_status === "error") lastStatusBadge = '<span class="scheduled-status-badge error">Error</span>';
  else if (status.last_status === "running") lastStatusBadge = '<span class="scheduled-status-badge running">Running</span>';

  spaceBody.innerHTML = `
    <div class="scheduled-space" id="scheduledSpace">
      <div class="scheduled-dashboard" id="scheduledDashboard">
        <div class="engagement-section">
          <div class="engagement-section-header">
            <span class="section-icon">&#x1F553;</span>
            <span class="section-title">Schedule</span>
            <button class="engagement-edit-btn" id="scheduledEditSchedule">Edit</button>
            <span class="section-toggle">&#x25BC;</span>
          </div>
          <div class="engagement-section-body" id="scheduledScheduleBody">
            <div class="scheduled-frequency-display">${esc(schedDesc.title)}</div>
            <div class="scheduled-frequency-detail">${esc(schedDesc.detail)}</div>
            ${cronExpr ? `<span class="scheduled-cron-raw">${esc(cronExpr)}</span>` : ""}
            ${sched.frequency === "weekly" && sched.days_of_week ? `
              <div class="scheduled-days-row">
                ${["monday","tuesday","wednesday","thursday","friday","saturday","sunday"].map(d =>
                  `<span class="scheduled-day-check ${sched.days_of_week.includes(d) ? "active" : ""}">
                    <input type="checkbox" disabled ${sched.days_of_week.includes(d) ? "checked" : ""}> ${d.charAt(0).toUpperCase() + d.slice(1, 3)}
                  </span>`
                ).join("")}
              </div>
            ` : ""}
          </div>
        </div>

        <div class="engagement-section">
          <div class="engagement-section-header">
            <span class="section-icon">&#x1F4CA;</span>
            <span class="section-title">Status</span>
            <span class="section-toggle">&#x25BC;</span>
          </div>
          <div class="engagement-section-body">
            <div class="scheduled-status-panel">
              <span class="status-label">Next run</span>
              <span class="status-value"><span class="scheduled-next-run ${nextRunClass}">${sched.frequency === "manual" ? "Manual trigger" : formatScheduledTime(status.next_run)}</span></span>

              <span class="status-label">Last run</span>
              <span class="status-value">${formatScheduledTime(status.last_run)}</span>

              <span class="status-label">Last status</span>
              <span class="status-value">${lastStatusBadge}${status.last_duration_ms != null ? ` <span style="font-size:0.8rem;color:var(--text-dim)">(took ${formatDuration(status.last_duration_ms)})</span>` : ""}</span>

              <span class="status-label">Run count</span>
              <span class="status-value"><span class="scheduled-run-count">${status.run_count || 0}</span></span>

              <span class="status-label">Expires</span>
              <span class="status-value">
                <div class="scheduled-due-date">
                  <input type="date" id="scheduledDueDate" value="${item.date_due || ""}" />
                  ${item.date_due ? '<button class="due-clear-btn" id="scheduledDueDateClear" title="Clear due date">&#x2715;</button>' : ""}
                  ${item.date_due && item.date_due < new Date().toISOString().slice(0, 10) ? '<span class="scheduled-due-date-expired">Expired</span>' : ""}
                </div>
              </span>
            </div>
          </div>
        </div>

        <div class="engagement-section">
          <div class="engagement-section-header">
            <span class="section-icon">&#x1F4DD;</span>
            <span class="section-title">Task Instructions</span>
            <span class="section-toggle">&#x25BC;</span>
          </div>
          <div class="engagement-section-body">
            <textarea id="scheduledDescTextarea" style="width:100%;min-height:120px;background:rgba(255,255,255,0.06);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);padding:8px;font-size:0.83rem;resize:vertical;outline:none;font-family:inherit;">${esc(item.description || "")}</textarea>
            <span class="engagement-save-indicator" id="scheduledDescSaveIndicator"></span>
          </div>
        </div>

        ${renderScheduledListHtml(sd.todo, "todo", "&#x2611;", "No tasks defined yet.")}
        ${renderScheduledListHtml(sd.ignore, "ignore", "&#x1F6AB;", "No ignore rules defined yet.")}
      </div>
      <div class="scheduled-sidebar">
        <div class="text-sidebar-tabs">
          <button class="text-sidebar-tab active" data-panel="discussion">Run History</button>
          <button class="text-sidebar-tab" data-panel="details">Details</button>
        </div>
        <div class="text-sidebar-panel active" id="scheduledPanelDiscussion">
          <div class="text-discussion">
            <div class="text-discussion-thread" id="scheduledDiscussionThread"></div>
            <div class="text-discussion-input">
              <textarea id="scheduledCommentInput" placeholder="Add a note..." rows="2"></textarea>
              <button id="scheduledCommentSubmit">Send</button>
            </div>
          </div>
        </div>
        <div class="text-sidebar-panel" id="scheduledPanelDetails">
          <div style="flex:1;overflow-y:auto;padding:14px;">
            <div class="engagement-edit-row">
              <label>Assignee</label>
              <span style="color:var(--text);font-size:0.85rem;">${esc(item.assignee || "Unassigned")}</span>
            </div>
            <div class="engagement-edit-row">
              <label>Priority</label>
              <span style="color:var(--text);font-size:0.85rem;">${esc(item.priority || "none")}</span>
            </div>
            <div class="engagement-edit-row">
              <label>Labels</label>
              <span style="color:var(--text);font-size:0.85rem;">${item.labels ? (typeof item.labels === "string" ? JSON.parse(item.labels) : item.labels).join(", ") : "—"}</span>
            </div>
            <div class="engagement-edit-row">
              <label>Timezone</label>
              <span style="color:var(--text);font-size:0.85rem;">${esc(sched.timezone || "Australia/Perth")}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Populate discussion (run history)
  renderScheduledDiscussion(item.comments || []);

  // Sidebar tab switching
  $$("#scheduledSpace .text-sidebar-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const panel = tab.dataset.panel;
      $$("#scheduledSpace .text-sidebar-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      $$("#scheduledSpace .text-sidebar-panel").forEach(p => p.classList.remove("active"));
      const targetPanel = $(`#scheduledPanel${panel.charAt(0).toUpperCase() + panel.slice(1)}`);
      if (targetPanel) targetPanel.classList.add("active");
    });
  });

  // Section collapse toggle
  $$("#scheduledDashboard .engagement-section-header").forEach(header => {
    header.addEventListener("click", (e) => {
      if (e.target.classList.contains("engagement-edit-btn")) return;
      header.parentElement.classList.toggle("collapsed");
    });
  });

  // Edit schedule button
  const editScheduleBtn = $("#scheduledEditSchedule");
  if (editScheduleBtn) {
    editScheduleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openScheduledEdit(sd);
    });
  }

  // Comment submit
  $("#scheduledCommentSubmit").addEventListener("click", () => submitScheduledComment());
  $("#scheduledCommentInput").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submitScheduledComment();
    }
  });

  // Description auto-save
  const descTextarea = $("#scheduledDescTextarea");
  if (descTextarea) {
    descTextarea.addEventListener("input", () => {
      const ind = $("#scheduledDescSaveIndicator");
      if (ind) { ind.textContent = "Unsaved..."; ind.className = "engagement-save-indicator"; }
      if (scheduledSaveTimer) clearTimeout(scheduledSaveTimer);
      scheduledSaveTimer = setTimeout(() => saveScheduledDescription(), 2000);
    });
  }

  // Due date editing
  const dueDateInput = $("#scheduledDueDate");
  if (dueDateInput) {
    dueDateInput.addEventListener("change", async () => {
      if (!spaceItemId) return;
      const val = dueDateInput.value || null;
      try {
        await apiPatch(`/items/${spaceItemId}`, { date_due: val || "" });
        const updated = await apiGet(`/items/${spaceItemId}`);
        spaceItemData = updated;
        refreshScheduledDashboard(updated);
        loadTracker();
        toast(val ? "Due date set" : "Due date cleared");
      } catch (e) {
        toast("Failed to save due date: " + e.message, "error");
      }
    });
  }
  const dueDateClear = $("#scheduledDueDateClear");
  if (dueDateClear) {
    dueDateClear.addEventListener("click", async () => {
      if (!spaceItemId) return;
      try {
        await apiPatch(`/items/${spaceItemId}`, { date_due: "" });
        const updated = await apiGet(`/items/${spaceItemId}`);
        spaceItemData = updated;
        refreshScheduledDashboard(updated);
        loadTracker();
        toast("Due date cleared");
      } catch (e) {
        toast("Failed to clear due date: " + e.message, "error");
      }
    });
  }

  // Bind TODO and IGNORE list events
  bindScheduledListEvents("todo");
  bindScheduledListEvents("ignore");
}

/** Render discussion/run history thread. */
function renderScheduledDiscussion(comments) {
  const thread = $("#scheduledDiscussionThread");
  if (!thread) return;
  thread.innerHTML = "";
  if (!comments || !comments.length) {
    thread.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:40px 20px;font-size:0.85rem;">No run history yet.</div>';
    return;
  }
  comments.forEach(c => {
    const div = document.createElement("div");
    div.className = "text-comment";
    div.dataset.author = c.author || "System";
    div.innerHTML = `
      <div class="text-comment-header">
        <span class="text-comment-author">${esc(c.author || "System")}</span>
        <span class="text-comment-time">${formatTime(c.created_at)}</span>
      </div>
      <div class="text-comment-body">${renderMarkdown(c.body || "")}</div>
    `;
    thread.appendChild(div);
  });
  thread.scrollTop = thread.scrollHeight;
}

/** Submit a comment on a scheduled item. */
async function submitScheduledComment() {
  const input = $("#scheduledCommentInput");
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
    renderScheduledDiscussion(item.comments || []);
    toast("Comment posted");
  } catch (e) {
    toast("Failed to post comment: " + e.message, "error");
  }
}

/** Save description for a scheduled item (debounced). */
async function saveScheduledDescription() {
  scheduledSaveTimer = null;
  const descTextarea = $("#scheduledDescTextarea");
  const ind = $("#scheduledDescSaveIndicator");
  if (!descTextarea || !spaceItemId) return;
  try {
    if (ind) { ind.textContent = "Saving..."; ind.className = "engagement-save-indicator saving"; }
    await apiPatch(`/items/${spaceItemId}`, { description: descTextarea.value });
    if (ind) { ind.textContent = "Saved"; ind.className = "engagement-save-indicator saved"; }
    setTimeout(() => { if (ind) ind.textContent = ""; }, 2000);
    loadTracker();
  } catch (e) {
    if (ind) { ind.textContent = "Save failed"; ind.className = "engagement-save-indicator"; }
    toast("Failed to save description: " + e.message, "error");
  }
}

/** Save schedule space_data. */
async function saveScheduledSpaceData(newData) {
  if (!spaceItemId) return;
  try {
    await apiPatch(`/items/${spaceItemId}`, { space_data: JSON.stringify(newData) });
    const item = await apiGet(`/items/${spaceItemId}`);
    spaceItemData = item;
    refreshScheduledDashboard(item);
    loadTracker();
  } catch (e) {
    toast("Failed to save schedule: " + e.message, "error");
  }
}

/** Open inline edit form for schedule configuration. */
function openScheduledEdit(sd) {
  const body = $("#scheduledScheduleBody");
  if (!body) return;
  const sched = sd.schedule;
  const allDays = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
  const selectedDays = sched.days_of_week || [];
  const hasCronOverride = !!sched.cron_override;

  body.innerHTML = `
    <div class="scheduled-edit-form">
      <div class="scheduled-mode-toggle">
        <span class="scheduled-mode-toggle-label">Form</span>
        <div class="scheduled-mode-toggle-switch ${hasCronOverride ? "active" : ""}" id="schedEditModeToggle"></div>
        <span class="scheduled-mode-toggle-label">Cron</span>
      </div>
      <div id="schedEditFormFields" style="display:${hasCronOverride ? "none" : "block"}">
        <div>
          <label>Frequency</label>
          <select id="schedEditFrequency">
            <option value="once" ${sched.frequency === "once" ? "selected" : ""}>Once</option>
            <option value="hourly" ${sched.frequency === "hourly" ? "selected" : ""}>Hourly</option>
            <option value="daily" ${sched.frequency === "daily" ? "selected" : ""}>Daily</option>
            <option value="weekly" ${sched.frequency === "weekly" ? "selected" : ""}>Weekly</option>
            <option value="monthly" ${sched.frequency === "monthly" ? "selected" : ""}>Monthly</option>
            <option value="manual" ${sched.frequency === "manual" ? "selected" : ""}>Manual</option>
          </select>
        </div>
        <div id="schedEditTimeRow">
          <label>Time</label>
          <input type="time" id="schedEditTime" value="${sched.time || "07:00"}" />
        </div>
        <div id="schedEditDaysRow" style="display:${sched.frequency === "weekly" ? "block" : "none"}">
          <label>Days of week</label>
          <div class="scheduled-days-row">
            ${allDays.map(d => `
              <label class="scheduled-day-check">
                <input type="checkbox" value="${d}" ${selectedDays.includes(d) ? "checked" : ""}> ${d.charAt(0).toUpperCase() + d.slice(1, 3)}
              </label>
            `).join("")}
          </div>
        </div>
      </div>
      <div id="schedEditCronFields" style="display:${hasCronOverride ? "block" : "none"}">
        <div>
          <label>Cron expression</label>
          <input type="text" id="schedEditCron" value="${esc(sched.cron_override || "")}" placeholder="0 4 1-3 * *" />
          <div class="scheduled-cron-input-help">
            Format: <code>min hour day month weekday</code><br>
            Examples: <code>0 4 1-3 * *</code> &nbsp; <code>*/30 * * * *</code> &nbsp; <code>0 9 * * 1-5</code>
          </div>
        </div>
      </div>
      <div id="schedEditTimezoneRow">
        <label>Timezone</label>
        <input type="text" id="schedEditTimezone" value="${esc(sched.timezone || "Australia/Perth")}" />
      </div>
      <div class="scheduled-edit-actions">
        <button class="save-btn" id="schedEditSave">Save</button>
        <button class="cancel-btn" id="schedEditCancel">Cancel</button>
      </div>
    </div>
  `;

  let cronMode = hasCronOverride;
  const modeToggle = $("#schedEditModeToggle");
  const formFields = $("#schedEditFormFields");
  const cronFields = $("#schedEditCronFields");

  // Toggle between form and cron mode
  modeToggle.addEventListener("click", () => {
    cronMode = !cronMode;
    modeToggle.classList.toggle("active", cronMode);
    formFields.style.display = cronMode ? "none" : "block";
    cronFields.style.display = cronMode ? "block" : "none";
    // When switching to cron mode, pre-fill with effective cron from form fields
    if (cronMode) {
      const cronInput = $("#schedEditCron");
      if (!cronInput.value) {
        const f = $("#schedEditFrequency").value;
        const t = $("#schedEditTime").value || "07:00";
        const [h, m] = t.split(":").map(Number);
        let autoCron = "";
        if (f === "hourly") autoCron = "0 * * * *";
        else if (f === "daily") autoCron = m + " " + h + " * * *";
        else if (f === "weekly") {
          const dayMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
          const checked = [];
          $$("#schedEditDaysRow input[type=checkbox]:checked").forEach(cb => checked.push(dayMap[cb.value]));
          autoCron = m + " " + h + " * * " + (checked.length ? checked.join(",") : "*");
        } else if (f === "monthly") autoCron = m + " " + h + " 1 * *";
        if (autoCron) cronInput.value = autoCron;
      }
    }
  });

  // Show/hide form fields based on frequency
  const freqSelect = $("#schedEditFrequency");
  freqSelect.addEventListener("change", () => {
    const f = freqSelect.value;
    $("#schedEditTimeRow").style.display = (f === "manual" || f === "hourly") ? "none" : "block";
    $("#schedEditDaysRow").style.display = f === "weekly" ? "block" : "none";
  });
  // Trigger initial visibility
  freqSelect.dispatchEvent(new Event("change"));

  // Save
  $("#schedEditSave").addEventListener("click", () => {
    const timezone = $("#schedEditTimezone").value || "Australia/Perth";
    const currentData = parseScheduledData(spaceItemData);
    let newData;
    if (cronMode) {
      const cronExpr = ($("#schedEditCron").value || "").trim();
      newData = {
        schedule: { frequency: "custom", time: sched.time || "07:00", days_of_week: null, timezone, cron_override: cronExpr || null },
        status: currentData.status,
        todo: currentData.todo,
        ignore: currentData.ignore,
      };
    } else {
      const frequency = freqSelect.value;
      const time = $("#schedEditTime").value || "07:00";
      let daysOfWeek = null;
      if (frequency === "weekly") {
        daysOfWeek = [];
        $$("#schedEditDaysRow input[type=checkbox]:checked").forEach(cb => daysOfWeek.push(cb.value));
      }
      newData = {
        schedule: { frequency, time, days_of_week: daysOfWeek, timezone, cron_override: null },
        status: currentData.status,
        todo: currentData.todo,
        ignore: currentData.ignore,
      };
    }
    saveScheduledSpaceData(newData);
  });

  // Cancel
  $("#schedEditCancel").addEventListener("click", async () => {
    const item = await apiGet(`/items/${spaceItemId}`);
    spaceItemData = item;
    refreshScheduledDashboard(item);
  });
}

/** Re-render only the dashboard pane (left side) for scheduled space. */
function refreshScheduledDashboard(item) {
  const dashboard = $("#scheduledDashboard");
  if (!dashboard) return;
  const sd = parseScheduledData(item);
  const sched = sd.schedule;
  const status = sd.status;
  const schedDesc = describeSchedule(sched);
  const cronExpr = getEffectiveCron(sched);

  let nextRunClass = "";
  if (status.next_run) {
    const nextDate = new Date(status.next_run);
    const now = new Date();
    if (nextDate < now) nextRunClass = "overdue";
    else if ((nextDate - now) < 3600000) nextRunClass = "soon";
  }

  let lastStatusBadge = '<span class="scheduled-status-badge never">Never run</span>';
  if (status.last_status === "success") lastStatusBadge = '<span class="scheduled-status-badge success">Success</span>';
  else if (status.last_status === "error") lastStatusBadge = '<span class="scheduled-status-badge error">Error</span>';
  else if (status.last_status === "running") lastStatusBadge = '<span class="scheduled-status-badge running">Running</span>';

  dashboard.innerHTML = `
    <div class="engagement-section">
      <div class="engagement-section-header">
        <span class="section-icon">&#x1F553;</span>
        <span class="section-title">Schedule</span>
        <button class="engagement-edit-btn" id="scheduledEditSchedule">Edit</button>
        <span class="section-toggle">&#x25BC;</span>
      </div>
      <div class="engagement-section-body" id="scheduledScheduleBody">
        <div class="scheduled-frequency-display">${esc(schedDesc.title)}</div>
        <div class="scheduled-frequency-detail">${esc(schedDesc.detail)}</div>
        ${cronExpr ? `<span class="scheduled-cron-raw">${esc(cronExpr)}</span>` : ""}
        ${sched.frequency === "weekly" && sched.days_of_week ? `
          <div class="scheduled-days-row">
            ${["monday","tuesday","wednesday","thursday","friday","saturday","sunday"].map(d =>
              `<span class="scheduled-day-check ${sched.days_of_week.includes(d) ? "active" : ""}">
                <input type="checkbox" disabled ${sched.days_of_week.includes(d) ? "checked" : ""}> ${d.charAt(0).toUpperCase() + d.slice(1, 3)}
              </span>`
            ).join("")}
          </div>
        ` : ""}
      </div>
    </div>

    <div class="engagement-section">
      <div class="engagement-section-header">
        <span class="section-icon">&#x1F4CA;</span>
        <span class="section-title">Status</span>
        <span class="section-toggle">&#x25BC;</span>
      </div>
      <div class="engagement-section-body">
        <div class="scheduled-status-panel">
          <span class="status-label">Next run</span>
          <span class="status-value"><span class="scheduled-next-run ${nextRunClass}">${sched.frequency === "manual" ? "Manual trigger" : formatScheduledTime(status.next_run)}</span></span>

          <span class="status-label">Last run</span>
          <span class="status-value">${formatScheduledTime(status.last_run)}</span>

          <span class="status-label">Last status</span>
          <span class="status-value">${lastStatusBadge}${status.last_duration_ms != null ? ` <span style="font-size:0.8rem;color:var(--text-dim)">(took ${formatDuration(status.last_duration_ms)})</span>` : ""}</span>

          <span class="status-label">Run count</span>
          <span class="status-value"><span class="scheduled-run-count">${status.run_count || 0}</span></span>

          <span class="status-label">Expires</span>
          <span class="status-value">
            <div class="scheduled-due-date">
              <input type="date" id="scheduledDueDate" value="${item.date_due || ""}" />
              ${item.date_due ? '<button class="due-clear-btn" id="scheduledDueDateClear" title="Clear due date">&#x2715;</button>' : ""}
              ${item.date_due && item.date_due < new Date().toISOString().slice(0, 10) ? '<span class="scheduled-due-date-expired">Expired</span>' : ""}
            </div>
          </span>
        </div>
      </div>
    </div>

    <div class="engagement-section">
      <div class="engagement-section-header">
        <span class="section-icon">&#x1F4DD;</span>
        <span class="section-title">Task Instructions</span>
        <span class="section-toggle">&#x25BC;</span>
      </div>
      <div class="engagement-section-body">
        <textarea id="scheduledDescTextarea" style="width:100%;min-height:120px;background:rgba(255,255,255,0.06);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);padding:8px;font-size:0.83rem;resize:vertical;outline:none;font-family:inherit;">${esc(item.description || "")}</textarea>
        <span class="engagement-save-indicator" id="scheduledDescSaveIndicator"></span>
      </div>
    </div>

    ${renderScheduledListHtml(sd.todo, "todo", "&#x2611;", "No tasks defined yet.")}
    ${renderScheduledListHtml(sd.ignore, "ignore", "&#x1F6AB;", "No ignore rules defined yet.")}
  `;

  // Re-bind section collapse toggles
  $$("#scheduledDashboard .engagement-section-header").forEach(header => {
    header.addEventListener("click", (e) => {
      if (e.target.classList.contains("engagement-edit-btn")) return;
      header.parentElement.classList.toggle("collapsed");
    });
  });

  // Re-bind edit schedule button
  const editScheduleBtn = $("#scheduledEditSchedule");
  if (editScheduleBtn) {
    editScheduleBtn.addEventListener("click", (e) => { e.stopPropagation(); openScheduledEdit(parseScheduledData(spaceItemData)); });
  }

  // Re-bind description auto-save
  const descTextarea = $("#scheduledDescTextarea");
  if (descTextarea) {
    descTextarea.addEventListener("input", () => {
      const ind = $("#scheduledDescSaveIndicator");
      if (ind) { ind.textContent = "Unsaved..."; ind.className = "engagement-save-indicator"; }
      if (scheduledSaveTimer) clearTimeout(scheduledSaveTimer);
      scheduledSaveTimer = setTimeout(() => saveScheduledDescription(), 2000);
    });
  }

  // Re-bind due date editing
  const dueDateInput = $("#scheduledDueDate");
  if (dueDateInput) {
    dueDateInput.addEventListener("change", async () => {
      if (!spaceItemId) return;
      const val = dueDateInput.value || null;
      try {
        await apiPatch(`/items/${spaceItemId}`, { date_due: val || "" });
        const updated = await apiGet(`/items/${spaceItemId}`);
        spaceItemData = updated;
        refreshScheduledDashboard(updated);
        loadTracker();
        toast(val ? "Due date set" : "Due date cleared");
      } catch (e) {
        toast("Failed to save due date: " + e.message, "error");
      }
    });
  }
  const dueDateClear = $("#scheduledDueDateClear");
  if (dueDateClear) {
    dueDateClear.addEventListener("click", async () => {
      if (!spaceItemId) return;
      try {
        await apiPatch(`/items/${spaceItemId}`, { date_due: "" });
        const updated = await apiGet(`/items/${spaceItemId}`);
        spaceItemData = updated;
        refreshScheduledDashboard(updated);
        loadTracker();
        toast("Due date cleared");
      } catch (e) {
        toast("Failed to clear due date: " + e.message, "error");
      }
    });
  }

  // Re-bind TODO and IGNORE list events
  bindScheduledListEvents("todo");
  bindScheduledListEvents("ignore");
}


registerSpacePlugin({
  name: "scheduled",
  label: "Scheduled",
  icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  description: "Scheduled task with frequency, timing, and run history",
  capabilities: { liveRefresh: true },
  render: renderSpaceScheduled,
  refreshDiscussion: renderScheduledDiscussion,
  refreshDashboard: refreshScheduledDashboard,
  cleanup: () => {
    if (scheduledSaveTimer) { clearTimeout(scheduledSaveTimer); scheduledSaveTimer = null; }
  },
});
