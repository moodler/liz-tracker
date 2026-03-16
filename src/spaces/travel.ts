/**
 * Travel Space Plugin — Server-Side
 *
 * Provides: travelPlugin
 * Capabilities: coverImage, liveRefresh
 * API routes: PATCH /travel/trip, POST /travel/segments,
 *             PATCH /travel/segments, DELETE /travel/segments
 * MCP tools: tracker_update_travel_trip, tracker_add_travel_segment,
 *            tracker_update_travel_segment, tracker_remove_travel_segment
 * Dependencies: db.ts (getWorkItemKey, updateWorkItem)
 *
 * Trip planning workspace — day-by-day itinerary with timezone-aware segments,
 * gap detection, and Harmoni email parsing support.
 */

import crypto from "crypto";
import { z } from "zod";
import { getWorkItemKey, updateWorkItem } from "../db.js";
import type { SpacePlugin, SpaceApiRoute, SpaceMcpTool, WorkItem } from "./types.js";

// ── Data Layer ──

const SEGMENT_TYPES = ["flight", "lodging", "transport", "activity", "restaurant", "meeting", "note"] as const;
type SegmentType = (typeof SEGMENT_TYPES)[number];

const SEGMENT_STATUSES = ["confirmed", "pending", "cancelled"] as const;
type SegmentStatus = (typeof SEGMENT_STATUSES)[number];

interface TimePoint {
  datetime: string;
  timezone: string;
}

interface LocationTimePoint extends TimePoint {
  location: string;
  detail?: string;
}

interface Cost {
  amount: number;
  currency: string;
}

/** Common base fields shared by all segment types. */
interface SegmentBase {
  id: string;
  type: SegmentType;
  title: string;
  status: SegmentStatus;
  confirmation: string;
  provider: string;
  provider_url: string;
  cost: Cost | null;
  notes: string;
  address: string;
  location: string;
  tags: string[];
  image_url: string | null;
  source_email: string | null;
}

/** A single travel segment (union of base + type-specific fields). */
interface TravelSegment extends SegmentBase {
  // flight
  departure?: LocationTimePoint;
  arrival?: LocationTimePoint;
  flight_number?: string;
  seat?: string;
  cabin?: string;
  aircraft?: string;
  ticket_number?: string;
  // lodging
  check_in?: TimePoint;
  check_out?: TimePoint;
  property_type?: string;
  room_type?: string;
  // transport
  transport_type?: string;
  origin?: LocationTimePoint;
  destination?: LocationTimePoint;
  route_number?: string;
  car_type?: string;
  // activity
  activity_type?: string;
  start?: TimePoint;
  end?: TimePoint;
  duration_minutes?: number | null;
  venue?: string;
  // restaurant
  reservation?: TimePoint;
  cuisine?: string;
  party_size?: number | null;
  // meeting
  meeting_url?: string;
  attendees?: string;
  // note
  datetime?: TimePoint;
}

interface TripMeta {
  destination: string;
  purpose: string;
  travelers: string[];
  default_timezone: string;
  notes: string;
}

interface TravelSpaceData {
  trip: TripMeta;
  segments: TravelSegment[];
}

const TRIP_DEFAULTS: TripMeta = {
  destination: "",
  purpose: "",
  travelers: [],
  default_timezone: "",
  notes: "",
};

const SEGMENT_BASE_DEFAULTS: SegmentBase = {
  id: "",
  type: "note",
  title: "",
  status: "pending",
  confirmation: "",
  provider: "",
  provider_url: "",
  cost: null,
  notes: "",
  address: "",
  location: "",
  tags: [],
  image_url: null,
  source_email: null,
};

const DEFAULTS: TravelSpaceData = {
  trip: { ...TRIP_DEFAULTS },
  segments: [],
};

/** Generate a unique segment ID. */
function generateSegmentId(): string {
  return "seg_" + crypto.randomBytes(6).toString("hex");
}

/** Deep merge source into target. Objects are merged recursively; arrays and primitives are replaced. */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (
      sv && typeof sv === "object" && !Array.isArray(sv) &&
      tv && typeof tv === "object" && !Array.isArray(tv)
    ) {
      deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else {
      target[key] = sv;
    }
  }
  return target;
}

/** Parse the space_data JSON from a travel work item. */
function parseTravelSpaceData(raw: string | null): TravelSpaceData {
  if (!raw) return { trip: { ...TRIP_DEFAULTS }, segments: [] };
  try {
    const parsed = JSON.parse(raw);
    return {
      trip: { ...TRIP_DEFAULTS, ...(parsed.trip || {}) },
      segments: Array.isArray(parsed.segments) ? parsed.segments.map(normalizeSegment) : [],
    };
  } catch {
    return { trip: { ...TRIP_DEFAULTS }, segments: [] };
  }
}

/** Normalize a segment, applying defaults for missing fields. */
function normalizeSegment(seg: Record<string, unknown>): TravelSegment {
  const base: TravelSegment = {
    ...SEGMENT_BASE_DEFAULTS,
    id: (typeof seg.id === "string" && seg.id) ? seg.id : generateSegmentId(),
    type: SEGMENT_TYPES.includes(seg.type as SegmentType) ? (seg.type as SegmentType) : "note",
    title: String(seg.title || ""),
    status: SEGMENT_STATUSES.includes(seg.status as SegmentStatus) ? (seg.status as SegmentStatus) : "pending",
    confirmation: String(seg.confirmation || ""),
    provider: String(seg.provider || ""),
    provider_url: String(seg.provider_url || ""),
    cost: seg.cost && typeof seg.cost === "object" ? { amount: Number((seg.cost as Record<string, unknown>).amount) || 0, currency: String((seg.cost as Record<string, unknown>).currency || "AUD") } : null,
    notes: String(seg.notes || ""),
    address: String(seg.address || ""),
    location: String(seg.location || ""),
    tags: Array.isArray(seg.tags) ? seg.tags.map(String) : [],
    image_url: seg.image_url ? String(seg.image_url) : null,
    source_email: seg.source_email ? String(seg.source_email) : null,
  };

  // Copy type-specific fields through
  const typeFields = [
    "departure", "arrival", "flight_number", "seat", "cabin", "aircraft", "ticket_number",
    "check_in", "check_out", "property_type", "room_type",
    "transport_type", "origin", "destination", "route_number", "car_type",
    "activity_type", "start", "end", "duration_minutes", "venue",
    "reservation", "cuisine", "party_size",
    "meeting_url", "attendees",
    "datetime",
  ];
  for (const field of typeFields) {
    if (seg[field] !== undefined) {
      (base as unknown as Record<string, unknown>)[field] = seg[field];
    }
  }

  return base;
}

/** Sanitize space_data JSON for travel items. */
function sanitizeTravelSpaceData(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return raw;

    // Ensure trip exists
    if (!parsed.trip || typeof parsed.trip !== "object") {
      parsed.trip = { ...TRIP_DEFAULTS };
    }
    if (parsed.trip.travelers && !Array.isArray(parsed.trip.travelers)) {
      parsed.trip.travelers = [];
    }

    // Ensure segments is an array with valid IDs and types
    if (!Array.isArray(parsed.segments)) {
      parsed.segments = [];
    }
    parsed.segments = parsed.segments.map((seg: Record<string, unknown>) => {
      if (!seg.id || typeof seg.id !== "string") seg.id = generateSegmentId();
      if (!SEGMENT_TYPES.includes(seg.type as SegmentType)) seg.type = "note";
      if (!SEGMENT_STATUSES.includes(seg.status as SegmentStatus)) seg.status = "pending";
      if (seg.tags && !Array.isArray(seg.tags)) seg.tags = [];
      if (seg.cost && typeof seg.cost === "object") {
        const cost = seg.cost as Record<string, unknown>;
        seg.cost = { amount: Number(cost.amount) || 0, currency: String(cost.currency || "AUD") };
      }
      return seg;
    });

    return JSON.stringify(parsed);
  } catch {
    return raw;
  }
}

/** Save updated space_data back to a travel work item. */
function saveTravelData(itemId: string, data: TravelSpaceData) {
  return updateWorkItem(itemId, { space_data: JSON.stringify(data) });
}

// ── HTTP Helpers ──

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

const travelApiRoutes: SpaceApiRoute[] = [
  // PATCH /items/:id/travel/trip — update trip metadata
  {
    method: "PATCH",
    path: "trip",
    handler: async (req, res, item) => {
      const body = await parseRequestBody(req);
      const spaceData = parseTravelSpaceData(item.space_data);

      if (body.destination !== undefined) spaceData.trip.destination = String(body.destination);
      if (body.purpose !== undefined) spaceData.trip.purpose = String(body.purpose);
      if (body.travelers !== undefined && Array.isArray(body.travelers)) {
        spaceData.trip.travelers = (body.travelers as unknown[]).map(String);
      }
      if (body.default_timezone !== undefined) spaceData.trip.default_timezone = String(body.default_timezone);
      if (body.notes !== undefined) spaceData.trip.notes = String(body.notes);

      const updated = saveTravelData(item.id, spaceData);
      if (!updated) return errorResponse(res, "Failed to update work item", 500);
      jsonResponse(res, { trip: spaceData.trip });
    },
  },
  // POST /items/:id/travel/segments — add segments
  {
    method: "POST",
    path: "segments",
    handler: async (req, res, item) => {
      const body = await parseRequestBody(req);
      if (!body.segments || !Array.isArray(body.segments)) {
        return errorResponse(res, "segments (array of objects) is required");
      }

      const spaceData = parseTravelSpaceData(item.space_data);
      const added: TravelSegment[] = [];

      for (const rawSeg of body.segments as Record<string, unknown>[]) {
        // Dedup: check for existing segment with same confirmation + provider
        const conf = String(rawSeg.confirmation || "");
        const prov = String(rawSeg.provider || "");
        if (conf && prov) {
          const existing = spaceData.segments.find(
            s => s.confirmation === conf && s.provider === prov
          );
          if (existing) {
            // Update existing instead of adding duplicate
            deepMerge(existing as unknown as Record<string, unknown>, rawSeg);
            added.push(existing);
            continue;
          }
        }

        const seg = normalizeSegment(rawSeg);
        if (!seg.id || seg.id === SEGMENT_BASE_DEFAULTS.id) seg.id = generateSegmentId();
        spaceData.segments.push(seg);
        added.push(seg);
      }

      const updated = saveTravelData(item.id, spaceData);
      if (!updated) return errorResponse(res, "Failed to update work item", 500);
      jsonResponse(res, { segments: spaceData.segments, added: added.length, total: spaceData.segments.length });
    },
  },
  // PATCH /items/:id/travel/segments — update a segment by ID (deep merge)
  {
    method: "PATCH",
    path: "segments",
    handler: async (req, res, item) => {
      const body = await parseRequestBody(req);
      const segId = body.id;
      if (!segId || typeof segId !== "string") {
        return errorResponse(res, "id (segment ID string) is required in body");
      }

      const spaceData = parseTravelSpaceData(item.space_data);
      const seg = spaceData.segments.find(s => s.id === segId);
      if (!seg) {
        return errorResponse(res, `Segment "${segId}" not found`, 404);
      }

      // Deep merge the update into the existing segment
      const { id: _id, ...changes } = body;
      deepMerge(seg as unknown as Record<string, unknown>, changes as Record<string, unknown>);

      // Re-validate type and status after merge
      if (!SEGMENT_TYPES.includes(seg.type)) seg.type = "note";
      if (!SEGMENT_STATUSES.includes(seg.status)) seg.status = "pending";

      const updated = saveTravelData(item.id, spaceData);
      if (!updated) return errorResponse(res, "Failed to update work item", 500);
      jsonResponse(res, { segment: seg });
    },
  },
  // DELETE /items/:id/travel/segments — remove segments by IDs
  {
    method: "DELETE",
    path: "segments",
    handler: async (req, res, item) => {
      const body = await parseRequestBody(req);
      if (!body.ids || !Array.isArray(body.ids)) {
        return errorResponse(res, "ids (array of segment ID strings) is required");
      }

      const spaceData = parseTravelSpaceData(item.space_data);
      const ids = new Set((body.ids as unknown[]).map(String));
      const before = spaceData.segments.length;
      spaceData.segments = spaceData.segments.filter(s => !ids.has(s.id));
      const removed = before - spaceData.segments.length;

      if (removed === 0) {
        return errorResponse(res, "No matching segments found for the provided IDs", 404);
      }

      const updated = saveTravelData(item.id, spaceData);
      if (!updated) return errorResponse(res, "Failed to update work item", 500);
      jsonResponse(res, { removed, total: spaceData.segments.length });
    },
  },
];

// ── MCP Tools ──

const travelMcpTools: SpaceMcpTool[] = [
  {
    name: "tracker_update_travel_trip",
    description: "Update trip metadata on a travel space item (destination, purpose, travelers, default_timezone, notes). Only provided fields are updated.",
    schema: {
      item_id: z.string().describe("Work item ID or display key (e.g. \"TRACK-99\")"),
      destination: z.string().optional().describe("Trip destination (e.g. \"Tokyo, Japan\")"),
      purpose: z.string().optional().describe("Trip purpose (e.g. \"business\", \"leisure\")"),
      travelers: z.array(z.string()).optional().describe("List of traveler names"),
      default_timezone: z.string().optional().describe("Default IANA timezone (e.g. \"Asia/Tokyo\")"),
      notes: z.string().optional().describe("Trip notes"),
    },
    handler: async (args, item) => {
      const data = parseTravelSpaceData(item.space_data);

      if (args.destination !== undefined) data.trip.destination = String(args.destination);
      if (args.purpose !== undefined) data.trip.purpose = String(args.purpose);
      if (args.travelers !== undefined) data.trip.travelers = (args.travelers as string[]).map(String);
      if (args.default_timezone !== undefined) data.trip.default_timezone = String(args.default_timezone);
      if (args.notes !== undefined) data.trip.notes = String(args.notes);

      const updated = saveTravelData(item.id, data);
      if (!updated) return { content: [{ type: "text" as const, text: "Error: Failed to update work item" }] };

      const t = data.trip;
      const summary = [
        t.destination && `Destination: ${t.destination}`,
        t.purpose && `Purpose: ${t.purpose}`,
        t.travelers.length > 0 && `Travelers: ${t.travelers.join(", ")}`,
        t.default_timezone && `Timezone: ${t.default_timezone}`,
      ].filter(Boolean).join("\n  ");

      return {
        content: [{
          type: "text" as const,
          text: `Updated trip metadata on ${getWorkItemKey(item)}.\n\nTrip:\n  ${summary || "(empty)"}`,
        }],
      };
    },
  },
  {
    name: "tracker_add_travel_segment",
    description: "Add one or more segments to a travel itinerary. Auto-generates segment IDs. Deduplicates by confirmation+provider (updates existing if found). Each segment needs at minimum: type and title.",
    schema: {
      item_id: z.string().describe("Work item ID or display key"),
      segments: z.array(z.record(z.unknown())).describe("Array of segment objects. Required fields: type, title. Optional: status, confirmation, provider, departure/arrival (for flights), check_in/check_out (for lodging), etc."),
    },
    handler: async (args, item) => {
      const data = parseTravelSpaceData(item.space_data);
      const rawSegments = args.segments as Record<string, unknown>[];
      const added: string[] = [];

      for (const rawSeg of rawSegments) {
        const conf = String(rawSeg.confirmation || "");
        const prov = String(rawSeg.provider || "");
        if (conf && prov) {
          const existing = data.segments.find(
            s => s.confirmation === conf && s.provider === prov
          );
          if (existing) {
            deepMerge(existing as unknown as Record<string, unknown>, rawSeg);
            added.push(`Updated: ${existing.title} (dedup)`);
            continue;
          }
        }

        const seg = normalizeSegment(rawSeg);
        if (!seg.id) seg.id = generateSegmentId();
        data.segments.push(seg);
        added.push(`Added: ${seg.title}`);
      }

      const updated = saveTravelData(item.id, data);
      if (!updated) return { content: [{ type: "text" as const, text: "Error: Failed to update work item" }] };

      return {
        content: [{
          type: "text" as const,
          text: `Processed ${added.length} segment(s) on ${getWorkItemKey(item)}. Total segments: ${data.segments.length}.\n\n${added.join("\n")}`,
        }],
      };
    },
  },
  {
    name: "tracker_update_travel_segment",
    description: "Update a travel segment by its ID. Uses deep merge — nested objects (departure, arrival, etc.) are merged recursively, so you can update just departure.detail without affecting departure.datetime or departure.timezone.",
    schema: {
      item_id: z.string().describe("Work item ID or display key"),
      segment_id: z.string().describe("Segment ID (e.g. \"seg_abc123\")"),
      changes: z.record(z.unknown()).describe("Fields to update. Supports deep merge for nested objects like departure, arrival, cost, etc."),
    },
    handler: async (args, item) => {
      const data = parseTravelSpaceData(item.space_data);
      const segId = String(args.segment_id);
      const seg = data.segments.find(s => s.id === segId);

      if (!seg) {
        return { content: [{ type: "text" as const, text: `Error: Segment "${segId}" not found. Available IDs: ${data.segments.map(s => s.id).join(", ") || "(none)"}` }] };
      }

      const changes = args.changes as Record<string, unknown>;
      deepMerge(seg as unknown as Record<string, unknown>, changes);

      // Re-validate after merge
      if (!SEGMENT_TYPES.includes(seg.type)) seg.type = "note";
      if (!SEGMENT_STATUSES.includes(seg.status)) seg.status = "pending";

      const updated = saveTravelData(item.id, data);
      if (!updated) return { content: [{ type: "text" as const, text: "Error: Failed to update work item" }] };

      return {
        content: [{
          type: "text" as const,
          text: `Updated segment "${seg.title}" (${seg.id}) on ${getWorkItemKey(item)}.\n\nType: ${seg.type}\nStatus: ${seg.status}\nProvider: ${seg.provider || "—"}\nConfirmation: ${seg.confirmation || "—"}`,
        }],
      };
    },
  },
  {
    name: "tracker_remove_travel_segment",
    description: "Remove one or more segments from a travel itinerary by their IDs.",
    schema: {
      item_id: z.string().describe("Work item ID or display key"),
      ids: z.array(z.string()).describe("Segment IDs to remove"),
    },
    handler: async (args, item) => {
      const data = parseTravelSpaceData(item.space_data);
      const ids = new Set((args.ids as string[]).map(String));
      const before = data.segments.length;
      const removed = data.segments.filter(s => ids.has(s.id));
      data.segments = data.segments.filter(s => !ids.has(s.id));

      if (removed.length === 0) {
        return { content: [{ type: "text" as const, text: `Error: No matching segments found. Available IDs: ${data.segments.map(s => s.id).join(", ") || "(none)"}` }] };
      }

      const updated = saveTravelData(item.id, data);
      if (!updated) return { content: [{ type: "text" as const, text: "Error: Failed to update work item" }] };

      return {
        content: [{
          type: "text" as const,
          text: `Removed ${removed.length} segment(s) from ${getWorkItemKey(item)}. Remaining: ${data.segments.length}.\n\nRemoved:\n${removed.map(s => `  - ${s.title} (${s.type})`).join("\n")}`,
        }],
      };
    },
  },
];

// ── Plugin Export ──

export const travelPlugin: SpacePlugin = {
  name: "travel",
  label: "Travel",
  icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></svg>',
  description: "Trip planning workspace with day-by-day itinerary",

  capabilities: {
    coverImage: true,
    liveRefresh: true,
  },

  defaultSpaceData: () => ({ ...DEFAULTS }),
  parseSpaceData: (raw) => parseTravelSpaceData(raw) as unknown as Record<string, unknown>,
  sanitizeSpaceData: (raw) => sanitizeTravelSpaceData(raw),

  apiRoutes: travelApiRoutes,
  mcpTools: travelMcpTools,
};
