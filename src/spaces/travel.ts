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

/** Build the composite dedup key for a segment.
 *  Flights include flight_number, lodging/transport include title,
 *  all others use confirmation+provider only.
 *  Returns null if confirmation or provider is missing (no dedup). */
function dedupKey(seg: Record<string, unknown>): string | null {
  const conf = String(seg.confirmation || "");
  const prov = String(seg.provider || "");
  if (!conf || !prov) return null;

  const type = String(seg.type || "");
  let extra = "";
  if (type === "flight") {
    extra = String(seg.flight_number || "");
  } else if (type === "lodging" || type === "transport") {
    extra = String(seg.title || "");
  }
  return extra ? `${conf}\0${prov}\0${extra}` : `${conf}\0${prov}`;
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

// ── Coercion: Map Common Aliases and Fix Malformed Data ──
// Agents (especially Harmoni) sometimes bypass the MCP tools and write raw space_data
// with wrong field names, flat date strings instead of TimePoint objects, etc.
// This coercion layer gracefully handles those cases.

/** Map of type aliases to canonical SEGMENT_TYPES values. */
const TYPE_ALIASES: Record<string, SegmentType> = {
  layover: "activity",
  stopover: "activity",
  transfer: "transport",
  taxi: "transport",
  shuttle: "transport",
  train: "transport",
  bus: "transport",
  ferry: "transport",
  car_rental: "transport",
  rideshare: "transport",
  hotel: "lodging",
  airbnb: "lodging",
  hostel: "lodging",
  resort: "lodging",
  accommodation: "lodging",
  tour: "activity",
  excursion: "activity",
  museum: "activity",
  show: "activity",
  concert: "activity",
  sightseeing: "activity",
  dining: "restaurant",
  meal: "restaurant",
  lunch: "restaurant",
  dinner: "restaurant",
  breakfast: "restaurant",
  reminder: "note",
  info: "note",
  visa: "note",
};

/** Map of status aliases to canonical SEGMENT_STATUSES values. */
const STATUS_ALIASES: Record<string, SegmentStatus> = {
  booked: "confirmed",
  reserved: "confirmed",
  active: "confirmed",
  tentative: "pending",
  unconfirmed: "pending",
  waitlisted: "pending",
  canceled: "cancelled",
};

/**
 * Parse an ISO datetime string (possibly with timezone offset) into a TimePoint.
 * Handles formats like:
 *   "2026-03-22T06:40:00+08:00" → { datetime: "2026-03-22T06:40", timezone: "Etc/GMT-8" }
 *   "2026-03-22T06:40" → { datetime: "2026-03-22T06:40", timezone: defaultTz }
 *   "2026-03-22" → { datetime: "2026-03-22T00:00", timezone: defaultTz }
 */
function parseIsoToTimePoint(value: unknown, defaultTz: string): TimePoint | null {
  if (!value) return null;
  // Already a TimePoint object
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.datetime === "string" && typeof obj.timezone === "string") {
      return value as TimePoint;
    }
  }
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s) return null;

  // Try to parse offset from ISO string like "2026-03-22T06:40:00+08:00"
  const offsetMatch = s.match(/([+-])(\d{2}):?(\d{2})$/);
  let datetime = s;
  let timezone = defaultTz;

  if (offsetMatch) {
    // Strip offset from datetime, keep just the local time portion
    datetime = s.replace(/[+-]\d{2}:?\d{2}$/, "");
    // Convert offset to Etc/GMT timezone (note: Etc/GMT sign is inverted)
    const sign = offsetMatch[1];
    const hours = parseInt(offsetMatch[2], 10);
    const minutes = parseInt(offsetMatch[3], 10);
    if (minutes === 0) {
      // Etc/GMT+N means UTC-N (inverted!)
      timezone = `Etc/GMT${sign === "+" ? "-" : "+"}${hours}`;
    } else {
      // For non-whole-hour offsets, we can't use Etc/GMT — keep default
      timezone = defaultTz;
    }
  }

  // Strip seconds if present ("2026-03-22T06:40:00" → "2026-03-22T06:40")
  datetime = datetime.replace(/:\d{2}(\.\d+)?$/, "");

  // If just a date "2026-03-22", add a default time
  if (/^\d{4}-\d{2}-\d{2}$/.test(datetime)) {
    datetime = datetime + "T00:00";
  }

  // Validate the format
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(datetime)) {
    return null;
  }

  return { datetime, timezone };
}

/** Parse a value into a LocationTimePoint, extracting location if present. */
function parseIsoToLocationTimePoint(value: unknown, defaultTz: string, locationHint?: string): LocationTimePoint | null {
  // Already a LocationTimePoint object
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.datetime === "string" && typeof obj.timezone === "string") {
      return {
        datetime: String(obj.datetime),
        timezone: String(obj.timezone),
        location: String(obj.location || locationHint || ""),
        detail: obj.detail ? String(obj.detail) : undefined,
      };
    }
  }
  const tp = parseIsoToTimePoint(value, defaultTz);
  if (!tp) return null;
  return { ...tp, location: locationHint || "" };
}

/**
 * Coerce a malformed segment into the correct structure.
 * Maps common field aliases and converts flat strings to TimePoint objects.
 * This is the key resilience layer — it handles data written by agents
 * that bypassed the MCP tools and wrote raw space_data.
 */
function coerceSegment(seg: Record<string, unknown>, tripDefaultTz: string): Record<string, unknown> {
  const result: Record<string, unknown> = { ...seg };
  const defaultTz = tripDefaultTz || "UTC";

  // Map field aliases for common base fields
  if (!result.provider && result.carrier) { result.provider = result.carrier; delete result.carrier; }
  if (!result.provider && result.airline) { result.provider = result.airline; delete result.airline; }
  if (!result.provider && result.operator) { result.provider = result.operator; delete result.operator; }
  if (!result.confirmation && result.booking_ref) { result.confirmation = result.booking_ref; delete result.booking_ref; }
  if (!result.title && result.restaurant_name) { result.title = result.restaurant_name; delete result.restaurant_name; }
  if (!result.title && result.property_name) { result.title = result.property_name; delete result.property_name; }
  if (!result.notes && typeof result.text === "string") { result.notes = result.text; delete result.text; }

  // Resolve type aliases
  const rawType = String(result.type || "note").toLowerCase();
  if (!SEGMENT_TYPES.includes(rawType as SegmentType)) {
    result.type = TYPE_ALIASES[rawType] || "note";
  }

  // Resolve status aliases
  const rawStatus = String(result.status || "pending").toLowerCase();
  if (!SEGMENT_STATUSES.includes(rawStatus as SegmentStatus)) {
    result.status = STATUS_ALIASES[rawStatus] || "pending";
  }

  const type = String(result.type);

  // ── Flight-specific coercion ──
  if (type === "flight") {
    // Map flat departure/arrival fields to LocationTimePoint objects
    if (!isTimePointObject(result.departure)) {
      const dt = result.departure_time || result.depart_time || result.departure_datetime;
      const loc = result.departure_location || result.depart_location || result.from_airport || result.from;
      const detail = result.departure_terminal || result.departure_gate || result.departure_detail;
      const tp = parseIsoToLocationTimePoint(dt, defaultTz, extractLocationCode(loc));
      if (tp) {
        if (detail) tp.detail = String(detail);
        result.departure = tp;
      }
      // Clean up flat fields
      for (const k of ["departure_time", "depart_time", "departure_datetime", "departure_location",
        "depart_location", "from_airport", "from", "departure_terminal", "departure_gate", "departure_detail"]) {
        delete result[k];
      }
    }
    if (!isTimePointObject(result.arrival)) {
      const dt = result.arrival_time || result.arrive_time || result.arrival_datetime;
      const loc = result.arrival_location || result.arrive_location || result.to_airport || result.to;
      const detail = result.arrival_terminal || result.arrival_gate || result.arrival_detail;
      const tp = parseIsoToLocationTimePoint(dt, defaultTz, extractLocationCode(loc));
      if (tp) {
        if (detail) tp.detail = String(detail);
        result.arrival = tp;
      }
      for (const k of ["arrival_time", "arrive_time", "arrival_datetime", "arrival_location",
        "arrive_location", "to_airport", "to", "arrival_terminal", "arrival_gate", "arrival_detail"]) {
        delete result[k];
      }
    }
    // Map flight_number from flight alias
    if (!result.flight_number && result.flight) { result.flight_number = result.flight; delete result.flight; }
  }

  // ── Lodging-specific coercion ──
  if (type === "lodging") {
    if (!isTimePointObject(result.check_in)) {
      const tp = parseIsoToTimePoint(result.check_in || result.checkin || result.check_in_date, defaultTz);
      if (tp) result.check_in = tp;
      for (const k of ["checkin", "check_in_date"]) delete result[k];
    }
    if (!isTimePointObject(result.check_out)) {
      const tp = parseIsoToTimePoint(result.check_out || result.checkout || result.check_out_date, defaultTz);
      if (tp) result.check_out = tp;
      for (const k of ["checkout", "check_out_date"]) delete result[k];
    }
  }

  // ── Transport-specific coercion ──
  if (type === "transport") {
    if (!isTimePointObject(result.origin)) {
      const dt = result.departure_time || result.origin_time || result.origin_datetime;
      const loc = result.departure_location || result.origin_location || result.from;
      const tp = parseIsoToLocationTimePoint(dt, defaultTz, extractLocationCode(loc));
      if (tp) result.origin = tp;
      for (const k of ["departure_time", "origin_time", "origin_datetime", "departure_location",
        "origin_location", "from"]) delete result[k];
    }
    if (!isTimePointObject(result.destination)) {
      const dt = result.arrival_time || result.destination_time || result.destination_datetime;
      const loc = result.arrival_location || result.destination_location || result.to;
      const tp = parseIsoToLocationTimePoint(dt, defaultTz, extractLocationCode(loc));
      if (tp) result.destination = tp;
      for (const k of ["arrival_time", "destination_time", "destination_datetime", "arrival_location",
        "destination_location", "to"]) delete result[k];
    }
    // Map transport subtype aliases to transport_type field
    if (!result.transport_type && TYPE_ALIASES[rawType] === "transport" && rawType !== "transport") {
      result.transport_type = rawType;
    }
  }

  // ── Activity-specific coercion ──
  if (type === "activity") {
    if (!isTimePointObject(result.start)) {
      let dt = result.start_time || result.start_datetime;
      const dateFallback = result.date;
      // Handle "HH:MM" time + separate "YYYY-MM-DD" date
      if (typeof dt === "string" && /^\d{2}:\d{2}$/.test(dt as string) && typeof dateFallback === "string") {
        dt = dateFallback + "T" + dt;
      }
      const tp = parseIsoToTimePoint(dt || dateFallback, defaultTz);
      if (tp) result.start = tp;
      for (const k of ["start_time", "start_datetime"]) delete result[k];
    }
    if (!isTimePointObject(result.end)) {
      let dt = result.end_time || result.end_datetime;
      const dateFallback = result.date;
      // Handle "HH:MM" time + separate "YYYY-MM-DD" date
      if (typeof dt === "string" && /^\d{2}:\d{2}$/.test(dt as string) && typeof dateFallback === "string") {
        dt = dateFallback + "T" + dt;
      }
      const tp = parseIsoToTimePoint(dt, defaultTz);
      if (tp) result.end = tp;
      for (const k of ["end_time", "end_datetime"]) delete result[k];
    }
    // Map activity subtype aliases
    if (!result.activity_type && TYPE_ALIASES[rawType] === "activity" && rawType !== "activity") {
      result.activity_type = rawType;
    }
  }

  // ── Restaurant-specific coercion ──
  if (type === "restaurant") {
    if (!isTimePointObject(result.reservation)) {
      const dt = result.reservation_time || result.reservation_datetime || result.date;
      const tp = parseIsoToTimePoint(dt, defaultTz);
      if (tp) result.reservation = tp;
      for (const k of ["reservation_time", "reservation_datetime"]) delete result[k];
    }
  }

  // ── Meeting-specific coercion ──
  if (type === "meeting") {
    if (!isTimePointObject(result.start)) {
      let dt = result.start_time || result.start_datetime;
      const dateFallback = result.date;
      if (typeof dt === "string" && /^\d{2}:\d{2}$/.test(dt as string) && typeof dateFallback === "string") {
        dt = dateFallback + "T" + dt;
      }
      const tp = parseIsoToTimePoint(dt || dateFallback, defaultTz);
      if (tp) result.start = tp;
      for (const k of ["start_time", "start_datetime"]) delete result[k];
    }
    if (!isTimePointObject(result.end)) {
      let dt = result.end_time || result.end_datetime;
      const dateFallback = result.date;
      if (typeof dt === "string" && /^\d{2}:\d{2}$/.test(dt as string) && typeof dateFallback === "string") {
        dt = dateFallback + "T" + dt;
      }
      const tp = parseIsoToTimePoint(dt, defaultTz);
      if (tp) result.end = tp;
      for (const k of ["end_time", "end_datetime"]) delete result[k];
    }
  }

  // ── Note-specific coercion ──
  if (type === "note") {
    if (!isTimePointObject(result.datetime)) {
      const dt = result.date || result.date_time;
      const tp = parseIsoToTimePoint(dt, defaultTz);
      if (tp) result.datetime = tp;
      for (const k of ["date_time"]) delete result[k];
    }
  }

  // Clean up the generic "date" field if it was consumed by coercion above
  // Only delete if it's a simple date string (not an object) — type-specific handlers may have used it
  if (typeof result.date === "string" && result.date.match(/^\d{4}-\d{2}-\d{2}$/)) {
    delete result.date;
  }

  return result;
}

/** Check if a value is already a TimePoint object (has datetime + timezone strings). */
function isTimePointObject(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.datetime === "string" && typeof obj.timezone === "string";
}

/** Extract a short location code from a string like "Perth (PER)" or "Singapore (SIN T3)". */
function extractLocationCode(value: unknown): string {
  if (!value || typeof value !== "string") return "";
  // Try to find an IATA-like code in parentheses: "Perth (PER)" → "PER"
  const match = String(value).match(/\((\w{3})\b/);
  if (match) return match[1];
  // Otherwise just return the raw string (truncated for display)
  return String(value).slice(0, 40);
}

/** Parse the space_data JSON from a travel work item. */
function parseTravelSpaceData(raw: string | null): TravelSpaceData {
  if (!raw) return { trip: { ...TRIP_DEFAULTS }, segments: [] };
  try {
    const parsed = JSON.parse(raw);
    const trip = { ...TRIP_DEFAULTS, ...(parsed.trip || {}) };
    const defaultTz = trip.default_timezone || "UTC";
    return {
      trip,
      segments: Array.isArray(parsed.segments)
        ? parsed.segments.map((s: Record<string, unknown>) => normalizeSegment(coerceSegment(s, defaultTz)))
        : [],
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

/**
 * Sanitize space_data JSON for travel items.
 * This runs on EVERY write to space_data (via tracker_update_item, API PATCH, etc.).
 * It performs full coercion + normalization to fix malformed data from agents that
 * bypassed the dedicated MCP tools.
 */
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

    const defaultTz = parsed.trip.default_timezone || "UTC";

    // Ensure segments is an array, then fully coerce + normalize each one
    if (!Array.isArray(parsed.segments)) {
      parsed.segments = [];
    }
    parsed.segments = parsed.segments.map((seg: Record<string, unknown>) => {
      // Full coercion pipeline: map aliases → fix datetime formats → normalize
      const coerced = coerceSegment(seg, defaultTz);
      return normalizeSegment(coerced);
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
      const defaultTz = spaceData.trip.default_timezone || "UTC";
      const added: TravelSegment[] = [];

      for (const rawSeg of body.segments as Record<string, unknown>[]) {
        // Coerce malformed data before processing
        const coerced = coerceSegment(rawSeg, defaultTz);
        // Dedup: check for existing segment with same composite key
        // (confirmation+provider, plus flight_number for flights, title for lodging/transport)
        const newKey = dedupKey(coerced);
        if (newKey) {
          const existing = spaceData.segments.find(
            s => dedupKey(s as unknown as Record<string, unknown>) === newKey
          );
          if (existing) {
            // Update existing instead of adding duplicate
            deepMerge(existing as unknown as Record<string, unknown>, coerced);
            added.push(existing);
            continue;
          }
        }

        const seg = normalizeSegment(coerced);
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
    description: "Update trip metadata on a travel space item. Only provided fields are updated. Use this to set the destination, purpose, travelers, and default timezone for the trip.",
    schema: {
      item_id: z.string().describe("Work item ID or display key (e.g. \"MARTIN-96\")"),
      destination: z.string().optional().describe("Trip destination (e.g. \"Tokyo, Japan\" or \"Shenzhen → Suzhou → Guangzhou\")"),
      purpose: z.string().optional().describe("Trip purpose (e.g. \"business\", \"leisure\", \"conference + tech visit\")"),
      travelers: z.array(z.string()).optional().describe("List of traveler names (e.g. [\"Martin\"])"),
      default_timezone: z.string().optional().describe("Default IANA timezone for the trip (e.g. \"Asia/Tokyo\", \"Asia/Shanghai\", \"Australia/Perth\")"),
      notes: z.string().optional().describe("Trip notes (free text — meal preferences, seat preferences, visa info, etc.)"),
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
    description: `Add one or more segments to a travel itinerary. Auto-generates segment IDs. Deduplicates by confirmation+provider, with type-specific disambiguation: flights also match on flight_number, lodging/transport also match on title. Falls back to confirmation+provider only when the extra field is absent.

IMPORTANT: Datetimes must use the TimePoint/LocationTimePoint format — NOT flat strings.

Segment types and their key fields:

FLIGHT: { type: "flight", title: "QF21 SYD→NRT", provider: "Qantas", confirmation: "ABC123", status: "confirmed", departure: { datetime: "2026-04-15T21:00", timezone: "Australia/Sydney", location: "SYD", detail: "Terminal 1" }, arrival: { datetime: "2026-04-16T06:00", timezone: "Asia/Tokyo", location: "NRT", detail: "Terminal 2" }, flight_number: "QF 21", seat: "34A", cabin: "business", ticket_number: "618-123456" }

LODGING: { type: "lodging", title: "Park Hyatt Tokyo", provider: "Park Hyatt", confirmation: "9169182", status: "confirmed", location: "Shinjuku, Tokyo", address: "3-7-1-2 Nishi Shinjuku", check_in: { datetime: "2026-04-15T15:00", timezone: "Asia/Tokyo" }, check_out: { datetime: "2026-04-18T11:00", timezone: "Asia/Tokyo" }, property_type: "hotel", room_type: "Deluxe King" }

ACTIVITY: { type: "activity", title: "MoodleMoot China 2026", location: "XJTLU, Suzhou", start: { datetime: "2026-03-26T08:00", timezone: "Asia/Shanghai" }, end: { datetime: "2026-03-26T22:00", timezone: "Asia/Shanghai" }, activity_type: "conference", venue: "XJTLU Campus" }

TRANSPORT: { type: "transport", title: "Transfer WUX→XJTLU", transport_type: "shuttle", origin: { datetime: "2026-03-25T11:00", timezone: "Asia/Shanghai", location: "Wuxi Airport" }, destination: { datetime: "2026-03-25T14:00", timezone: "Asia/Shanghai", location: "XJTLU Campus" } }

RESTAURANT: { type: "restaurant", title: "Sushi Saito", location: "Minato, Tokyo", reservation: { datetime: "2026-04-16T19:00", timezone: "Asia/Tokyo" }, cuisine: "Japanese", party_size: 2 }

MEETING: { type: "meeting", title: "Client meeting", location: "Tokyo Office", start: { datetime: "2026-04-17T10:00", timezone: "Asia/Tokyo" }, end: { datetime: "2026-04-17T11:30", timezone: "Asia/Tokyo" } }

NOTE: { type: "note", title: "Visa reminder", datetime: { datetime: "2026-04-14T09:00", timezone: "Australia/Sydney" }, notes: "Check visa requirements" }

Common fields on ALL segments: type, title, status (confirmed/pending/cancelled), confirmation, provider, provider_url, cost ({amount, currency}), notes, address, location, tags ([]), image_url, source_email.

RESILIENCE: The tool auto-corrects common mistakes: "carrier"→"provider", "booking_ref"→"confirmation", "booked"→"confirmed", "layover"→"activity". ISO datetime strings like "2026-03-22T06:40:00+08:00" are parsed into TimePoint format. However, using the correct format above is strongly preferred.`,
    schema: {
      item_id: z.string().describe("Work item ID or display key (e.g. \"MARTIN-96\")"),
      segments: z.array(z.record(z.unknown())).describe("Array of segment objects. Each must have 'type' (flight/lodging/transport/activity/restaurant/meeting/note) and 'title'. Datetimes use { datetime: \"YYYY-MM-DDTHH:MM\", timezone: \"IANA/Timezone\" } format. Flights need departure/arrival as { datetime, timezone, location, detail }. Lodging needs check_in/check_out as { datetime, timezone }. Activities need start (and optionally end) as { datetime, timezone }. See tool description for full examples."),
    },
    handler: async (args, item) => {
      const data = parseTravelSpaceData(item.space_data);
      const defaultTz = data.trip.default_timezone || "UTC";
      const rawSegments = args.segments as Record<string, unknown>[];
      const added: string[] = [];

      for (const rawSeg of rawSegments) {
        // Coerce malformed data before processing
        const coerced = coerceSegment(rawSeg, defaultTz);
        // Dedup: type-aware composite key
        const newKey = dedupKey(coerced);
        if (newKey) {
          const existing = data.segments.find(
            s => dedupKey(s as unknown as Record<string, unknown>) === newKey
          );
          if (existing) {
            deepMerge(existing as unknown as Record<string, unknown>, coerced);
            added.push(`Updated: ${existing.title} (dedup)`);
            continue;
          }
        }

        const seg = normalizeSegment(coerced);
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
    description: "Update a travel segment by its ID. Uses deep merge — nested objects (departure, arrival, check_in, check_out, start, end, origin, destination, reservation, datetime, cost) are merged recursively. Example: to update just a gate, pass changes: { departure: { detail: \"Gate 55\" } } — this preserves departure.datetime and departure.timezone. To change status: { status: \"confirmed\" }. To add notes: { notes: \"Window seat confirmed\" }.",
    schema: {
      item_id: z.string().describe("Work item ID or display key (e.g. \"MARTIN-96\")"),
      segment_id: z.string().describe("Segment ID (e.g. \"seg_a1b2c3d4e5f6\"). Use tracker_get_item to see existing segments and their IDs."),
      changes: z.record(z.unknown()).describe("Fields to update. Nested objects (departure, arrival, cost, etc.) are deep-merged. Example: { departure: { detail: \"Gate 55\" } } or { status: \"confirmed\", seat: \"12A\" }"),
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
    description: "Remove one or more segments from a travel itinerary by their IDs. Use tracker_get_item first to see the current segments and their IDs.",
    schema: {
      item_id: z.string().describe("Work item ID or display key (e.g. \"MARTIN-96\")"),
      ids: z.array(z.string()).describe("Segment IDs to remove (e.g. [\"seg_a1b2c3d4e5f6\"]). Use tracker_get_item to see available segment IDs."),
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

// ── Agent Reference ──

const TRAVEL_AGENT_REFERENCE = `## Travel Space

One work item = one trip. All structured data is stored in \`space_data\` as a JSON blob containing trip metadata and an array of **segments** (flights, hotels, activities, etc.). The dashboard renders a chronological, day-by-day timeline view.

### Trip Metadata

\`\`\`json
{
  "trip": {
    "destination": "Tokyo, Japan",
    "purpose": "business",
    "travelers": ["Martin"],
    "default_timezone": "Asia/Tokyo",
    "notes": "Vegetarian meals. Aisle seat."
  },
  "segments": []
}
\`\`\`

- **Destination** — where the trip is going (e.g. "Tokyo, Japan" or "Shenzhen → Suzhou → Guangzhou")
- **Purpose** — business, leisure, conference, etc.
- **Travelers** — array of traveler names
- **Default timezone** — IANA timezone used as fallback for segments (e.g. "Asia/Tokyo")
- **Notes** — free-text trip notes (meal preferences, visa info, etc.)

### Segments

Segments are the building blocks of the itinerary. Each has a **common base** plus **type-specific fields**.

**Common base fields (all segment types):**
- \`id\` — unique segment ID (auto-generated: \`seg_\` + random hex)
- \`type\` — one of: \`flight\`, \`lodging\`, \`transport\`, \`activity\`, \`restaurant\`, \`meeting\`, \`note\`
- \`title\` — display name (e.g. "QF21 SYD → NRT", "Park Hyatt Tokyo", "Sushi Saito")
- \`status\` — \`confirmed\`, \`pending\`, or \`cancelled\`
- \`confirmation\` — booking reference / confirmation number
- \`provider\` — airline, hotel chain, company name
- \`provider_url\` — link to manage booking
- \`cost\` — \`{ amount, currency }\` (optional)
- \`notes\` — free-text notes
- \`address\` — full street address
- \`location\` — display-friendly city/area name (e.g. "Shinjuku, Tokyo") — used for day headers
- \`tags\` — string array for lightweight categorization (e.g. "must-do", "optional")
- \`image_url\` — optional image URL
- \`source_email\` — reference to parsed email (for traceability)

### Datetime Format

**Critical:** All datetimes use structured objects, NOT flat strings.

- **TimePoint**: \`{ "datetime": "2026-04-15T14:00", "timezone": "Asia/Tokyo" }\`
  Used by: lodging check_in/check_out, activity start/end, restaurant reservation, meeting start/end, note datetime

- **LocationTimePoint**: \`{ "datetime": "2026-04-15T21:00", "timezone": "Australia/Sydney", "location": "SYD", "detail": "Terminal 1" }\`
  Used by: flight departure/arrival, transport origin/destination

Every datetime is stored as **local time + IANA timezone**, never bare UTC. This prevents display errors after DST changes.

### Segment Types and Key Fields

**\`flight\`** — \`departure\` (LocationTimePoint), \`arrival\` (LocationTimePoint), \`flight_number\`, \`seat\`, \`cabin\` (economy/premium/business/first), \`aircraft\`, \`ticket_number\`

**\`lodging\`** — \`check_in\` (TimePoint), \`check_out\` (TimePoint), \`property_type\` (hotel/airbnb/hostel/resort), \`room_type\`

**\`transport\`** (train, bus, ferry, car rental, taxi, shuttle, rideshare) — \`transport_type\`, \`origin\` (LocationTimePoint), \`destination\` (LocationTimePoint), \`route_number\`, \`seat\`, \`car_type\`

**\`activity\`** (tour, museum, show, concert, excursion, spa, sightseeing) — \`activity_type\`, \`start\` (TimePoint), \`end\` (TimePoint, optional), \`duration_minutes\` (optional fallback for gap detection), \`venue\`

**\`restaurant\`** — \`reservation\` (TimePoint), \`cuisine\`, \`party_size\`

**\`meeting\`** — \`start\` (TimePoint), \`end\` (TimePoint), \`meeting_url\`, \`attendees\`

**\`note\`** (catch-all — reminders, directions, visa info) — \`datetime\` (TimePoint)

### Deduplication

When adding segments, the system deduplicates using a type-aware composite key:
- **Flights:** \`confirmation\` + \`provider\` + \`flight_number\` — so multiple flight legs under one PNR are stored separately
- **Lodging:** \`confirmation\` + \`provider\` + \`title\` — so multiple properties under one booking are stored separately
- **Transport:** \`confirmation\` + \`provider\` + \`title\` — so multiple legs under one booking are stored separately
- **All other types:** \`confirmation\` + \`provider\` only

If the type-specific field (flight_number/title) is absent, it falls back to \`confirmation\` + \`provider\` only. When a match is found, the existing segment is **updated** (deep merged) instead of duplicated. This is important when parsing forwarded booking emails — the same booking may be processed multiple times.

### Resilience / Auto-Coercion

The travel tools auto-correct common mistakes from agents:
- Field aliases: \`airline\` → \`provider\`, \`booking_ref\` → \`confirmation\`, \`restaurant_name\` → \`title\`, \`property_name\` → \`title\`, \`operator\` → \`provider\`, \`text\` → \`notes\`
- Status aliases: \`booked\` → \`confirmed\`, \`tentative\` → \`pending\`, \`canceled\` → \`cancelled\`
- Type aliases: \`hotel\` → \`lodging\`, \`taxi\`/\`train\`/\`bus\` → \`transport\`, \`tour\`/\`museum\` → \`activity\`, \`dining\`/\`meal\` → \`restaurant\`
- Flat ISO datetime strings like \`"2026-03-22T06:40:00+08:00"\` are parsed into TimePoint format

However, using the correct format is strongly preferred.

### MCP Tools for Travel

**Always use these dedicated tools** — never construct raw \`space_data\` JSON for travel items.

| Tool | Description |
| --- | --- |
| \`tracker_update_travel_trip\` | Update trip metadata — pass \`destination\`, \`purpose\`, \`travelers\` (array), \`default_timezone\`, \`notes\`. Only provided fields are updated. |
| \`tracker_add_travel_segment\` | Add segments — pass \`segments\` array. Each needs \`type\` and \`title\` at minimum. Auto-generates IDs. Deduplicates by \`confirmation\` + \`provider\`, with type-specific disambiguation (flights: +flight_number, lodging/transport: +title). |
| \`tracker_update_travel_segment\` | Update a segment by ID — pass \`segment_id\` and \`changes\` object. **Deep merges** nested objects (e.g. \`{ departure: { detail: "Gate 55" } }\` only updates the detail, preserving datetime and timezone). |
| \`tracker_remove_travel_segment\` | Remove segments — pass \`ids\` array of segment ID strings. Use \`tracker_get_item\` first to see available IDs. |

### Examples

**Creating a trip and adding a flight:**
\`\`\`
tracker_create_item(project_id="...", title="Tokyo Business Trip", space_type="travel")
tracker_update_travel_trip(item_id="...", destination="Tokyo, Japan", purpose="business",
  travelers=["Martin"], default_timezone="Asia/Tokyo")
tracker_add_travel_segment(item_id="...", segments=[{
  type: "flight",
  title: "QF21 SYD → NRT",
  status: "confirmed",
  provider: "Qantas",
  confirmation: "ABC123",
  departure: { datetime: "2026-04-15T21:00", timezone: "Australia/Sydney", location: "SYD", detail: "Terminal 1" },
  arrival: { datetime: "2026-04-16T06:00", timezone: "Asia/Tokyo", location: "NRT", detail: "Terminal 2" },
  flight_number: "QF 21",
  seat: "34A",
  cabin: "business"
}])
\`\`\`

**Adding lodging:**
\`\`\`
tracker_add_travel_segment(item_id="...", segments=[{
  type: "lodging",
  title: "Park Hyatt Tokyo",
  status: "confirmed",
  provider: "Park Hyatt",
  confirmation: "9169182",
  location: "Shinjuku, Tokyo",
  address: "3-7-1-2 Nishi Shinjuku",
  check_in: { datetime: "2026-04-15T15:00", timezone: "Asia/Tokyo" },
  check_out: { datetime: "2026-04-18T11:00", timezone: "Asia/Tokyo" },
  property_type: "hotel",
  room_type: "Deluxe King"
}])
\`\`\`

**Partial update (gate change):**
\`\`\`
tracker_update_travel_segment(item_id="...", segment_id="seg_a1b2c3d4e5f6",
  changes={ departure: { detail: "Gate 55" } })
\`\`\`

### Additional Features

- **Cover image** → attachment named \`cover.jpg/png/webp\` (displayed as trip header)
- **Description** → item description field (general trip notes)
- **Discussion** → comments sidebar
- **Documents** → attachments tab for boarding passes, confirmations, PDFs

### Email Parsing Workflow

When forwarded confirmation emails are detected (via gmail_query or manual forward):
1. Parse the email to extract: segment type, dates/times/timezones, confirmation number, provider, seat/room details
2. Call \`tracker_add_travel_segment\` (type-aware dedup handles re-sends)
3. Add a comment: "Parsed QF21 confirmation — added flight segment"
4. Set \`source_email\` on the segment for traceability`;

// ── Exported for testing ──

export { dedupKey as _dedupKey };

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

  agentReference: TRAVEL_AGENT_REFERENCE,

  defaultSpaceData: () => ({ ...DEFAULTS }),
  parseSpaceData: (raw) => parseTravelSpaceData(raw) as unknown as Record<string, unknown>,
  sanitizeSpaceData: (raw) => sanitizeTravelSpaceData(raw),

  apiRoutes: travelApiRoutes,
  mcpTools: travelMcpTools,
};
