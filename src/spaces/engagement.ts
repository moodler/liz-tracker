/**
 * Engagement Space Plugin — Server-Side
 *
 * Provides: engagementPlugin
 * Capabilities: coverImage, liveRefresh
 * API routes: PATCH /engagement/contact, PATCH /engagement/quote,
 *             POST/DELETE /engagement/milestones, POST /engagement/comms,
 *             PATCH /engagement/settings
 * MCP tools: tracker_update_engagement_contact, tracker_update_engagement_quote,
 *            tracker_add_engagement_milestone, tracker_remove_engagement_milestone,
 *            tracker_update_engagement_milestone, tracker_add_engagement_comms,
 *            tracker_update_engagement_settings
 * Dependencies: db.ts (getWorkItemKey, updateWorkItem)
 */

import { z } from "zod";
import { getWorkItemKey, updateWorkItem } from "../db.js";
import type { SpacePlugin, SpaceApiRoute, SpaceMcpTool, WorkItem } from "./types.js";

// ── Data Layer ──

interface EngagementSpaceData {
  contractor: { company: string; contact: string; phone: string; mobile: string; email: string; address: string };
  quote: { reference: string; date: string; expiry: string; status: string; total: number; currency: string; includes_gst: boolean; line_items: { desc: string; amount: number | null }[] };
  payment: { status: string; deposits: { date: string; amount: number; method: string }[]; invoices: { ref: string; date: string; amount: number }[] };
  milestones: { label: string; date: string | null; status: string }[];
  gmail_query: string;
  calendar_tag: string;
  comms_log: { direction: string; date: string; subject: string; snippet: string }[];
}

const DEFAULTS: EngagementSpaceData = {
  contractor: { company: "", contact: "", phone: "", mobile: "", email: "", address: "" },
  quote: { reference: "", date: "", expiry: "", status: "pending", total: 0, currency: "AUD", includes_gst: true, line_items: [] },
  payment: { status: "not_started", deposits: [], invoices: [] },
  milestones: [],
  gmail_query: "",
  calendar_tag: "",
  comms_log: [],
};

/**
 * Parse the space_data JSON from an engagement work item.
 * Returns the parsed object with all fields normalised and defaults applied.
 */
function parseEngagementSpaceData(raw: string | null): EngagementSpaceData {
  if (!raw) return { ...DEFAULTS, contractor: { ...DEFAULTS.contractor }, quote: { ...DEFAULTS.quote, line_items: [] }, payment: { ...DEFAULTS.payment, deposits: [], invoices: [] }, milestones: [], comms_log: [] };
  try {
    const parsed = JSON.parse(raw);
    return {
      contractor: { ...DEFAULTS.contractor, ...(parsed.contractor || {}) },
      quote: { ...DEFAULTS.quote, ...(parsed.quote || {}), line_items: (parsed.quote && parsed.quote.line_items) || [] },
      payment: { ...DEFAULTS.payment, ...(parsed.payment || {}), deposits: (parsed.payment && parsed.payment.deposits) || [], invoices: (parsed.payment && parsed.payment.invoices) || [] },
      milestones: parsed.milestones || [],
      gmail_query: parsed.gmail_query || "",
      calendar_tag: parsed.calendar_tag || "",
      comms_log: parsed.comms_log || [],
    };
  } catch {
    return { ...DEFAULTS, contractor: { ...DEFAULTS.contractor }, quote: { ...DEFAULTS.quote, line_items: [] }, payment: { ...DEFAULTS.payment, deposits: [], invoices: [] }, milestones: [], comms_log: [] };
  }
}

/** Save updated space_data back to an engagement work item. */
function saveEngagementData(itemId: string, data: EngagementSpaceData) {
  return updateWorkItem(itemId, { space_data: JSON.stringify(data) });
}

// ── HTTP Helpers (inline to avoid circular imports with api.ts) ──

function jsonResponse(res: import("http").ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body).toString() });
  res.end(body);
}

function errorResponse(res: import("http").ServerResponse, message: string, status = 400): void {
  jsonResponse(res, { error: message }, status);
}

function parseRequestBody(req: import("http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString();
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ── API Routes ──

const engagementApiRoutes: SpaceApiRoute[] = [
  // PATCH /items/:id/engagement/contact — update contact details
  {
    method: "PATCH",
    path: "contact",
    handler: async (req, res, item) => {
      const body = await parseRequestBody(req);
      const spaceData = parseEngagementSpaceData(item.space_data);

      if (body.company !== undefined) spaceData.contractor.company = String(body.company);
      if (body.contact !== undefined) spaceData.contractor.contact = String(body.contact);
      if (body.phone !== undefined) spaceData.contractor.phone = String(body.phone);
      if (body.mobile !== undefined) spaceData.contractor.mobile = String(body.mobile);
      if (body.email !== undefined) spaceData.contractor.email = String(body.email);
      if (body.address !== undefined) spaceData.contractor.address = String(body.address);

      const updated = saveEngagementData(item.id, spaceData);
      if (!updated) return errorResponse(res, "Failed to update work item", 500);
      jsonResponse(res, { contractor: spaceData.contractor });
    },
  },
  // PATCH /items/:id/engagement/quote — update quote/financial details
  {
    method: "PATCH",
    path: "quote",
    handler: async (req, res, item) => {
      const body = await parseRequestBody(req);
      const spaceData = parseEngagementSpaceData(item.space_data);

      if (body.reference !== undefined) spaceData.quote.reference = String(body.reference);
      if (body.date !== undefined) spaceData.quote.date = String(body.date);
      if (body.expiry !== undefined) spaceData.quote.expiry = String(body.expiry);
      if (body.status !== undefined) spaceData.quote.status = String(body.status);
      if (body.total !== undefined) spaceData.quote.total = Number(body.total) || 0;
      if (body.currency !== undefined) spaceData.quote.currency = String(body.currency);
      if (body.includes_gst !== undefined) spaceData.quote.includes_gst = Boolean(body.includes_gst);
      if (body.line_items !== undefined && Array.isArray(body.line_items)) {
        spaceData.quote.line_items = (body.line_items as Array<{ desc?: string; amount?: number | null }>).map(li => ({
          desc: String(li.desc || ""),
          amount: li.amount != null ? Number(li.amount) : null,
        }));
      }
      if (body.payment_status !== undefined) spaceData.payment.status = String(body.payment_status);

      const updated = saveEngagementData(item.id, spaceData);
      if (!updated) return errorResponse(res, "Failed to update work item", 500);
      jsonResponse(res, { quote: spaceData.quote, payment: spaceData.payment });
    },
  },
  // POST /items/:id/engagement/milestones — add milestones
  {
    method: "POST",
    path: "milestones",
    handler: async (req, res, item) => {
      const body = await parseRequestBody(req);
      if (!body.milestones || !Array.isArray(body.milestones)) return errorResponse(res, "milestones (array of objects) is required");

      const spaceData = parseEngagementSpaceData(item.space_data);
      const newMs = (body.milestones as Array<{ label?: string; date?: string | null; status?: string }>).map(ms => ({
        label: String(ms.label || ""),
        date: ms.date ?? null,
        status: ms.status || "upcoming",
      }));
      spaceData.milestones.push(...newMs);

      const updated = saveEngagementData(item.id, spaceData);
      if (!updated) return errorResponse(res, "Failed to update work item", 500);
      jsonResponse(res, { milestones: spaceData.milestones, added: newMs.length, total: spaceData.milestones.length });
    },
  },
  // DELETE /items/:id/engagement/milestones — remove milestones by indices
  {
    method: "DELETE",
    path: "milestones",
    handler: async (req, res, item) => {
      const body = await parseRequestBody(req);
      if (!body.indices || !Array.isArray(body.indices)) return errorResponse(res, "indices (array of numbers) is required");

      const spaceData = parseEngagementSpaceData(item.space_data);
      const indices = (body.indices as unknown[]).map(Number);
      const invalidIndices = indices.filter(i => i < 0 || i >= spaceData.milestones.length);
      if (invalidIndices.length > 0) {
        return errorResponse(res, `Invalid indices: ${invalidIndices.join(", ")}. Milestones list has ${spaceData.milestones.length} items.`);
      }

      const sortedIndices = [...indices].sort((a, b) => b - a);
      for (const idx of sortedIndices) {
        spaceData.milestones.splice(idx, 1);
      }

      const updated = saveEngagementData(item.id, spaceData);
      if (!updated) return errorResponse(res, "Failed to update work item", 500);
      jsonResponse(res, { milestones: spaceData.milestones, total: spaceData.milestones.length });
    },
  },
  // POST /items/:id/engagement/comms — add communication log entries
  {
    method: "POST",
    path: "comms",
    handler: async (req, res, item) => {
      const body = await parseRequestBody(req);
      if (!body.entries || !Array.isArray(body.entries)) return errorResponse(res, "entries (array of objects) is required");

      const spaceData = parseEngagementSpaceData(item.space_data);
      const newEntries = (body.entries as Array<{ direction?: string; date?: string; subject?: string; snippet?: string }>).map(e => ({
        direction: e.direction || "inbound",
        date: e.date || "",
        subject: e.subject || "",
        snippet: e.snippet || "",
      }));
      spaceData.comms_log.push(...newEntries);

      const updated = saveEngagementData(item.id, spaceData);
      if (!updated) return errorResponse(res, "Failed to update work item", 500);
      jsonResponse(res, { comms_log: spaceData.comms_log, added: newEntries.length, total: spaceData.comms_log.length });
    },
  },
  // PATCH /items/:id/engagement/settings — update gmail_query and calendar_tag
  {
    method: "PATCH",
    path: "settings",
    handler: async (req, res, item) => {
      const body = await parseRequestBody(req);
      const spaceData = parseEngagementSpaceData(item.space_data);

      if (body.gmail_query !== undefined) spaceData.gmail_query = String(body.gmail_query);
      if (body.calendar_tag !== undefined) spaceData.calendar_tag = String(body.calendar_tag);

      const updated = saveEngagementData(item.id, spaceData);
      if (!updated) return errorResponse(res, "Failed to update work item", 500);
      jsonResponse(res, { gmail_query: spaceData.gmail_query, calendar_tag: spaceData.calendar_tag });
    },
  },
];

// ── MCP Tools ──

const engagementMcpTools: SpaceMcpTool[] = [
  {
    name: "tracker_update_engagement_contact",
    description: "Update contact/contractor details on an engagement space item. Only provided fields are updated — omitted fields keep their current values. Much simpler than updating space_data manually.",
    schema: {
      item_id: z.string().describe("Work item ID or display key (e.g. \"MARTIN-94\")"),
      company: z.string().optional().describe("Company or business name"),
      contact: z.string().optional().describe("Contact person name"),
      phone: z.string().optional().describe("Phone number"),
      mobile: z.string().optional().describe("Mobile number"),
      email: z.string().optional().describe("Email address"),
      address: z.string().optional().describe("Physical address"),
    },
    handler: async (args, item) => {
      const data = parseEngagementSpaceData(item.space_data);

      if (args.company !== undefined) data.contractor.company = String(args.company);
      if (args.contact !== undefined) data.contractor.contact = String(args.contact);
      if (args.phone !== undefined) data.contractor.phone = String(args.phone);
      if (args.mobile !== undefined) data.contractor.mobile = String(args.mobile);
      if (args.email !== undefined) data.contractor.email = String(args.email);
      if (args.address !== undefined) data.contractor.address = String(args.address);

      const updated = saveEngagementData(item.id, data);
      if (!updated) return { content: [{ type: "text" as const, text: "Error: Failed to update work item" }] };

      const c = data.contractor;
      const summary = [
        c.company && `Company: ${c.company}`,
        c.contact && `Contact: ${c.contact}`,
        c.phone && `Phone: ${c.phone}`,
        c.mobile && `Mobile: ${c.mobile}`,
        c.email && `Email: ${c.email}`,
        c.address && `Address: ${c.address}`,
      ].filter(Boolean).join("\n  ");

      return {
        content: [{
          type: "text" as const,
          text: `Updated contact details on ${getWorkItemKey(item)}.\n\nCurrent contact:\n  ${summary || "(empty)"}`,
        }],
      };
    },
  },
  {
    name: "tracker_update_engagement_quote",
    description: "Update quote/financial details on an engagement space item. Only provided fields are updated — omitted fields keep their current values. For line_items, pass the complete array (replaces existing). Much simpler than updating space_data manually.",
    schema: {
      item_id: z.string().describe("Work item ID or display key (e.g. \"MARTIN-94\")"),
      reference: z.string().optional().describe("Quote reference number"),
      date: z.string().optional().describe("Quote date (YYYY-MM-DD)"),
      expiry: z.string().optional().describe("Quote expiry date (YYYY-MM-DD)"),
      status: z.enum(["pending", "valid", "expired"]).optional().describe("Quote status"),
      total: z.number().optional().describe("Total amount"),
      currency: z.string().optional().describe("Currency code (e.g. AUD, USD, GBP)"),
      includes_gst: z.boolean().optional().describe("Whether the total includes GST"),
      line_items: z.array(z.object({
        desc: z.string().describe("Line item description"),
        amount: z.number().nullable().optional().describe("Line item amount"),
      })).optional().describe("Complete list of line items (replaces existing)"),
      payment_status: z.enum(["not_started", "deposit_paid", "in_progress", "final_paid"]).optional().describe("Payment status"),
    },
    handler: async (args, item) => {
      const data = parseEngagementSpaceData(item.space_data);

      if (args.reference !== undefined) data.quote.reference = String(args.reference);
      if (args.date !== undefined) data.quote.date = String(args.date);
      if (args.expiry !== undefined) data.quote.expiry = String(args.expiry);
      if (args.status !== undefined) data.quote.status = String(args.status);
      if (args.total !== undefined) data.quote.total = Number(args.total);
      if (args.currency !== undefined) data.quote.currency = String(args.currency);
      if (args.includes_gst !== undefined) data.quote.includes_gst = Boolean(args.includes_gst);
      if (args.line_items !== undefined) {
        data.quote.line_items = (args.line_items as Array<{ desc: string; amount?: number | null }>).map(li => ({
          desc: li.desc,
          amount: li.amount ?? null,
        }));
      }
      if (args.payment_status !== undefined) data.payment.status = String(args.payment_status);

      const updated = saveEngagementData(item.id, data);
      if (!updated) return { content: [{ type: "text" as const, text: "Error: Failed to update work item" }] };

      const q = data.quote;
      const sym = q.currency === "AUD" ? "$" : q.currency === "USD" ? "US$" : q.currency === "GBP" ? "\u00a3" : "$";
      return {
        content: [{
          type: "text" as const,
          text: `Updated quote/financial on ${getWorkItemKey(item)}.\n\nQuote: ${sym}${q.total.toFixed(2)} ${q.currency} (${q.status})${q.includes_gst ? " inc. GST" : " ex. GST"}\nPayment: ${data.payment.status}\nLine items: ${q.line_items.length}`,
        }],
      };
    },
  },
  {
    name: "tracker_add_engagement_milestone",
    description: "Add one or more milestones to an engagement space item. Each milestone has a label, optional date, and status.",
    schema: {
      item_id: z.string().describe("Work item ID or display key (e.g. \"MARTIN-94\")"),
      milestones: z.array(z.object({
        label: z.string().describe("Milestone label/description"),
        date: z.string().nullable().optional().describe("Milestone date (YYYY-MM-DD or free-form like \"Mar 15\")"),
        status: z.enum(["upcoming", "done", "overdue"]).optional().describe("Milestone status (default: upcoming)"),
      })).describe("Milestones to add"),
    },
    handler: async (args, item) => {
      const data = parseEngagementSpaceData(item.space_data);

      const newMilestones = (args.milestones as Array<{ label: string; date?: string | null; status?: string }>).map(ms => ({
        label: ms.label,
        date: ms.date ?? null,
        status: ms.status || "upcoming",
      }));
      data.milestones.push(...newMilestones);

      const updated = saveEngagementData(item.id, data);
      if (!updated) return { content: [{ type: "text" as const, text: "Error: Failed to update work item" }] };

      return {
        content: [{
          type: "text" as const,
          text: `Added ${newMilestones.length} milestone(s) to ${getWorkItemKey(item)}. Total: ${data.milestones.length}.\n\nCurrent milestones:\n${data.milestones.map((ms, i) => `  ${i}: [${ms.status}] ${ms.label}${ms.date ? " — " + ms.date : ""}`).join("\n")}`,
        }],
      };
    },
  },
  {
    name: "tracker_remove_engagement_milestone",
    description: "Remove milestones from an engagement space item by their index numbers. Use tracker_get_item first to see the current milestones and their indices.",
    schema: {
      item_id: z.string().describe("Work item ID or display key (e.g. \"MARTIN-94\")"),
      indices: z.array(z.number()).describe("Zero-based indices of milestones to remove. Use tracker_get_item to see the list and indices first."),
    },
    handler: async (args, item) => {
      const data = parseEngagementSpaceData(item.space_data);
      const indices = args.indices as number[];

      const invalidIndices = indices.filter(i => i < 0 || i >= data.milestones.length);
      if (invalidIndices.length > 0) {
        return { content: [{ type: "text" as const, text: `Error: Invalid indices: ${invalidIndices.join(", ")}. Milestones list has ${data.milestones.length} items (indices 0-${data.milestones.length - 1}).` }] };
      }

      const sortedIndices = [...indices].sort((a, b) => b - a);
      const removed: { label: string; date: string | null; status: string }[] = [];
      for (const idx of sortedIndices) {
        removed.push(data.milestones[idx]);
        data.milestones.splice(idx, 1);
      }

      const updated = saveEngagementData(item.id, data);
      if (!updated) return { content: [{ type: "text" as const, text: "Error: Failed to update work item" }] };

      return {
        content: [{
          type: "text" as const,
          text: `Removed ${removed.length} milestone(s) from ${getWorkItemKey(item)}. Remaining: ${data.milestones.length}.\n\nRemoved:\n${removed.map(ms => `  - [${ms.status}] ${ms.label}`).join("\n")}\n\nCurrent milestones:\n${data.milestones.length > 0 ? data.milestones.map((ms, i) => `  ${i}: [${ms.status}] ${ms.label}${ms.date ? " — " + ms.date : ""}`).join("\n") : "  (empty)"}`,
        }],
      };
    },
  },
  {
    name: "tracker_update_engagement_milestone",
    description: "Update existing milestones on an engagement space item. Specify the index and the fields to change.",
    schema: {
      item_id: z.string().describe("Work item ID or display key (e.g. \"MARTIN-94\")"),
      index: z.number().describe("Zero-based index of the milestone to update"),
      label: z.string().optional().describe("New milestone label"),
      date: z.string().nullable().optional().describe("New milestone date (YYYY-MM-DD or free-form). Pass null to clear."),
      status: z.enum(["upcoming", "done", "overdue"]).optional().describe("New milestone status"),
    },
    handler: async (args, item) => {
      const data = parseEngagementSpaceData(item.space_data);
      const index = args.index as number;

      if (index < 0 || index >= data.milestones.length) {
        return { content: [{ type: "text" as const, text: `Error: Invalid index ${index}. Milestones list has ${data.milestones.length} items (indices 0-${data.milestones.length - 1}).` }] };
      }

      const ms = data.milestones[index];
      if (args.label !== undefined) ms.label = String(args.label);
      if (args.date !== undefined) ms.date = args.date as string | null;
      if (args.status !== undefined) ms.status = String(args.status);

      const updated = saveEngagementData(item.id, data);
      if (!updated) return { content: [{ type: "text" as const, text: "Error: Failed to update work item" }] };

      return {
        content: [{
          type: "text" as const,
          text: `Updated milestone ${index} on ${getWorkItemKey(item)}.\n\nCurrent milestones:\n${data.milestones.map((m, i) => `  ${i}: [${m.status}] ${m.label}${m.date ? " — " + m.date : ""}`).join("\n")}`,
        }],
      };
    },
  },
  {
    name: "tracker_add_engagement_comms",
    description: "Add one or more communication log entries to an engagement space item. Use this to track emails, calls, and messages.",
    schema: {
      item_id: z.string().describe("Work item ID or display key (e.g. \"MARTIN-94\")"),
      entries: z.array(z.object({
        direction: z.enum(["inbound", "outbound"]).describe("Whether the communication was inbound (received) or outbound (sent)"),
        date: z.string().describe("Date of the communication (YYYY-MM-DD or free-form)"),
        subject: z.string().describe("Subject or brief description"),
        snippet: z.string().optional().describe("Short excerpt or summary of the content"),
      })).describe("Communication log entries to add"),
    },
    handler: async (args, item) => {
      const data = parseEngagementSpaceData(item.space_data);

      const newEntries = (args.entries as Array<{ direction: string; date: string; subject: string; snippet?: string }>).map(e => ({
        direction: e.direction,
        date: e.date,
        subject: e.subject,
        snippet: e.snippet || "",
      }));
      data.comms_log.push(...newEntries);

      const updated = saveEngagementData(item.id, data);
      if (!updated) return { content: [{ type: "text" as const, text: "Error: Failed to update work item" }] };

      return {
        content: [{
          type: "text" as const,
          text: `Added ${newEntries.length} comms log entry/entries to ${getWorkItemKey(item)}. Total entries: ${data.comms_log.length}.\n\nLatest entries:\n${data.comms_log.slice(-5).map((e) => `  ${e.direction === "outbound" ? "\u2191" : "\u2193"} ${e.date} \u2014 ${e.subject}`).join("\n")}`,
        }],
      };
    },
  },
  {
    name: "tracker_update_engagement_settings",
    description: "Update engagement settings (gmail_query, calendar_tag) on an engagement space item.",
    schema: {
      item_id: z.string().describe("Work item ID or display key (e.g. \"MARTIN-94\")"),
      gmail_query: z.string().optional().describe("Gmail search query for related emails (e.g. \"from:email OR to:email\")"),
      calendar_tag: z.string().optional().describe("Calendar tag for linking events"),
    },
    handler: async (args, item) => {
      const data = parseEngagementSpaceData(item.space_data);

      if (args.gmail_query !== undefined) data.gmail_query = String(args.gmail_query);
      if (args.calendar_tag !== undefined) data.calendar_tag = String(args.calendar_tag);

      const updated = saveEngagementData(item.id, data);
      if (!updated) return { content: [{ type: "text" as const, text: "Error: Failed to update work item" }] };

      return {
        content: [{
          type: "text" as const,
          text: `Updated engagement settings on ${getWorkItemKey(item)}.\n  Gmail query: ${data.gmail_query || "(not set)"}\n  Calendar tag: ${data.calendar_tag || "(not set)"}`,
        }],
      };
    },
  },
];

// ── Agent Reference ──

const ENGAGEMENT_AGENT_REFERENCE = `## Engagement Space

Manages contractors, services, and external engagements. All structured data is stored in \`space_data\` as a JSON blob:

\`\`\`json
{
  "contractor": { "company": "", "contact": "", "phone": "", "mobile": "", "email": "", "address": "" },
  "quote": { "reference": "", "date": "", "expiry": "", "status": "pending", "total": 0, "currency": "AUD", "includes_gst": true, "line_items": [{ "desc": "", "amount": 0 }] },
  "payment": { "status": "not_started", "deposits": [], "invoices": [] },
  "milestones": [{ "label": "", "date": "", "status": "upcoming|done|overdue" }],
  "gmail_query": "",
  "calendar_tag": "",
  "comms_log": [{ "direction": "inbound|outbound", "date": "2026-03-15", "subject": "Subject line", "snippet": "Brief excerpt" }]
}
\`\`\`

- **Cover image** → attachment named \`cover.jpg/png/webp\` (displayed as header)
- **Description** → item description field (general notes)
- **Discussion** → comments sidebar

### MCP Tools for Engagement

**Always use these dedicated tools** — they handle the GET-parse-modify-save cycle automatically.

| Tool | Description |
| --- | --- |
| \`tracker_update_engagement_contact\` | Update contact details — pass individual fields (\`company\`, \`contact\`, \`phone\`, \`mobile\`, \`email\`, \`address\`). Only provided fields are updated. |
| \`tracker_update_engagement_quote\` | Update quote/financial — pass individual fields (\`reference\`, \`total\`, \`currency\`, \`status\`, \`line_items\`, \`payment_status\`, \`date\`, \`expiry\`, \`includes_gst\`). Only provided fields are updated. |
| \`tracker_add_engagement_milestone\` | Add milestones — pass \`milestones\` array of \`{ label, date?, status? }\` objects. |
| \`tracker_remove_engagement_milestone\` | Remove milestones by index — pass \`indices\` array. Use \`tracker_get_item\` first to see current milestones. |
| \`tracker_update_engagement_milestone\` | Update a milestone — pass \`index\` and the fields to change (\`label\`, \`date\`, \`status\`). |
| \`tracker_add_engagement_comms\` | Add communication log entries — pass \`entries\` array of \`{ direction, date, subject, snippet? }\`. |
| \`tracker_update_engagement_settings\` | Update \`gmail_query\` and \`calendar_tag\`. |

### Examples

**Creating an engagement:**
\`\`\`
tracker_create_item(project_id="...", title="Contractor Name", space_type="engagement")
tracker_update_engagement_contact(item_id="...", company="Acme", contact="Jane", email="jane@acme.com")
tracker_update_engagement_quote(item_id="...", total=5000, currency="AUD", status="pending",
  line_items=[{desc: "Initial consultation", amount: 2000}, {desc: "Implementation", amount: 3000}])
\`\`\`

**Adding milestones:**
\`\`\`
tracker_add_engagement_milestone(item_id="...", milestones=[
  { label: "Initial meeting", date: "2026-03-20", status: "done" },
  { label: "Quote accepted", date: "2026-03-25", status: "upcoming" }
])
\`\`\`

**Logging communication:**
\`\`\`
tracker_add_engagement_comms(item_id="...", entries=[
  { direction: "outbound", date: "2026-03-15", subject: "Quote request", snippet: "Sent initial quote request for kitchen renovation" }
])
\`\`\``;

// ── Plugin Export ──

export const engagementPlugin: SpacePlugin = {
  name: "engagement",
  label: "Engagement",
  icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/><path d="M12 12v4M8 14h8"/></svg>',
  description: "Coordination workspace for contractors, services, and external engagements",

  capabilities: {
    coverImage: true,
    liveRefresh: true,
  },

  agentReference: ENGAGEMENT_AGENT_REFERENCE,

  defaultSpaceData: () => ({ ...DEFAULTS }),
  parseSpaceData: (raw) => parseEngagementSpaceData(raw) as unknown as Record<string, unknown>,

  apiRoutes: engagementApiRoutes,
  mcpTools: engagementMcpTools,
};
