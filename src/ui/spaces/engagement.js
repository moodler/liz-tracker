// ── Space: Engagement ──
let engagementSaveTimer = null;

/** Parse space_data JSON safely, returning a default structure if empty/invalid. */
function parseEngagementData(item) {
  const defaults = {
    contractor: { company: "", contact: "", phone: "", mobile: "", email: "", address: "" },
    quote: { reference: "", date: "", expiry: "", status: "pending", total: 0, currency: "AUD", includes_gst: true, line_items: [] },
    payment: { status: "not_started", deposits: [], invoices: [] },
    milestones: [],
    gmail_query: "",
    calendar_tag: "",
    comms_log: [],
  };
  if (!item.space_data) return defaults;
  try {
    const parsed = typeof item.space_data === "string" ? JSON.parse(item.space_data) : item.space_data;
    return {
      contractor: { ...defaults.contractor, ...(parsed.contractor || {}) },
      quote: { ...defaults.quote, ...(parsed.quote || {}), line_items: (parsed.quote && parsed.quote.line_items) || [] },
      payment: { ...defaults.payment, ...(parsed.payment || {}), deposits: (parsed.payment && parsed.payment.deposits) || [], invoices: (parsed.payment && parsed.payment.invoices) || [] },
      milestones: parsed.milestones || [],
      gmail_query: parsed.gmail_query || "",
      calendar_tag: parsed.calendar_tag || "",
      comms_log: parsed.comms_log || [],
    };
  } catch { return defaults; }
}

/** Format currency amount. */
function formatCurrency(amount, currency) {
  if (amount == null || isNaN(amount)) return "—";
  const sym = currency === "AUD" ? "$" : currency === "USD" ? "US$" : currency === "GBP" ? "£" : "$";
  return sym + Number(amount).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderSpaceEngagement(item) {
  const sd = parseEngagementData(item);
  const c = sd.contractor;
  const q = sd.quote;
  const p = sd.payment;

  // Find cover image from attachments
  const attachments = item.attachments || [];
  const coverAtt = attachments.find(a => /^cover\.(png|jpg|jpeg|webp)$/i.test(a.filename));
  const coverHtml = coverAtt
    ? `<div class="engagement-header">
        <div class="engagement-cover-container">
          <img src="/api/v1/attachments/${esc(coverAtt.id)}" alt="Cover" />
        </div>
        ${renderEngagementContact(c)}
      </div>`
    : renderEngagementContact(c);

  spaceBody.innerHTML = `
    <div class="engagement-space" id="engagementSpace">
      <div class="engagement-dashboard" id="engagementDashboard">
        ${coverHtml}
        ${renderEngagementQuote(q, p)}
        ${renderEngagementMilestones(sd.milestones)}
        ${renderEngagementDocuments(item)}
        ${renderEngagementCommsLog(sd.comms_log)}
      </div>
      <div class="engagement-sidebar">
        <div class="text-sidebar-tabs">
          <button class="text-sidebar-tab active" data-panel="discussion">Discussion</button>
          <button class="text-sidebar-tab" data-panel="details">Details</button>
        </div>
        <div class="text-sidebar-panel active" id="engagementPanelDiscussion">
          <div class="text-discussion">
            <div class="text-discussion-thread" id="engagementDiscussionThread"></div>
            <div class="text-discussion-input">
              <textarea id="engagementCommentInput" placeholder="Add a comment..." rows="2"></textarea>
              <button id="engagementCommentSubmit">Send</button>
            </div>
          </div>
        </div>
        <div class="text-sidebar-panel" id="engagementPanelDetails">
          <div style="flex:1;overflow-y:auto;padding:14px;">
            <div class="engagement-edit-row">
              <label>Description</label>
              <span class="engagement-save-indicator" id="engagementDescSaveIndicator"></span>
            </div>
            <textarea id="engagementDescTextarea" style="width:100%;min-height:160px;background:rgba(255,255,255,0.06);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);padding:8px;font-size:0.83rem;resize:vertical;outline:none;margin-bottom:12px;font-family:inherit;">${esc(item.description || "")}</textarea>
            <div style="margin-top:8px;">
              <div class="engagement-edit-row">
                <label>Email query <span class="engagement-field-help"><button class="engagement-field-help-btn" data-help="gmail">?</button><div class="engagement-field-help-popup" id="engagementHelpGmail"><strong>Gmail Search Query</strong><br>Used by Harmoni to find related emails during scheduled checks. Uses Gmail search syntax.<br><br>Examples:<br><code>from:john@example.com</code><br><code>from:email OR to:email</code><br><code>subject:invoice project</code></div></span></label>
                <input id="engagementGmailQuery" value="${esc(sd.gmail_query)}" placeholder="from:email OR to:email" />
              </div>
              <div class="engagement-edit-row">
                <label>Calendar tag <span class="engagement-field-help"><button class="engagement-field-help-btn" data-help="calendar">?</button><div class="engagement-field-help-popup" id="engagementHelpCalendar"><strong>Calendar Tag</strong><br>Used by Harmoni to find related calendar events. Set this to a keyword or issue key that appears in event titles.<br><br>Example:<br><code>MARTIN-94</code> or <code>ProjectName</code></div></span></label>
                <input id="engagementCalendarTag" value="${esc(sd.calendar_tag)}" placeholder="ISSUE-KEY" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Populate discussion
  renderEngagementDiscussion(item.comments || []);

  // Sidebar tab switching
  $$("#engagementSpace .text-sidebar-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const panel = tab.dataset.panel;
      $$("#engagementSpace .text-sidebar-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      $$("#engagementSpace .text-sidebar-panel").forEach(p => p.classList.remove("active"));
      const targetPanel = $(`#engagementPanel${panel.charAt(0).toUpperCase() + panel.slice(1)}`);
      if (targetPanel) targetPanel.classList.add("active");
    });
  });

  // Section collapse toggle
  $$("#engagementDashboard .engagement-section-header").forEach(header => {
    header.addEventListener("click", () => {
      header.parentElement.classList.toggle("collapsed");
    });
  });

  // Edit buttons — contact
  const editContactBtn = $("#engagementEditContact");
  if (editContactBtn) {
    editContactBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openEngagementContactEdit(sd);
    });
  }

  // Edit buttons — quote
  const editQuoteBtn = $("#engagementEditQuote");
  if (editQuoteBtn) {
    editQuoteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openEngagementQuoteEdit(sd);
    });
  }

  // Edit buttons — milestones
  const editMilestonesBtn = $("#engagementEditMilestones");
  if (editMilestonesBtn) {
    editMilestonesBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openEngagementMilestonesEdit(sd);
    });
  }

  // Comment submit
  $("#engagementCommentSubmit").addEventListener("click", () => submitEngagementComment());
  $("#engagementCommentInput").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submitEngagementComment();
    }
  });

  // Description auto-save
  const descTextarea = $("#engagementDescTextarea");
  if (descTextarea) {
    descTextarea.addEventListener("input", () => {
      const ind = $("#engagementDescSaveIndicator");
      if (ind) { ind.textContent = "Unsaved..."; ind.className = "engagement-save-indicator"; }
      if (engagementSaveTimer) clearTimeout(engagementSaveTimer);
      engagementSaveTimer = setTimeout(() => saveEngagementDescription(), 2000);
    });
  }

  // Gmail query and calendar tag auto-save
  ["engagementGmailQuery", "engagementCalendarTag"].forEach(id => {
    const el = $(`#${id}`);
    if (el) {
      el.addEventListener("change", () => saveEngagementSpaceData());
    }
  });

  // Field help tooltip toggles
  $$("#engagementSpace .engagement-field-help-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const popup = btn.nextElementSibling;
      if (!popup) return;
      const wasOpen = popup.classList.contains("open");
      // Close all other popups first
      $$("#engagementSpace .engagement-field-help-popup").forEach(p => p.classList.remove("open"));
      if (!wasOpen) {
        // Position fixed popup relative to the button
        const rect = btn.getBoundingClientRect();
        popup.style.left = Math.max(8, rect.left + rect.width / 2 - 140) + "px";
        popup.style.top = (rect.top - 8) + "px";
        popup.style.transform = "translateY(-100%)";
        popup.classList.add("open");
      }
    });
  });
  // Close popups when clicking elsewhere
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".engagement-field-help")) {
      $$("#engagementSpace .engagement-field-help-popup").forEach(p => p.classList.remove("open"));
    }
  });
}

/** Render the contact card section. */
function renderEngagementContact(c) {
  const hasContact = c.company || c.contact || c.phone || c.mobile || c.email || c.address;
  const rows = [];
  if (c.company) rows.push(`<span class="contact-label">Company</span><span class="contact-value">${esc(c.company)}</span>`);
  if (c.contact) rows.push(`<span class="contact-label">Contact</span><span class="contact-value">${esc(c.contact)}</span>`);
  if (c.phone) rows.push(`<span class="contact-label">Phone</span><span class="contact-value"><a href="tel:${esc(c.phone)}">${esc(c.phone)}</a></span>`);
  if (c.mobile) rows.push(`<span class="contact-label">Mobile</span><span class="contact-value"><a href="tel:${esc(c.mobile)}">${esc(c.mobile)}</a></span>`);
  if (c.email) rows.push(`<span class="contact-label">Email</span><span class="contact-value"><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></span>`);
  if (c.address) rows.push(`<span class="contact-label">Address</span><span class="contact-value">${esc(c.address)}</span>`);

  return `
    <div class="engagement-section">
      <div class="engagement-section-header">
        <span class="section-icon">👤</span>
        <span class="section-title">Contact</span>
        <button class="engagement-edit-btn" id="engagementEditContact">Edit</button>
        <span class="section-toggle">▼</span>
      </div>
      <div class="engagement-section-body">
        ${hasContact ? `<div class="engagement-contact-grid">${rows.join("")}</div>` : '<div class="engagement-empty">No contact details yet. Click Edit to add.</div>'}
      </div>
    </div>
  `;
}

/** Render the quote / financial section. */
function renderEngagementQuote(q, p) {
  const hasQuote = q.total > 0 || q.reference || q.line_items.length > 0;
  let lineItemsHtml = "";
  if (q.line_items.length > 0) {
    lineItemsHtml = `<div class="engagement-line-items">${q.line_items.map(li =>
      `<div class="engagement-line-item"><span class="li-desc">${esc(li.desc)}</span><span class="li-amount">${li.amount != null ? formatCurrency(li.amount, q.currency) : "—"}</span></div>`
    ).join("")}</div>`;
  }
  const depositsHtml = p.deposits.length > 0 ? `<div class="engagement-deposits">${p.deposits.map(d =>
    `<div class="deposit-row"><span>${esc(d.date || "")}</span><span>${formatCurrency(d.amount, q.currency)}</span><span>${esc(d.method || "")}</span></div>`
  ).join("")}</div>` : "";
  const invoicesHtml = p.invoices.length > 0 ? `<div class="engagement-invoices">${p.invoices.map(inv =>
    `<div class="invoice-row"><span>Inv ${esc(inv.ref || "—")}</span><span>${esc(inv.date || "")}</span><span>${formatCurrency(inv.amount, q.currency)}</span></div>`
  ).join("")}</div>` : "";

  const paymentLabel = { not_started: "Not Started", deposit_paid: "Deposit Paid", in_progress: "In Progress", final_paid: "Final Paid" }[p.status] || p.status;

  return `
    <div class="engagement-section">
      <div class="engagement-section-header">
        <span class="section-icon">💰</span>
        <span class="section-title">Quote / Financial</span>
        <button class="engagement-edit-btn" id="engagementEditQuote">Edit</button>
        <span class="section-toggle">▼</span>
      </div>
      <div class="engagement-section-body">
        ${hasQuote ? `
          <div class="engagement-quote-summary">
            <span class="engagement-quote-total">${formatCurrency(q.total, q.currency)}</span>
            <span class="engagement-quote-status ${esc(q.status)}">${esc(q.status)}</span>
            ${q.includes_gst ? '<span class="engagement-quote-meta">inc. GST</span>' : '<span class="engagement-quote-meta">ex. GST</span>'}
          </div>
          ${q.reference ? `<div class="engagement-quote-meta">Ref: ${esc(q.reference)}${q.date ? " — " + esc(q.date) : ""}${q.expiry ? " (expires " + esc(q.expiry) + ")" : ""}</div>` : ""}
          ${lineItemsHtml}
        ` : '<div class="engagement-empty">No quote details yet. Click Edit to add.</div>'}
        <div class="engagement-payment-status">
          <span class="engagement-payment-label">Payment:</span>
          <span class="engagement-payment-badge ${esc(p.status)}">${esc(paymentLabel)}</span>
          ${depositsHtml}
          ${invoicesHtml}
        </div>
      </div>
    </div>
  `;
}

/** Render the milestones section. */
function renderEngagementMilestones(milestones) {
  const hasMilestones = milestones.length > 0;
  return `
    <div class="engagement-section">
      <div class="engagement-section-header">
        <span class="section-icon">📅</span>
        <span class="section-title">Timeline / Milestones</span>
        <button class="engagement-edit-btn" id="engagementEditMilestones">Edit</button>
        <span class="section-toggle">▼</span>
      </div>
      <div class="engagement-section-body">
        ${hasMilestones ? milestones.map(ms => `
          <div class="engagement-milestone ${esc(ms.status || "upcoming")}">
            <span class="ms-status-dot ${esc(ms.status || "upcoming")}"></span>
            <span class="ms-label">${esc(ms.label)}</span>
            <span class="ms-date">${ms.date ? esc(ms.date) : "—"}</span>
          </div>
        `).join("") : '<div class="engagement-empty">No milestones yet. Click Edit to add.</div>'}
      </div>
    </div>
  `;
}

/** Render the documents section (from attachments). */
function renderEngagementDocuments(item) {
  const attachments = item.attachments || [];
  return `
    <div class="engagement-section">
      <div class="engagement-section-header">
        <span class="section-icon">📎</span>
        <span class="section-title">Documents</span>
        <span class="section-toggle">▼</span>
      </div>
      <div class="engagement-section-body">
        ${attachments.length > 0 ? `<div class="engagement-doc-list">${attachments.map(att => `
          <div class="engagement-doc-item">
            <span class="doc-icon">📄</span>
            <a href="/api/v1/attachments/${esc(att.id)}" target="_blank" title="${esc(att.filename)}">${esc(att.filename)}</a>
            <span style="color:var(--text-dim);font-size:0.75rem;margin-left:auto;">${att.uploaded_at ? formatTime(att.uploaded_at) : ""}</span>
          </div>
        `).join("")}</div>` : '<div class="engagement-empty">No documents attached.</div>'}
      </div>
    </div>
  `;
}

/** Render the communication log section. */
function renderEngagementCommsLog(commsLog) {
  return `
    <div class="engagement-section">
      <div class="engagement-section-header">
        <span class="section-icon">✉️</span>
        <span class="section-title">Communication Log</span>
        <span class="section-toggle">▼</span>
      </div>
      <div class="engagement-section-body">
        ${commsLog.length > 0 ? commsLog.map(entry => `
          <div class="engagement-comms-entry">
            <div class="engagement-comms-header">
              <span class="engagement-comms-direction ${esc(entry.direction || "inbound")}">${entry.direction === "outbound" ? "↑ Sent" : "↓ Received"}</span>
              <span class="engagement-comms-date">${esc(entry.date || "")}</span>
            </div>
            <div class="engagement-comms-subject">${esc(entry.subject || "")}</div>
            ${entry.snippet ? `<div class="engagement-comms-snippet">${esc(entry.snippet)}</div>` : ""}
          </div>
        `).join("") : '<div class="engagement-empty">No communication history yet. This is updated automatically during scheduled email checks.</div>'}
      </div>
    </div>
  `;
}

/** Render discussion thread in engagement space. */
function renderEngagementDiscussion(comments) {
  const thread = $("#engagementDiscussionThread");
  if (!thread) return;
  thread.innerHTML = "";
  if (!comments || comments.length === 0) {
    thread.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:40px 20px;font-size:0.85rem;">No comments yet.</div>';
    return;
  }
  comments.forEach(c => {
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

/** Submit a comment in the engagement discussion. */
async function submitEngagementComment() {
  const input = $("#engagementCommentInput");
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
    renderEngagementDiscussion(item.comments || []);
    toast("Comment posted");
  } catch (e) {
    toast("Failed to post comment: " + e.message, "error");
  }
}

/** Save the item description from the engagement details tab. */
async function saveEngagementDescription() {
  if (!spaceItemId) return;
  const textarea = $("#engagementDescTextarea");
  if (!textarea) return;
  const ind = $("#engagementDescSaveIndicator");
  try {
    if (ind) { ind.textContent = "Saving..."; ind.className = "engagement-save-indicator saving"; }
    await apiPatch(`/items/${spaceItemId}`, {
      description: textarea.value,
      actor: DEFAULT_AUTHOR,
    });
    if (spaceItemData) spaceItemData.description = textarea.value;
    if (ind) { ind.textContent = "Saved"; ind.className = "engagement-save-indicator saved"; }
    setTimeout(() => { if (ind && ind.textContent === "Saved") ind.textContent = ""; }, 3000);
  } catch (e) {
    if (ind) { ind.textContent = "Save failed"; ind.className = "engagement-save-indicator"; }
    toast("Failed to save description: " + e.message, "error");
  }
}

/** Collect current space_data from the engagement UI and return it as an object. */
function collectEngagementSpaceData() {
  if (!spaceItemData) return null;
  const existing = parseEngagementData(spaceItemData);
  // Update settings fields from the details tab
  const gmailQuery = ($("#engagementGmailQuery") || {}).value || "";
  const calendarTag = ($("#engagementCalendarTag") || {}).value || "";
  return {
    contractor: existing.contractor,
    quote: existing.quote,
    payment: existing.payment,
    milestones: existing.milestones,
    gmail_query: gmailQuery,
    calendar_tag: calendarTag,
    comms_log: existing.comms_log,
  };
}

/** Save space_data to the backend. */
async function saveEngagementSpaceData(newData) {
  if (!spaceItemId) return;
  const data = newData || collectEngagementSpaceData();
  if (!data) return;
  try {
    await apiPatch(`/items/${spaceItemId}`, {
      space_data: JSON.stringify(data),
      actor: DEFAULT_AUTHOR,
    });
    if (spaceItemData) spaceItemData.space_data = JSON.stringify(data);
    loadTracker();
  } catch (e) {
    toast("Failed to save engagement data: " + e.message, "error");
  }
}

/** Open an inline edit dialog for contact fields. */
function openEngagementContactEdit(sd) {
  const body = $$("#engagementDashboard .engagement-section")[0].querySelector(".engagement-section-body");
  if (!body) return;
  const c = sd.contractor;
  body.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:6px;">
      <div class="engagement-edit-row"><label>Company</label><input id="ecCompany" value="${esc(c.company)}" /></div>
      <div class="engagement-edit-row"><label>Contact</label><input id="ecContact" value="${esc(c.contact)}" /></div>
      <div class="engagement-edit-row"><label>Phone</label><input id="ecPhone" value="${esc(c.phone)}" type="tel" /></div>
      <div class="engagement-edit-row"><label>Mobile</label><input id="ecMobile" value="${esc(c.mobile)}" type="tel" /></div>
      <div class="engagement-edit-row"><label>Email</label><input id="ecEmail" value="${esc(c.email)}" type="email" /></div>
      <div class="engagement-edit-row"><label>Address</label><input id="ecAddress" value="${esc(c.address)}" /></div>
      <div style="display:flex;gap:8px;margin-top:6px;">
        <button class="engagement-edit-btn" id="ecSave" style="border-color:var(--highlight);color:var(--highlight);">Save</button>
        <button class="engagement-edit-btn" id="ecCancel">Cancel</button>
      </div>
    </div>
  `;
  $("#ecSave").addEventListener("click", async () => {
    const data = collectEngagementSpaceData();
    data.contractor = {
      company: $("#ecCompany").value.trim(),
      contact: $("#ecContact").value.trim(),
      phone: $("#ecPhone").value.trim(),
      mobile: $("#ecMobile").value.trim(),
      email: $("#ecEmail").value.trim(),
      address: $("#ecAddress").value.trim(),
    };
    await saveEngagementSpaceData(data);
    // Re-render the full dashboard
    const item = await apiGet(`/items/${spaceItemId}`);
    spaceItemData = item;
    refreshEngagementDashboard(item);
    toast("Contact saved");
  });
  $("#ecCancel").addEventListener("click", async () => {
    const item = await apiGet(`/items/${spaceItemId}`);
    spaceItemData = item;
    refreshEngagementDashboard(item);
  });
}

/** Open an inline edit dialog for quote/financial fields. */
function openEngagementQuoteEdit(sd) {
  const sections = $$("#engagementDashboard .engagement-section");
  const body = sections[1] ? sections[1].querySelector(".engagement-section-body") : null;
  if (!body) return;
  const q = sd.quote;
  const p = sd.payment;
  const lineItemsHtml = q.line_items.map((li, i) =>
    `<div class="engagement-edit-row" data-li="${i}"><label>Item ${i + 1}</label><input data-field="desc" value="${esc(li.desc)}" style="flex:2;" placeholder="Description" /><input data-field="amount" value="${li.amount != null ? li.amount : ""}" style="flex:0 0 100px;" placeholder="Amount" type="number" step="0.01" /><button class="engagement-edit-btn" data-remove="${i}" style="flex:0 0 auto;">✕</button></div>`
  ).join("");
  body.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:6px;">
      <div class="engagement-edit-row"><label>Reference</label><input id="eqRef" value="${esc(q.reference)}" /></div>
      <div class="engagement-edit-row"><label>Total</label><input id="eqTotal" value="${q.total || ""}" type="number" step="0.01" /></div>
      <div class="engagement-edit-row"><label>Currency</label><input id="eqCurrency" value="${esc(q.currency || "AUD")}" style="flex:0 0 80px;" /><label style="min-width:auto;margin-left:8px;">GST</label><input id="eqGst" type="checkbox" ${q.includes_gst ? "checked" : ""} style="flex:0;width:auto;" /></div>
      <div class="engagement-edit-row"><label>Status</label><select id="eqStatus"><option value="pending" ${q.status === "pending" ? "selected" : ""}>Pending</option><option value="valid" ${q.status === "valid" ? "selected" : ""}>Valid</option><option value="expired" ${q.status === "expired" ? "selected" : ""}>Expired</option></select></div>
      <div class="engagement-edit-row"><label>Date</label><input id="eqDate" value="${esc(q.date)}" type="date" /><label style="min-width:auto;margin-left:8px;">Expiry</label><input id="eqExpiry" value="${esc(q.expiry)}" type="date" /></div>
      <div style="font-size:0.8rem;color:var(--text-dim);font-weight:600;margin-top:6px;">Line Items</div>
      <div id="eqLineItems">${lineItemsHtml}</div>
      <button class="engagement-edit-btn" id="eqAddLine" style="align-self:flex-start;">+ Add Line Item</button>
      <div style="font-size:0.8rem;color:var(--text-dim);font-weight:600;margin-top:10px;">Payment</div>
      <div class="engagement-edit-row"><label>Status</label><select id="eqPayStatus"><option value="not_started" ${p.status === "not_started" ? "selected" : ""}>Not Started</option><option value="deposit_paid" ${p.status === "deposit_paid" ? "selected" : ""}>Deposit Paid</option><option value="in_progress" ${p.status === "in_progress" ? "selected" : ""}>In Progress</option><option value="final_paid" ${p.status === "final_paid" ? "selected" : ""}>Final Paid</option></select></div>
      <div style="display:flex;gap:8px;margin-top:6px;">
        <button class="engagement-edit-btn" id="eqSave" style="border-color:var(--highlight);color:var(--highlight);">Save</button>
        <button class="engagement-edit-btn" id="eqCancel">Cancel</button>
      </div>
    </div>
  `;

  // Add line item button
  let lineItemCount = q.line_items.length;
  $("#eqAddLine").addEventListener("click", () => {
    const container = $("#eqLineItems");
    const row = document.createElement("div");
    row.className = "engagement-edit-row";
    row.dataset.li = lineItemCount;
    row.innerHTML = `<label>Item ${lineItemCount + 1}</label><input data-field="desc" value="" style="flex:2;" placeholder="Description" /><input data-field="amount" value="" style="flex:0 0 100px;" placeholder="Amount" type="number" step="0.01" /><button class="engagement-edit-btn" data-remove="${lineItemCount}" style="flex:0 0 auto;">✕</button>`;
    container.appendChild(row);
    lineItemCount++;
    // Bind remove
    row.querySelector("[data-remove]").addEventListener("click", () => row.remove());
  });

  // Remove buttons for existing items
  $$("#eqLineItems [data-remove]").forEach(btn => {
    btn.addEventListener("click", () => btn.closest(".engagement-edit-row").remove());
  });

  $("#eqSave").addEventListener("click", async () => {
    const lineItems = [];
    $$("#eqLineItems .engagement-edit-row").forEach(row => {
      const desc = row.querySelector('[data-field="desc"]').value.trim();
      const amountStr = row.querySelector('[data-field="amount"]').value.trim();
      if (desc) lineItems.push({ desc, amount: amountStr ? parseFloat(amountStr) : null });
    });
    const data = collectEngagementSpaceData();
    data.quote = {
      reference: $("#eqRef").value.trim(),
      total: parseFloat($("#eqTotal").value) || 0,
      currency: $("#eqCurrency").value.trim() || "AUD",
      includes_gst: $("#eqGst").checked,
      status: $("#eqStatus").value,
      date: $("#eqDate").value,
      expiry: $("#eqExpiry").value,
      line_items: lineItems,
    };
    data.payment = { ...data.payment, status: $("#eqPayStatus").value };
    await saveEngagementSpaceData(data);
    const item = await apiGet(`/items/${spaceItemId}`);
    spaceItemData = item;
    refreshEngagementDashboard(item);
    toast("Quote saved");
  });
  $("#eqCancel").addEventListener("click", async () => {
    const item = await apiGet(`/items/${spaceItemId}`);
    spaceItemData = item;
    refreshEngagementDashboard(item);
  });
}

/** Open an inline edit dialog for milestones. */
function openEngagementMilestonesEdit(sd) {
  const sections = $$("#engagementDashboard .engagement-section");
  const body = sections[2] ? sections[2].querySelector(".engagement-section-body") : null;
  if (!body) return;
  const msHtml = sd.milestones.map((ms, i) =>
    `<div class="engagement-edit-row" data-ms="${i}"><input data-field="label" value="${esc(ms.label)}" style="flex:2;" placeholder="Milestone label" /><input data-field="date" value="${esc(ms.date || "")}" type="date" style="flex:0 0 140px;" /><select data-field="status" style="flex:0 0 100px;"><option value="upcoming" ${ms.status === "upcoming" ? "selected" : ""}>Upcoming</option><option value="done" ${ms.status === "done" ? "selected" : ""}>Done</option><option value="overdue" ${ms.status === "overdue" ? "selected" : ""}>Overdue</option></select><button class="engagement-edit-btn" data-remove="${i}" style="flex:0 0 auto;">✕</button></div>`
  ).join("");
  body.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:6px;">
      <div id="emMilestones">${msHtml}</div>
      <button class="engagement-edit-btn" id="emAddMs" style="align-self:flex-start;">+ Add Milestone</button>
      <div style="display:flex;gap:8px;margin-top:6px;">
        <button class="engagement-edit-btn" id="emSave" style="border-color:var(--highlight);color:var(--highlight);">Save</button>
        <button class="engagement-edit-btn" id="emCancel">Cancel</button>
      </div>
    </div>
  `;

  let msCount = sd.milestones.length;
  $("#emAddMs").addEventListener("click", () => {
    const container = $("#emMilestones");
    const row = document.createElement("div");
    row.className = "engagement-edit-row";
    row.dataset.ms = msCount;
    row.innerHTML = `<input data-field="label" value="" style="flex:2;" placeholder="Milestone label" /><input data-field="date" value="" type="date" style="flex:0 0 140px;" /><select data-field="status" style="flex:0 0 100px;"><option value="upcoming" selected>Upcoming</option><option value="done">Done</option><option value="overdue">Overdue</option></select><button class="engagement-edit-btn" data-remove="${msCount}" style="flex:0 0 auto;">✕</button>`;
    container.appendChild(row);
    msCount++;
    row.querySelector("[data-remove]").addEventListener("click", () => row.remove());
  });
  $$("#emMilestones [data-remove]").forEach(btn => {
    btn.addEventListener("click", () => btn.closest(".engagement-edit-row").remove());
  });

  $("#emSave").addEventListener("click", async () => {
    const milestones = [];
    $$("#emMilestones .engagement-edit-row").forEach(row => {
      const label = row.querySelector('[data-field="label"]').value.trim();
      const date = row.querySelector('[data-field="date"]').value;
      const status = row.querySelector('[data-field="status"]').value;
      if (label) milestones.push({ label, date: date || null, status });
    });
    const data = collectEngagementSpaceData();
    data.milestones = milestones;
    await saveEngagementSpaceData(data);
    const item = await apiGet(`/items/${spaceItemId}`);
    spaceItemData = item;
    refreshEngagementDashboard(item);
    toast("Milestones saved");
  });
  $("#emCancel").addEventListener("click", async () => {
    const item = await apiGet(`/items/${spaceItemId}`);
    spaceItemData = item;
    refreshEngagementDashboard(item);
  });
}

/** Re-render only the dashboard pane (left side) without touching the sidebar. */
function refreshEngagementDashboard(item) {
  const dashboard = $("#engagementDashboard");
  if (!dashboard) return;
  const sd = parseEngagementData(item);
  dashboard.innerHTML =
    renderEngagementContact(sd.contractor) +
    renderEngagementQuote(sd.quote, sd.payment) +
    renderEngagementMilestones(sd.milestones) +
    renderEngagementDocuments(item) +
    renderEngagementCommsLog(sd.comms_log);

  // Re-bind section collapse toggles
  $$("#engagementDashboard .engagement-section-header").forEach(header => {
    header.addEventListener("click", () => {
      header.parentElement.classList.toggle("collapsed");
    });
  });
  // Re-bind edit buttons
  const editContactBtn = $("#engagementEditContact");
  if (editContactBtn) {
    editContactBtn.addEventListener("click", (e) => { e.stopPropagation(); openEngagementContactEdit(parseEngagementData(spaceItemData)); });
  }
  const editQuoteBtn = $("#engagementEditQuote");
  if (editQuoteBtn) {
    editQuoteBtn.addEventListener("click", (e) => { e.stopPropagation(); openEngagementQuoteEdit(parseEngagementData(spaceItemData)); });
  }
  const editMilestonesBtn = $("#engagementEditMilestones");
  if (editMilestonesBtn) {
    editMilestonesBtn.addEventListener("click", (e) => { e.stopPropagation(); openEngagementMilestonesEdit(parseEngagementData(spaceItemData)); });
  }
}


registerSpacePlugin({
  name: "engagement",
  label: "Engagement",
  icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/><path d="M12 12v4M8 14h8"/></svg>',
  description: "Coordination workspace for contractors, services, and external engagements",
  capabilities: { coverImage: true, liveRefresh: true },
  render: renderSpaceEngagement,
  refreshDiscussion: renderEngagementDiscussion,
  refreshDashboard: refreshEngagementDashboard,
  cleanup: () => {
    if (engagementSaveTimer) { clearTimeout(engagementSaveTimer); engagementSaveTimer = null; }
  },
});
