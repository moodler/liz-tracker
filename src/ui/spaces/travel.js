// ── Space: Travel ──
let travelSaveTimer = null;

const TRAVEL_SEGMENT_TYPES = [
  { value: "flight", label: "Flight", icon: "\u2708\ufe0f", color: "#74b9ff" },
  { value: "lodging", label: "Lodging", icon: "\ud83c\udfe8", color: "#a29bfe" },
  { value: "transport", label: "Transport", icon: "\ud83d\ude82", color: "#fdcb6e" },
  { value: "activity", label: "Activity", icon: "\ud83c\udfaf", color: "#00b894" },
  { value: "restaurant", label: "Restaurant", icon: "\ud83c\udf7d\ufe0f", color: "#e17055" },
  { value: "meeting", label: "Meeting", icon: "\ud83d\udccb", color: "#636e72" },
  { value: "note", label: "Note", icon: "\ud83d\udcdd", color: "#b2bec3" },
];

const TRAVEL_STATUS_LABELS = { confirmed: "Confirmed", pending: "Pending", cancelled: "Cancelled" };

function getTravelSegType(type) {
  return TRAVEL_SEGMENT_TYPES.find(t => t.value === type) || TRAVEL_SEGMENT_TYPES[6];
}

function parseTravelData(item) {
  const defaults = { trip: { destination: "", purpose: "", travelers: [], default_timezone: "", notes: "" }, segments: [] };
  if (!item.space_data) return defaults;
  try {
    const parsed = typeof item.space_data === "string" ? JSON.parse(item.space_data) : item.space_data;
    const trip = { ...defaults.trip, ...(parsed.trip || {}) };
    const defaultTz = trip.default_timezone || "UTC";
    return {
      trip,
      segments: Array.isArray(parsed.segments)
        ? parsed.segments.map(s => coerceTravelSegment(s, defaultTz))
        : [],
    };
  } catch { return defaults; }
}

/**
 * Client-side coercion: fix malformed segment data written by agents that bypassed MCP tools.
 * Maps common field aliases and converts flat date strings to TimePoint objects.
 */
function coerceTravelSegment(seg, defaultTz) {
  const r = { ...seg };
  // Field aliases
  if (!r.provider && r.carrier) { r.provider = r.carrier; delete r.carrier; }
  if (!r.provider && r.airline) { r.provider = r.airline; delete r.airline; }
  if (!r.provider && r.operator) { r.provider = r.operator; delete r.operator; }
  if (!r.confirmation && r.booking_ref) { r.confirmation = r.booking_ref; delete r.booking_ref; }
  if (!r.notes && typeof r.text === "string") { r.notes = r.text; delete r.text; }

  // Type aliases
  const TYPE_MAP = { layover: "activity", stopover: "activity", transfer: "transport", hotel: "lodging", accommodation: "lodging", dining: "restaurant", meal: "restaurant", reminder: "note", info: "note" };
  const VALID_TYPES = ["flight", "lodging", "transport", "activity", "restaurant", "meeting", "note"];
  if (r.type && !VALID_TYPES.includes(r.type)) r.type = TYPE_MAP[r.type] || "note";

  // Status aliases
  const STATUS_MAP = { booked: "confirmed", reserved: "confirmed", active: "confirmed", tentative: "pending", canceled: "cancelled" };
  const VALID_STATUSES = ["confirmed", "pending", "cancelled"];
  if (r.status && !VALID_STATUSES.includes(r.status)) r.status = STATUS_MAP[r.status] || "pending";

  // Ensure ID
  if (!r.id) r.id = travelSegId();

  const _parseIso = (val) => {
    if (!val) return null;
    if (typeof val === "object" && val.datetime && val.timezone) return val;
    if (typeof val !== "string") return null;
    let dt = val.trim(), tz = defaultTz;
    const offMatch = dt.match(/([+-])(\d{2}):?(\d{2})$/);
    if (offMatch) {
      dt = dt.replace(/[+-]\d{2}:?\d{2}$/, "");
      const h = parseInt(offMatch[2], 10);
      if (parseInt(offMatch[3], 10) === 0) tz = `Etc/GMT${offMatch[1] === "+" ? "-" : "+"}${h}`;
    }
    dt = dt.replace(/:\d{2}(\.\d+)?$/, "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(dt)) dt += "T00:00";
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dt)) return null;
    return { datetime: dt, timezone: tz };
  };

  const _parseLtp = (val, locHint) => {
    if (typeof val === "object" && val !== null && val.datetime && val.timezone) {
      return { datetime: val.datetime, timezone: val.timezone, location: val.location || locHint || "", detail: val.detail };
    }
    const tp = _parseIso(val);
    if (!tp) return null;
    return { ...tp, location: locHint || "" };
  };

  const _extractCode = (v) => {
    if (!v || typeof v !== "string") return "";
    const m = v.match(/\((\w{3})\b/);
    return m ? m[1] : v.slice(0, 40);
  };

  // Flight coercion
  if (r.type === "flight") {
    if (!r.departure || typeof r.departure !== "object" || !r.departure.datetime) {
      const dt = r.departure_time || r.depart_time || r.departure_datetime;
      const loc = r.departure_location || r.depart_location || r.from;
      const tp = _parseLtp(dt, _extractCode(loc));
      if (tp) { if (r.departure_terminal) tp.detail = r.departure_terminal; r.departure = tp; }
    }
    if (!r.arrival || typeof r.arrival !== "object" || !r.arrival.datetime) {
      const dt = r.arrival_time || r.arrive_time || r.arrival_datetime;
      const loc = r.arrival_location || r.arrive_location || r.to;
      const tp = _parseLtp(dt, _extractCode(loc));
      if (tp) { if (r.arrival_terminal) tp.detail = r.arrival_terminal; r.arrival = tp; }
    }
  }

  // Lodging coercion
  if (r.type === "lodging") {
    if (!r.check_in || typeof r.check_in !== "object" || !r.check_in.datetime) {
      const tp = _parseIso(r.check_in || r.checkin || r.check_in_date);
      if (tp) r.check_in = tp;
    }
    if (!r.check_out || typeof r.check_out !== "object" || !r.check_out.datetime) {
      const tp = _parseIso(r.check_out || r.checkout || r.check_out_date);
      if (tp) r.check_out = tp;
    }
  }

  // Transport coercion
  if (r.type === "transport") {
    if (!r.origin || typeof r.origin !== "object" || !r.origin.datetime) {
      const dt = r.departure_time || r.origin_time;
      const loc = r.departure_location || r.origin_location || r.from;
      const tp = _parseLtp(dt, _extractCode(loc));
      if (tp) r.origin = tp;
    }
    if (!r.destination || typeof r.destination !== "object" || !r.destination.datetime) {
      const dt = r.arrival_time || r.destination_time;
      const loc = r.arrival_location || r.destination_location || r.to;
      const tp = _parseLtp(dt, _extractCode(loc));
      if (tp) r.destination = tp;
    }
  }

  // Activity coercion
  if (r.type === "activity") {
    if (!r.start || typeof r.start !== "object" || !r.start.datetime) {
      let dt = r.start_time || r.start_datetime;
      // Handle "HH:MM" time + separate "YYYY-MM-DD" date
      if (typeof dt === "string" && /^\d{2}:\d{2}$/.test(dt) && typeof r.date === "string") {
        dt = r.date + "T" + dt;
      }
      if (!dt) dt = r.date;
      const tp = _parseIso(dt);
      if (tp) r.start = tp;
    }
    if (!r.end || typeof r.end !== "object" || !r.end.datetime) {
      let dt = r.end_time || r.end_datetime;
      // Handle "HH:MM" time + separate "YYYY-MM-DD" date
      if (typeof dt === "string" && /^\d{2}:\d{2}$/.test(dt) && typeof r.date === "string") {
        dt = r.date + "T" + dt;
      }
      const tp = _parseIso(dt);
      if (tp) r.end = tp;
    }
  }

  // Restaurant coercion
  if (r.type === "restaurant") {
    if (!r.reservation || typeof r.reservation !== "object" || !r.reservation.datetime) {
      let dt = r.reservation_time;
      if (typeof dt === "string" && /^\d{2}:\d{2}$/.test(dt) && typeof r.date === "string") {
        dt = r.date + "T" + dt;
      }
      if (!dt) dt = r.date;
      const tp = _parseIso(dt);
      if (tp) r.reservation = tp;
    }
  }

  // Meeting coercion
  if (r.type === "meeting") {
    if (!r.start || typeof r.start !== "object" || !r.start.datetime) {
      let dt = r.start_time;
      if (typeof dt === "string" && /^\d{2}:\d{2}$/.test(dt) && typeof r.date === "string") {
        dt = r.date + "T" + dt;
      }
      if (!dt) dt = r.date;
      const tp = _parseIso(dt);
      if (tp) r.start = tp;
    }
    if (!r.end || typeof r.end !== "object" || !r.end.datetime) {
      let dt = r.end_time;
      if (typeof dt === "string" && /^\d{2}:\d{2}$/.test(dt) && typeof r.date === "string") {
        dt = r.date + "T" + dt;
      }
      const tp = _parseIso(dt);
      if (tp) r.end = tp;
    }
  }

  // Note coercion
  if (r.type === "note") {
    if (!r.datetime || typeof r.datetime !== "object" || !r.datetime.datetime) {
      const tp = _parseIso(r.date || r.date_time);
      if (tp) r.datetime = tp;
    }
  }

  return r;
}

function travelSegId() {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(6))).map(b => b.toString(16).padStart(2, "0")).join("");
  return "seg_" + hex;
}

// ── Timezone Utilities ──

function toUtcDate(datetime, timezone) {
  if (!datetime || !timezone) return null;
  try {
    const parts = datetime.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!parts) return null;
    const [, y, mo, d, h, mi] = parts.map(Number);
    // Binary search for the UTC instant that produces this local time in the given timezone
    // Start with a rough guess: treat the local time as UTC
    let lo = Date.UTC(y, mo - 1, d, h, mi) - 15 * 3600000; // -15h
    let hi = lo + 30 * 3600000; // +15h from lo
    const target = y * 100000000 + mo * 1000000 + d * 10000 + h * 100 + mi;
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const extract = (ts) => {
      const p = fmt.formatToParts(new Date(ts));
      const g = (t) => parseInt(p.find(x => x.type === t)?.value || "0");
      const hr = g("hour") === 24 ? 0 : g("hour");
      return g("year") * 100000000 + g("month") * 1000000 + g("day") * 10000 + hr * 100 + g("minute");
    };
    // Step through in 15-minute increments (handles all real-world UTC offsets)
    for (let ts = lo; ts <= hi; ts += 900000) {
      if (extract(ts) === target) return new Date(ts);
    }
    return new Date(Date.UTC(y, mo - 1, d, h, mi));
  } catch { return null; }
}

function getSegmentSortUtc(seg) {
  switch (seg.type) {
    case "flight": return toUtcDate(seg.departure?.datetime, seg.departure?.timezone);
    case "lodging": return toUtcDate(seg.check_in?.datetime, seg.check_in?.timezone);
    case "transport": return toUtcDate(seg.origin?.datetime, seg.origin?.timezone);
    case "activity": return toUtcDate(seg.start?.datetime, seg.start?.timezone);
    case "restaurant": return toUtcDate(seg.reservation?.datetime, seg.reservation?.timezone);
    case "meeting": return toUtcDate(seg.start?.datetime, seg.start?.timezone);
    case "note": return toUtcDate(seg.datetime?.datetime, seg.datetime?.timezone);
    default: return null;
  }
}

function getSegmentEndUtc(seg) {
  switch (seg.type) {
    case "flight": return toUtcDate(seg.arrival?.datetime, seg.arrival?.timezone);
    case "lodging": return toUtcDate(seg.check_out?.datetime, seg.check_out?.timezone);
    case "transport": return toUtcDate(seg.destination?.datetime, seg.destination?.timezone);
    case "activity": {
      if (seg.end?.datetime) return toUtcDate(seg.end.datetime, seg.end.timezone);
      const s = toUtcDate(seg.start?.datetime, seg.start?.timezone);
      return s ? new Date(s.getTime() + (seg.duration_minutes || 120) * 60000) : null;
    }
    case "restaurant": {
      const r = toUtcDate(seg.reservation?.datetime, seg.reservation?.timezone);
      return r ? new Date(r.getTime() + 90 * 60000) : null;
    }
    case "meeting": {
      if (seg.end?.datetime) return toUtcDate(seg.end.datetime, seg.end.timezone);
      const s = toUtcDate(seg.start?.datetime, seg.start?.timezone);
      return s ? new Date(s.getTime() + (seg.duration_minutes || 60) * 60000) : null;
    }
    default: return null;
  }
}

function getLocalDate(datetime, timezone) {
  if (!datetime || !timezone) return null;
  try {
    const utc = toUtcDate(datetime, timezone);
    if (!utc) return null;
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(utc);
  } catch { return null; }
}

function formatTravelTime(datetime, timezone) {
  if (!datetime) return "";
  try {
    const utc = toUtcDate(datetime, timezone);
    if (!utc) return datetime.slice(11, 16) || "";
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(utc);
  } catch { return datetime.slice(11, 16) || ""; }
}

function tzAbbrev(timezone) {
  if (!timezone) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" }).formatToParts(new Date());
    return parts.find(p => p.type === "timeZoneName")?.value || "";
  } catch { return ""; }
}

// ── Day-by-Day Bucketing ──

function getSegmentPrimaryTimepoint(seg) {
  switch (seg.type) {
    case "flight": return seg.departure;
    case "lodging": return seg.check_in;
    case "transport": return seg.origin;
    case "activity": return seg.start;
    case "restaurant": return seg.reservation;
    case "meeting": return seg.start;
    case "note": return seg.datetime;
    default: return null;
  }
}

function getSegmentDates(seg) {
  const dates = [];
  switch (seg.type) {
    case "flight": {
      const dd = getLocalDate(seg.departure?.datetime, seg.departure?.timezone);
      const ad = getLocalDate(seg.arrival?.datetime, seg.arrival?.timezone);
      if (dd) dates.push({ date: dd, role: "departure" });
      if (ad && ad !== dd) dates.push({ date: ad, role: "arrival" });
      break;
    }
    case "lodging": {
      const ci = getLocalDate(seg.check_in?.datetime, seg.check_in?.timezone);
      const co = getLocalDate(seg.check_out?.datetime, seg.check_out?.timezone);
      if (ci) {
        dates.push({ date: ci, role: "check_in" });
        if (co && co !== ci) {
          const d1 = new Date(ci + "T00:00:00Z");
          const d2 = new Date(co + "T00:00:00Z");
          for (let d = new Date(d1.getTime() + 86400000); d < d2; d = new Date(d.getTime() + 86400000)) {
            dates.push({ date: d.toISOString().slice(0, 10), role: "staying" });
          }
          dates.push({ date: co, role: "check_out" });
        }
      }
      break;
    }
    case "transport": {
      const od = getLocalDate(seg.origin?.datetime, seg.origin?.timezone);
      const dd = getLocalDate(seg.destination?.datetime, seg.destination?.timezone);
      if (od) dates.push({ date: od, role: "departure" });
      if (dd && dd !== od) dates.push({ date: dd, role: "arrival" });
      break;
    }
    default: {
      const tp = getSegmentPrimaryTimepoint(seg);
      if (tp) { const d = getLocalDate(tp.datetime, tp.timezone); if (d) dates.push({ date: d, role: "single" }); }
    }
  }
  if (!dates.length) {
    const tp = getSegmentPrimaryTimepoint(seg);
    if (tp) { const d = getLocalDate(tp.datetime, tp.timezone); if (d) dates.push({ date: d, role: "single" }); }
  }
  return dates;
}

function getSegLocation(seg) {
  if (seg.location) return seg.location;
  if (seg.type === "flight") return seg.arrival?.location || seg.departure?.location || "";
  if (seg.type === "transport") return seg.destination?.location || seg.origin?.location || "";
  return "";
}

function buildDayTimeline(segments, tripData) {
  const empty = { days: [], summary: { totalDays: 0, cities: [], flights: 0, hotelNights: 0, totalCost: 0, currency: "AUD" } };
  if (!segments.length) return empty;

  const annotated = segments
    .map(seg => ({ seg, sortUtc: getSegmentSortUtc(seg), endUtc: getSegmentEndUtc(seg) }))
    .filter(a => a.sortUtc)
    .sort((a, b) => a.sortUtc - b.sortUtc);
  if (!annotated.length) return empty;

  const dayBuckets = {};
  for (const { seg, sortUtc, endUtc } of annotated) {
    for (const d of getSegmentDates(seg)) {
      if (!dayBuckets[d.date]) dayBuckets[d.date] = [];
      dayBuckets[d.date].push({ seg, role: d.role, sortUtc, endUtc });
    }
  }

  // Fill missing dates
  const sortedDates = Object.keys(dayBuckets).sort();
  const first = new Date(sortedDates[0] + "T00:00:00Z");
  const last = new Date(sortedDates[sortedDates.length - 1] + "T00:00:00Z");
  const allDates = [];
  for (let d = new Date(first); d <= last; d = new Date(d.getTime() + 86400000)) {
    const ds = d.toISOString().slice(0, 10);
    allDates.push(ds);
    if (!dayBuckets[ds]) dayBuckets[ds] = [];
  }

  const lodgings = annotated.filter(a => a.seg.type === "lodging");

  const days = allDates.map((date, idx) => {
    const entries = dayBuckets[date];
    entries.sort((a, b) => (a.sortUtc || 0) - (b.sortUtc || 0));

    // Location
    let location = "";
    for (const { seg } of lodgings) {
      const ci = getLocalDate(seg.check_in?.datetime, seg.check_in?.timezone);
      const co = getLocalDate(seg.check_out?.datetime, seg.check_out?.timezone);
      if (ci && co && ci <= date && date <= co) { location = seg.location || seg.title || ""; break; }
    }
    if (!location) for (const e of entries) { const l = getSegLocation(e.seg); if (l) { location = l; break; } }
    if (!location) location = tripData.destination || "";

    // Intra-day gaps
    const gaps = [];
    for (let i = 0; i < entries.length - 1; i++) {
      const cur = entries[i], nxt = entries[i + 1];
      if (!cur.endUtc || !nxt.sortUtc) continue;
      const gapMin = (nxt.sortUtc - cur.endUtc) / 60000;
      if (gapMin < 30) continue;
      let type = "transit";
      if (gapMin > 240) type = "open";
      else if (gapMin > 120) type = "free";
      const h = Math.floor(gapMin / 60), m = Math.round(gapMin % 60);
      gaps.push({ afterIndex: i, type, duration: h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ""}` : `${m}m` });
    }

    const hasLodging = lodgings.some(({ seg }) => {
      const ci = getLocalDate(seg.check_in?.datetime, seg.check_in?.timezone);
      const co = getLocalDate(seg.check_out?.datetime, seg.check_out?.timezone);
      return ci && co && ci <= date && date < co;
    });

    return { date, dayNum: idx + 1, location, entries, gaps, hasLodging, isEmpty: entries.length === 0 };
  });

  // Summary
  const cities = [...new Set(days.map(d => d.location).filter(Boolean))];
  const flights = segments.filter(s => s.type === "flight").length;
  let hotelNights = 0;
  for (const { seg } of lodgings) {
    const ci = getLocalDate(seg.check_in?.datetime, seg.check_in?.timezone);
    const co = getLocalDate(seg.check_out?.datetime, seg.check_out?.timezone);
    if (ci && co) hotelNights += Math.max(0, Math.round((new Date(co + "T00:00:00Z") - new Date(ci + "T00:00:00Z")) / 86400000));
  }
  let totalCost = 0, currency = "AUD";
  for (const seg of segments) { if (seg.cost?.amount) { totalCost += seg.cost.amount; currency = seg.cost.currency || currency; } }

  return { days, summary: { totalDays: allDates.length, cities, flights, hotelNights, totalCost, currency } };
}

// ── Main Render ──

function renderSpaceTravel(item) {
  const sd = parseTravelData(item);
  const trip = sd.trip;
  const attachments = item.attachments || [];
  const coverAtt = attachments.find(a => /^cover\.(png|jpg|jpeg|webp)$/i.test(a.filename));
  const timeline = buildDayTimeline(sd.segments, trip);

  // Date range string
  let dateRange = "";
  if (timeline.days.length > 0) {
    const f = timeline.days[0].date, l = timeline.days[timeline.days.length - 1].date;
    const fmt = d => new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    dateRange = f === l ? fmt(f) : `${fmt(f)} \u2013 ${fmt(l)}`;
    dateRange += ` ${l.slice(0, 4)}`;
  }

  const today = new Date().toISOString().slice(0, 10);
  const longTrip = timeline.days.length > 7;

  // Build glance section
  const glanceRows = timeline.days.map(day => {
    const icons = day.entries.map(e => getTravelSegType(e.seg.type).icon).join(" ");
    const names = day.entries.slice(0, 3).map(e => esc(e.seg.title || getTravelSegType(e.seg.type).label)).join(", ");
    return `<div class="travel-glance-row${day.isEmpty ? " empty" : ""}"><span class="glance-day">Day ${day.dayNum}</span><span class="glance-date">${fmtDayShort(day.date)}</span><span class="glance-loc">${esc(day.location)}</span><span class="glance-detail">${icons} ${names}</span></div>`;
  }).join("");

  // Build day timeline
  const daysHtml = timeline.days.length > 0 ? timeline.days.map(day => {
    const isToday = day.date === today;
    const collapsed = longTrip && !isToday ? " collapsed" : "";
    const lastDate = timeline.days[timeline.days.length - 1]?.date;

    let bodyContent = "";
    if (day.isEmpty) {
      bodyContent = '<div class="travel-gap-indicator open">\ud83d\udcc5 Open day \u2014 no plans</div>';
    } else {
      bodyContent = day.entries.map((entry, idx) => {
        const gapAfter = day.gaps.find(g => g.afterIndex === idx);
        return renderTravelSegCard(entry.seg, entry.role) + (gapAfter ? renderTravelGap(gapAfter) : "");
      }).join("");
    }
    if (!day.hasLodging && !day.isEmpty && day.date !== lastDate) {
      bodyContent += '<div class="travel-gap-indicator overnight">\u26a0\ufe0f No accommodation booked</div>';
    }
    bodyContent += `<button class="travel-add-seg-btn" data-date="${esc(day.date)}">+ Add segment</button>`;

    return `<div class="travel-day${isToday ? " travel-today" : ""}${collapsed}" data-date="${esc(day.date)}">
      <div class="travel-day-header"><span class="travel-day-num">Day ${day.dayNum}</span><span class="travel-day-date">${fmtDayLong(day.date)}</span>${day.location ? `<span class="travel-day-loc">${esc(day.location)}</span>` : ""}${isToday ? '<span class="travel-today-badge">Today</span>' : ""}<span class="section-toggle">\u25bc</span></div>
      <div class="travel-day-body">${bodyContent}</div>
    </div>`;
  }).join("") : '<div class="travel-empty-state">\u2708\ufe0f No itinerary yet \u2014 add your first segment to start planning.<br><button class="travel-add-seg-btn" data-date="" style="margin-top:12px;">+ Add first segment</button></div>';

  // Summary bar
  const s = timeline.summary;
  const summaryHtml = s.totalDays > 0 ? `<div class="travel-summary"><span>\ud83d\udcc5 ${s.totalDays} day${s.totalDays !== 1 ? "s" : ""}</span>${s.cities.length ? `<span>\ud83d\udccd ${s.cities.join(", ")}</span>` : ""}${s.flights ? `<span>\u2708\ufe0f ${s.flights}</span>` : ""}${s.hotelNights ? `<span>\ud83c\udfe8 ${s.hotelNights} night${s.hotelNights !== 1 ? "s" : ""}</span>` : ""}${s.totalCost ? `<span>\ud83d\udcb0 ${fmtCost(s.totalCost, s.currency)}</span>` : ""}</div>` : "";

  // Docs list
  const docs = attachments.filter(a => !/^cover\.(png|jpg|jpeg|webp)$/i.test(a.filename));
  const docsHtml = docs.length > 0 ? docs.map(att => `<div class="engagement-doc-item"><span class="doc-icon">\ud83d\udcc4</span><a href="/api/v1/attachments/${esc(att.id)}" target="_blank">${esc(att.filename)}</a><span style="color:var(--text-dim);font-size:0.75rem;margin-left:auto;">${att.uploaded_at ? formatTime(att.uploaded_at) : ""}</span></div>`).join("") : '<div class="engagement-empty">No documents attached.</div>';

  spaceBody.innerHTML = `
    <div class="travel-space" id="travelSpace">
      <div class="travel-dashboard" id="travelDashboard">
        ${coverAtt ? `<div class="travel-cover"><img src="/api/v1/attachments/${esc(coverAtt.id)}" alt="Cover" /></div>` : ""}
        <div class="travel-header">
          <div class="travel-title">${esc(item.title)}</div>
          <div class="travel-meta">${dateRange ? `<span>\ud83d\udcc5 ${esc(dateRange)}</span>` : ""}${trip.destination ? `<span>\ud83d\udccd ${esc(trip.destination)}</span>` : ""}${trip.purpose ? `<span class="travel-badge">${esc(trip.purpose)}</span>` : ""}${trip.travelers.length ? `<span>\ud83d\udc64 ${esc(trip.travelers.join(", "))}</span>` : ""}</div>
        </div>
        ${timeline.days.length > 0 ? `<div class="travel-section"><div class="travel-section-header"><span class="section-title">\ud83d\udcca At a Glance</span><span class="section-toggle">\u25bc</span></div><div class="travel-section-body">${glanceRows}</div></div>` : ""}
        <div class="travel-timeline" id="travelTimeline">${daysHtml}</div>
        ${summaryHtml}
      </div>
      <div class="travel-sidebar">
        <div class="text-sidebar-tabs">
          <button class="text-sidebar-tab active" data-panel="discussion">Discussion</button>
          <button class="text-sidebar-tab" data-panel="details">Details</button>
          <button class="text-sidebar-tab" data-panel="documents">Documents</button>
        </div>
        <div class="text-sidebar-panel active" id="travelPanelDiscussion">
          <div class="text-discussion">
            <div class="text-discussion-thread" id="travelDiscussionThread"></div>
            <div class="text-discussion-input">
              <textarea id="travelCommentInput" placeholder="Add a comment..." rows="2"></textarea>
              <button id="travelCommentSubmit">Send</button>
            </div>
          </div>
        </div>
        <div class="text-sidebar-panel" id="travelPanelDetails">
          <div style="flex:1;overflow-y:auto;padding:14px;">
            <div class="engagement-edit-row"><label>Description</label><span class="engagement-save-indicator" id="travelDescInd"></span></div>
            <textarea id="travelDescTA" style="width:100%;min-height:120px;background:rgba(255,255,255,0.06);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);padding:8px;font-size:0.83rem;resize:vertical;outline:none;margin-bottom:12px;font-family:inherit;">${esc(item.description || "")}</textarea>
            <div style="font-size:0.8rem;color:var(--text-dim);font-weight:600;margin-bottom:6px;">Trip Settings</div>
            <div class="engagement-edit-row"><label>Destination</label><input id="tvDest" value="${esc(trip.destination)}" placeholder="Tokyo, Japan" /></div>
            <div class="engagement-edit-row"><label>Purpose</label><input id="tvPurpose" value="${esc(trip.purpose)}" placeholder="business / leisure" /></div>
            <div class="engagement-edit-row"><label>Travelers</label><input id="tvTravelers" value="${esc(trip.travelers.join(", "))}" placeholder="Comma-separated" /></div>
            <div class="engagement-edit-row"><label>Timezone</label><input id="tvTz" value="${esc(trip.default_timezone)}" placeholder="Asia/Tokyo" /></div>
            <div class="engagement-edit-row"><label>Notes</label><textarea id="tvNotes" style="width:100%;min-height:50px;background:rgba(255,255,255,0.06);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);padding:6px;font-size:0.83rem;resize:vertical;outline:none;font-family:inherit;">${esc(trip.notes)}</textarea></div>
          </div>
        </div>
        <div class="text-sidebar-panel" id="travelPanelDocuments">
          <div style="flex:1;overflow-y:auto;padding:14px;"><div class="engagement-doc-list">${docsHtml}</div></div>
        </div>
      </div>
    </div>`;

  renderTravelDiscussion(item.comments || []);
  bindTravelEvents(sd);
}

// ── Segment Card ──

function renderTravelSegCard(seg, role) {
  const st = getTravelSegType(seg.type);
  const time = segDisplayTime(seg, role);
  const statusBadge = seg.status !== "confirmed" ? `<span class="travel-status-badge ${esc(seg.status)}">${esc(TRAVEL_STATUS_LABELS[seg.status] || seg.status)}</span>` : "";
  const detail = segDetail(seg, role);
  return `<div class="travel-seg-card${seg.status === "cancelled" ? " cancelled" : ""}" data-segid="${esc(seg.id)}" style="--seg-color:${st.color}">
    <div class="travel-seg-collapsed"><span class="travel-seg-time">${esc(time)}</span><span class="travel-seg-icon">${st.icon}</span><span class="travel-seg-title">${esc(seg.title || st.label)}</span>${statusBadge}${detail ? `<span class="travel-seg-detail">${detail}</span>` : ""}</div>
    <div class="travel-seg-expanded">${renderSegExpanded(seg)}<div class="travel-seg-actions"><button class="travel-seg-action travel-seg-edit" data-segid="${esc(seg.id)}">Edit</button><button class="travel-seg-action travel-seg-delete" data-segid="${esc(seg.id)}">Delete</button></div></div>
  </div>`;
}

function segDisplayTime(seg, role) {
  const t = (tp) => formatTravelTime(tp?.datetime, tp?.timezone);
  switch (seg.type) {
    case "flight": return role === "arrival" ? t(seg.arrival) : t(seg.departure);
    case "lodging": return role === "check_out" ? t(seg.check_out) : role === "staying" ? "" : t(seg.check_in);
    case "transport": return role === "arrival" ? t(seg.destination) : t(seg.origin);
    case "activity": return t(seg.start);
    case "restaurant": return t(seg.reservation);
    case "meeting": return t(seg.start);
    case "note": return t(seg.datetime);
    default: return "";
  }
}

function segDetail(seg, role) {
  switch (seg.type) {
    case "flight": {
      if (role === "arrival") return `Arriving ${esc(seg.arrival?.location || "")}`;
      const d = seg.departure?.location || "", a = seg.arrival?.location || "";
      return d && a ? `${esc(d)} \u2192 ${esc(a)}` : "";
    }
    case "lodging":
      if (role === "check_in") return "Check-in";
      if (role === "check_out") return "Check-out";
      if (role === "staying") return `<em>Staying at ${esc(seg.title)}</em>`;
      return "";
    case "transport": {
      if (role === "arrival") return `Arriving ${esc(seg.destination?.location || "")}`;
      const o = seg.origin?.location || "", d = seg.destination?.location || "";
      return o && d ? `${esc(o)} \u2192 ${esc(d)}` : esc(seg.transport_type || "");
    }
    case "activity": return seg.venue ? esc(seg.venue) : "";
    case "restaurant": return seg.cuisine ? esc(seg.cuisine) : "";
    case "meeting": return seg.meeting_url ? '<span style="color:var(--highlight)">\ud83d\udcf9 Virtual</span>' : esc(seg.address || "");
    default: return "";
  }
}

function renderSegExpanded(seg) {
  const rows = [];
  const r = (l, v) => { if (v) rows.push(`<div class="travel-detail-row"><span class="travel-detail-label">${esc(l)}</span><span class="travel-detail-value">${v}</span></div>`); };
  if (seg.provider) r("Provider", esc(seg.provider));
  if (seg.confirmation) r("Confirmation", esc(seg.confirmation));
  switch (seg.type) {
    case "flight":
      if (seg.flight_number) r("Flight", esc(seg.flight_number));
      if (seg.departure?.location) r("From", `${esc(seg.departure.location)}${seg.departure.detail ? " \u2014 " + esc(seg.departure.detail) : ""} at ${formatTravelTime(seg.departure.datetime, seg.departure.timezone)} ${esc(tzAbbrev(seg.departure.timezone))}`);
      if (seg.arrival?.location) r("To", `${esc(seg.arrival.location)}${seg.arrival.detail ? " \u2014 " + esc(seg.arrival.detail) : ""} at ${formatTravelTime(seg.arrival.datetime, seg.arrival.timezone)} ${esc(tzAbbrev(seg.arrival.timezone))}`);
      if (seg.seat) r("Seat", esc(seg.seat));
      if (seg.cabin) r("Cabin", esc(seg.cabin));
      if (seg.aircraft) r("Aircraft", esc(seg.aircraft));
      if (seg.ticket_number) r("Ticket", esc(seg.ticket_number));
      break;
    case "lodging":
      if (seg.property_type) r("Type", esc(seg.property_type));
      if (seg.room_type) r("Room", esc(seg.room_type));
      if (seg.check_in?.datetime) r("Check-in", `${esc(seg.check_in.datetime.slice(0, 10))} ${formatTravelTime(seg.check_in.datetime, seg.check_in.timezone)}`);
      if (seg.check_out?.datetime) r("Check-out", `${esc(seg.check_out.datetime.slice(0, 10))} ${formatTravelTime(seg.check_out.datetime, seg.check_out.timezone)}`);
      break;
    case "transport":
      if (seg.transport_type) r("Mode", esc(seg.transport_type));
      if (seg.route_number) r("Route", esc(seg.route_number));
      if (seg.seat) r("Seat", esc(seg.seat));
      if (seg.car_type) r("Vehicle", esc(seg.car_type));
      break;
    case "activity":
      if (seg.activity_type) r("Type", esc(seg.activity_type));
      if (seg.venue) r("Venue", esc(seg.venue));
      if (seg.duration_minutes) r("Duration", `${seg.duration_minutes}min`);
      break;
    case "restaurant":
      if (seg.cuisine) r("Cuisine", esc(seg.cuisine));
      if (seg.party_size) r("Party", `${seg.party_size}`);
      break;
    case "meeting":
      if (seg.meeting_url) r("Link", `<a href="${esc(seg.meeting_url)}" target="_blank" style="color:var(--highlight)">${esc(seg.meeting_url)}</a>`);
      if (seg.attendees) r("Attendees", esc(seg.attendees));
      break;
  }
  if (seg.address) r("Address", esc(seg.address));
  if (seg.cost?.amount) r("Cost", fmtCost(seg.cost.amount, seg.cost.currency));
  if (seg.notes) r("Notes", esc(seg.notes));
  if (seg.tags?.length) r("Tags", seg.tags.map(t => `<span class="travel-tag">${esc(t)}</span>`).join(" "));
  return `<div class="travel-detail-grid">${rows.join("")}</div>`;
}

function renderTravelGap(gap) {
  const labels = { transit: "\ud83d\udeb6 Transit", free: "\u2615 Free time", open: "\ud83d\udcc5 Open block" };
  return `<div class="travel-gap-indicator ${esc(gap.type)}">${labels[gap.type] || gap.type} \u2014 ${esc(gap.duration)}</div>`;
}

// ── Event Binding ──

function bindTravelEvents(sd) {
  // Sidebar tabs
  $$("#travelSpace .text-sidebar-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      $$("#travelSpace .text-sidebar-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      $$("#travelSpace .text-sidebar-panel").forEach(p => p.classList.remove("active"));
      const t = $(`#travelPanel${tab.dataset.panel.charAt(0).toUpperCase() + tab.dataset.panel.slice(1)}`);
      if (t) t.classList.add("active");
    });
  });

  // Day collapse
  $$("#travelDashboard .travel-day-header").forEach(h => h.addEventListener("click", () => h.parentElement.classList.toggle("collapsed")));

  // Section collapse
  $$("#travelDashboard .travel-section-header").forEach(h => h.addEventListener("click", () => h.parentElement.classList.toggle("collapsed")));

  // Segment expand/collapse
  $$("#travelDashboard .travel-seg-card").forEach(card => {
    card.addEventListener("click", (e) => { if (!e.target.closest(".travel-seg-action")) card.classList.toggle("expanded"); });
  });

  // Edit buttons
  $$("#travelDashboard .travel-seg-edit").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const seg = sd.segments.find(s => s.id === btn.dataset.segid);
      if (seg) openTravelSegEdit(seg);
    });
  });

  // Delete buttons
  $$("#travelDashboard .travel-seg-delete").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Delete this segment?")) return;
      try {
        await travelApiDelete(`/items/${spaceItemId}/travel/segments`, { ids: [btn.dataset.segid] });
        const item = await apiGet(`/items/${spaceItemId}`);
        spaceItemData = item;
        renderSpaceTravel(item);
        toast("Segment deleted");
      } catch (e2) { toast("Error: " + e2.message, "error"); }
    });
  });

  // Add segment
  $$("#travelDashboard .travel-add-seg-btn").forEach(btn => {
    btn.addEventListener("click", (e) => { e.stopPropagation(); openTravelAddSeg(btn.dataset.date, sd); });
  });

  // Comments
  const cs = $("#travelCommentSubmit");
  if (cs) cs.addEventListener("click", submitTravelComment);
  const ci = $("#travelCommentInput");
  if (ci) ci.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submitTravelComment(); } });

  // Description auto-save
  const dt = $("#travelDescTA");
  if (dt) dt.addEventListener("input", () => {
    const ind = $("#travelDescInd");
    if (ind) { ind.textContent = "Unsaved..."; ind.className = "engagement-save-indicator"; }
    if (travelSaveTimer) clearTimeout(travelSaveTimer);
    travelSaveTimer = setTimeout(() => saveTravelDesc(), 2000);
  });

  // Trip settings
  ["tvDest", "tvPurpose", "tvTravelers", "tvTz", "tvNotes"].forEach(id => {
    const el = $(`#${id}`);
    if (el) el.addEventListener("change", saveTravelSettings);
  });

  // Scroll to today
  const today = new Date().toISOString().slice(0, 10);
  setTimeout(() => { const el = $(".travel-today"); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }, 150);
}

// ── Discussion ──

function renderTravelDiscussion(comments) {
  const thread = $("#travelDiscussionThread");
  if (!thread) return;
  if (!comments?.length) {
    thread.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:40px 20px;font-size:0.85rem;">No comments yet.</div>';
    return;
  }
  thread.innerHTML = comments.map(c => `<div class="text-comment" data-author="${esc(c.author)}"><div class="text-comment-header"><span class="text-comment-author">${esc(c.author)}</span><span class="text-comment-time">${formatTime(c.created_at)}</span></div><div class="text-comment-body">${renderMarkdown(c.body)}</div></div>`).join("");
  thread.scrollTop = thread.scrollHeight;
}

async function submitTravelComment() {
  const input = $("#travelCommentInput");
  if (!input || !input.value.trim() || !spaceItemId) return;
  const author = (() => { try { return localStorage.getItem(STORAGE_AUTHOR_KEY) || DEFAULT_AUTHOR; } catch { return DEFAULT_AUTHOR; } })();
  try {
    await apiPost(`/items/${spaceItemId}/comments`, { author, body: input.value.trim() });
    input.value = "";
    const item = await apiGet(`/items/${spaceItemId}`);
    spaceItemData = item;
    renderTravelDiscussion(item.comments || []);
    toast("Comment posted");
  } catch (e) { toast("Error: " + e.message, "error"); }
}

// ── Save Helpers ──

async function saveTravelDesc() {
  if (!spaceItemId) return;
  const ta = $("#travelDescTA");
  const ind = $("#travelDescInd");
  if (!ta) return;
  try {
    if (ind) { ind.textContent = "Saving..."; ind.className = "engagement-save-indicator saving"; }
    await apiPatch(`/items/${spaceItemId}`, { description: ta.value, actor: DEFAULT_AUTHOR });
    if (spaceItemData) spaceItemData.description = ta.value;
    if (ind) { ind.textContent = "Saved"; ind.className = "engagement-save-indicator saved"; }
    setTimeout(() => { if (ind?.textContent === "Saved") ind.textContent = ""; }, 3000);
  } catch (e) {
    if (ind) { ind.textContent = "Failed"; ind.className = "engagement-save-indicator"; }
    toast("Save failed: " + e.message, "error");
  }
}

async function saveTravelSettings() {
  if (!spaceItemId) return;
  const existing = parseTravelData(spaceItemData);
  const tv = (id) => ($(`#${id}`) || {}).value || "";
  const data = {
    trip: {
      destination: tv("tvDest"),
      purpose: tv("tvPurpose"),
      travelers: tv("tvTravelers").split(",").map(s => s.trim()).filter(Boolean),
      default_timezone: tv("tvTz"),
      notes: tv("tvNotes"),
    },
    segments: existing.segments,
  };
  try {
    await apiPatch(`/items/${spaceItemId}`, { space_data: JSON.stringify(data), actor: DEFAULT_AUTHOR });
    if (spaceItemData) spaceItemData.space_data = JSON.stringify(data);
    loadTracker();
    toast("Settings saved");
  } catch (e) { toast("Error: " + e.message, "error"); }
}

// ── Add / Edit Segment ──

function openTravelAddSeg(date, sd) {
  const tz = sd.trip.default_timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dt = date ? date + "T09:00" : "";
  const m = document.createElement("div");
  m.className = "travel-form-modal";
  m.innerHTML = `<div class="travel-form-backdrop"></div><div class="travel-form-content">
    <div class="travel-form-title">Add Segment</div>
    <div class="engagement-edit-row"><label>Type</label><select id="tsType">${TRAVEL_SEGMENT_TYPES.map(t => `<option value="${t.value}">${t.icon} ${t.label}</option>`).join("")}</select></div>
    <div class="engagement-edit-row"><label>Title</label><input id="tsTitle" placeholder="e.g. QF 21 SYD to NRT" /></div>
    <div class="engagement-edit-row"><label>Date/Time</label><input id="tsDt" type="datetime-local" value="${esc(dt)}" /></div>
    <div class="engagement-edit-row"><label>Timezone</label><input id="tsTz" value="${esc(tz)}" placeholder="Asia/Tokyo" /></div>
    <div class="engagement-edit-row"><label>Status</label><select id="tsStatus"><option value="confirmed">Confirmed</option><option value="pending" selected>Pending</option><option value="cancelled">Cancelled</option></select></div>
    <div style="display:flex;gap:8px;margin-top:10px;">
      <button class="engagement-edit-btn" id="tsAdd" style="border-color:var(--highlight);color:var(--highlight);">Add</button>
      <button class="engagement-edit-btn" id="tsCancel">Cancel</button>
    </div></div>`;
  document.body.appendChild(m);
  m.querySelector(".travel-form-backdrop").addEventListener("click", () => m.remove());
  m.querySelector("#tsCancel").addEventListener("click", () => m.remove());
  m.querySelector("#tsAdd").addEventListener("click", async () => {
    const type = m.querySelector("#tsType").value;
    const title = m.querySelector("#tsTitle").value.trim();
    if (!title) { toast("Title required", "error"); return; }
    const datetime = m.querySelector("#tsDt").value;
    const timezone = m.querySelector("#tsTz").value.trim() || "UTC";
    const status = m.querySelector("#tsStatus").value;
    const seg = { id: travelSegId(), type, title, status };
    const tp = { datetime, timezone };
    switch (type) {
      case "flight": seg.departure = { ...tp, location: "", detail: "" }; seg.arrival = { datetime: "", timezone, location: "", detail: "" }; break;
      case "lodging": seg.check_in = tp; seg.check_out = { datetime: "", timezone }; break;
      case "transport": seg.origin = { ...tp, location: "", detail: "" }; seg.destination = { datetime: "", timezone, location: "", detail: "" }; break;
      case "activity": seg.start = tp; break;
      case "restaurant": seg.reservation = tp; break;
      case "meeting": seg.start = tp; break;
      case "note": seg.datetime = tp; break;
    }
    try {
      await apiPost(`/items/${spaceItemId}/travel/segments`, { segments: [seg] });
      m.remove();
      const item = await apiGet(`/items/${spaceItemId}`);
      spaceItemData = item;
      renderSpaceTravel(item);
      toast("Segment added");
    } catch (e) { toast("Error: " + e.message, "error"); }
  });
}

function openTravelSegEdit(seg) {
  const st = getTravelSegType(seg.type);
  const m = document.createElement("div");
  m.className = "travel-form-modal";
  let fields = `
    <div class="engagement-edit-row"><label>Type</label><select id="teType">${TRAVEL_SEGMENT_TYPES.map(t => `<option value="${t.value}"${t.value === seg.type ? " selected" : ""}>${t.icon} ${t.label}</option>`).join("")}</select></div>
    <div class="engagement-edit-row"><label>Title</label><input id="teTitle" value="${esc(seg.title)}" /></div>
    <div class="engagement-edit-row"><label>Status</label><select id="teStatus">${Object.entries(TRAVEL_STATUS_LABELS).map(([k, v]) => `<option value="${k}"${k === seg.status ? " selected" : ""}>${v}</option>`).join("")}</select></div>
    <div class="engagement-edit-row"><label>Provider</label><input id="teProvider" value="${esc(seg.provider || "")}" /></div>
    <div class="engagement-edit-row"><label>Confirmation</label><input id="teConf" value="${esc(seg.confirmation || "")}" /></div>
    <div class="engagement-edit-row"><label>Address</label><input id="teAddr" value="${esc(seg.address || "")}" /></div>
    <div class="engagement-edit-row"><label>Location</label><input id="teLoc" value="${esc(seg.location || "")}" placeholder="City for day headers" /></div>
    <div class="engagement-edit-row"><label>Notes</label><textarea id="teNotes" rows="2" style="width:100%;background:rgba(255,255,255,0.06);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);padding:6px;font-size:0.83rem;resize:vertical;outline:none;font-family:inherit;">${esc(seg.notes || "")}</textarea></div>
    <div class="engagement-edit-row"><label>Cost</label><input id="teCostAmt" value="${seg.cost?.amount || ""}" type="number" step="0.01" style="flex:1;" placeholder="Amount" /><input id="teCostCur" value="${esc(seg.cost?.currency || "AUD")}" style="flex:0 0 60px;" /></div>
    <div class="engagement-edit-row"><label>Provider URL</label><input id="teUrl" value="${esc(seg.provider_url || "")}" /></div>
    <div class="engagement-edit-row"><label>Tags</label><input id="teTags" value="${esc((seg.tags || []).join(", "))}" placeholder="Comma-separated" /></div>`;

  // Type-specific fields
  const tp = (label, idDt, idTz, obj) => `<div class="engagement-edit-row"><label>${label}</label><input id="${idDt}" type="datetime-local" value="${esc(obj?.datetime || "")}" /><input id="${idTz}" value="${esc(obj?.timezone || "")}" style="flex:0 0 130px;" placeholder="Timezone" /></div>`;
  const ltp = (label, idDt, idTz, idLoc, idDet, obj) => tp(label, idDt, idTz, obj) + `<div class="engagement-edit-row"><label>${label} Loc</label><input id="${idLoc}" value="${esc(obj?.location || "")}" style="flex:0 0 80px;" /><input id="${idDet}" value="${esc(obj?.detail || "")}" placeholder="Terminal/Gate" /></div>`;
  const txt = (label, id, val) => `<div class="engagement-edit-row"><label>${label}</label><input id="${id}" value="${esc(val || "")}" /></div>`;

  switch (seg.type) {
    case "flight":
      fields += `<div style="font-size:0.8rem;color:var(--text-dim);font-weight:600;margin-top:8px;">Flight</div>` +
        txt("Flight #", "teFlightNum", seg.flight_number) +
        ltp("Departure", "teDepDt", "teDepTz", "teDepLoc", "teDepDet", seg.departure) +
        ltp("Arrival", "teArrDt", "teArrTz", "teArrLoc", "teArrDet", seg.arrival) +
        `<div class="engagement-edit-row"><label>Seat</label><input id="teSeat" value="${esc(seg.seat || "")}" /><label style="min-width:auto;margin-left:8px;">Cabin</label><input id="teCabin" value="${esc(seg.cabin || "")}" /></div>` +
        `<div class="engagement-edit-row"><label>Aircraft</label><input id="teAircraft" value="${esc(seg.aircraft || "")}" /><label style="min-width:auto;margin-left:8px;">Ticket</label><input id="teTicket" value="${esc(seg.ticket_number || "")}" /></div>`;
      break;
    case "lodging":
      fields += `<div style="font-size:0.8rem;color:var(--text-dim);font-weight:600;margin-top:8px;">Lodging</div>` +
        tp("Check-in", "teCiDt", "teCiTz", seg.check_in) +
        tp("Check-out", "teCoDt", "teCoTz", seg.check_out) +
        txt("Property Type", "tePropType", seg.property_type) +
        txt("Room Type", "teRoomType", seg.room_type);
      break;
    case "transport":
      fields += `<div style="font-size:0.8rem;color:var(--text-dim);font-weight:600;margin-top:8px;">Transport</div>` +
        txt("Mode", "teTransType", seg.transport_type) +
        ltp("Origin", "teOrigDt", "teOrigTz", "teOrigLoc", "teOrigDet", seg.origin) +
        ltp("Destination", "teDestDt", "teDestTz", "teDestLoc", "teDestDet", seg.destination) +
        txt("Route #", "teRouteNum", seg.route_number) +
        `<div class="engagement-edit-row"><label>Seat</label><input id="teTransSeat" value="${esc(seg.seat || "")}" /><label style="min-width:auto;margin-left:8px;">Car Type</label><input id="teCarType" value="${esc(seg.car_type || "")}" /></div>`;
      break;
    case "activity":
      fields += `<div style="font-size:0.8rem;color:var(--text-dim);font-weight:600;margin-top:8px;">Activity</div>` +
        txt("Activity Type", "teActType", seg.activity_type) +
        tp("Start", "teActStartDt", "teActStartTz", seg.start) +
        tp("End", "teActEndDt", "teActEndTz", seg.end) +
        `<div class="engagement-edit-row"><label>Duration (min)</label><input id="teActDur" type="number" value="${seg.duration_minutes || ""}" /></div>` +
        txt("Venue", "teVenue", seg.venue);
      break;
    case "restaurant":
      fields += `<div style="font-size:0.8rem;color:var(--text-dim);font-weight:600;margin-top:8px;">Restaurant</div>` +
        tp("Reservation", "teResDt", "teResTz", seg.reservation) +
        txt("Cuisine", "teCuisine", seg.cuisine) +
        `<div class="engagement-edit-row"><label>Party Size</label><input id="tePartySize" type="number" value="${seg.party_size || ""}" /></div>`;
      break;
    case "meeting":
      fields += `<div style="font-size:0.8rem;color:var(--text-dim);font-weight:600;margin-top:8px;">Meeting</div>` +
        tp("Start", "teMtgStartDt", "teMtgStartTz", seg.start) +
        tp("End", "teMtgEndDt", "teMtgEndTz", seg.end) +
        txt("Meeting URL", "teMtgUrl", seg.meeting_url) +
        `<div class="engagement-edit-row"><label>Duration (min)</label><input id="teMtgDur" type="number" value="${seg.duration_minutes || ""}" /></div>` +
        txt("Attendees", "teAttendees", seg.attendees);
      break;
    case "note":
      fields += `<div style="font-size:0.8rem;color:var(--text-dim);font-weight:600;margin-top:8px;">Note</div>` +
        tp("Date/Time", "teNoteDt", "teNoteTz", seg.datetime);
      break;
  }

  m.innerHTML = `<div class="travel-form-backdrop"></div><div class="travel-form-content" style="max-height:80vh;overflow-y:auto;">
    <div class="travel-form-title">${st.icon} Edit: ${esc(seg.title || st.label)}</div>
    ${fields}
    <div style="display:flex;gap:8px;margin-top:10px;">
      <button class="engagement-edit-btn" id="teSave" style="border-color:var(--highlight);color:var(--highlight);">Save</button>
      <button class="engagement-edit-btn" id="teCancel">Cancel</button>
    </div></div>`;
  document.body.appendChild(m);
  m.querySelector(".travel-form-backdrop").addEventListener("click", () => m.remove());
  m.querySelector("#teCancel").addEventListener("click", () => m.remove());
  m.querySelector("#teSave").addEventListener("click", async () => {
    const gv = id => (m.querySelector(`#${id}`) || {}).value || "";
    const gn = id => { const v = gv(id); return v ? Number(v) : null; };
    const tagsStr = gv("teTags");
    const costAmt = gn("teCostAmt");
    const changes = {
      id: seg.id, type: gv("teType"), title: gv("teTitle"), status: gv("teStatus"),
      provider: gv("teProvider"), confirmation: gv("teConf"),
      address: gv("teAddr"), location: gv("teLoc"), notes: gv("teNotes"),
      provider_url: gv("teUrl"),
      tags: tagsStr ? tagsStr.split(",").map(s => s.trim()).filter(Boolean) : [],
      cost: costAmt ? { amount: costAmt, currency: gv("teCostCur") || "AUD" } : null,
    };
    switch (seg.type) {
      case "flight":
        changes.flight_number = gv("teFlightNum");
        changes.departure = { datetime: gv("teDepDt"), timezone: gv("teDepTz"), location: gv("teDepLoc"), detail: gv("teDepDet") };
        changes.arrival = { datetime: gv("teArrDt"), timezone: gv("teArrTz"), location: gv("teArrLoc"), detail: gv("teArrDet") };
        changes.seat = gv("teSeat"); changes.cabin = gv("teCabin");
        changes.aircraft = gv("teAircraft"); changes.ticket_number = gv("teTicket");
        break;
      case "lodging":
        changes.check_in = { datetime: gv("teCiDt"), timezone: gv("teCiTz") };
        changes.check_out = { datetime: gv("teCoDt"), timezone: gv("teCoTz") };
        changes.property_type = gv("tePropType"); changes.room_type = gv("teRoomType");
        break;
      case "transport":
        changes.transport_type = gv("teTransType");
        changes.origin = { datetime: gv("teOrigDt"), timezone: gv("teOrigTz"), location: gv("teOrigLoc"), detail: gv("teOrigDet") };
        changes.destination = { datetime: gv("teDestDt"), timezone: gv("teDestTz"), location: gv("teDestLoc"), detail: gv("teDestDet") };
        changes.route_number = gv("teRouteNum"); changes.seat = gv("teTransSeat"); changes.car_type = gv("teCarType");
        break;
      case "activity":
        changes.activity_type = gv("teActType");
        changes.start = { datetime: gv("teActStartDt"), timezone: gv("teActStartTz") };
        changes.end = { datetime: gv("teActEndDt"), timezone: gv("teActEndTz") };
        changes.duration_minutes = gn("teActDur"); changes.venue = gv("teVenue");
        break;
      case "restaurant":
        changes.reservation = { datetime: gv("teResDt"), timezone: gv("teResTz") };
        changes.cuisine = gv("teCuisine"); changes.party_size = gn("tePartySize");
        break;
      case "meeting":
        changes.start = { datetime: gv("teMtgStartDt"), timezone: gv("teMtgStartTz") };
        changes.end = { datetime: gv("teMtgEndDt"), timezone: gv("teMtgEndTz") };
        changes.meeting_url = gv("teMtgUrl"); changes.duration_minutes = gn("teMtgDur"); changes.attendees = gv("teAttendees");
        break;
      case "note":
        changes.datetime = { datetime: gv("teNoteDt"), timezone: gv("teNoteTz") };
        break;
    }
    try {
      await apiPatch(`/items/${spaceItemId}/travel/segments`, changes);
      m.remove();
      const item = await apiGet(`/items/${spaceItemId}`);
      spaceItemData = item;
      renderSpaceTravel(item);
      toast("Segment updated");
    } catch (e) { toast("Error: " + e.message, "error"); }
  });
}

// ── Helpers ──

async function travelApiDelete(path, body) {
  const token = (() => { try { return localStorage.getItem("tracker_api_token") || ""; } catch { return ""; } })();
  const resp = await fetch(`/api/v1${path}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!resp.ok) { const d = await resp.json().catch(() => ({})); throw new Error(d.error || `HTTP ${resp.status}`); }
  return resp.json();
}

function fmtDayShort(dateStr) {
  try { return new Date(dateStr + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }); } catch { return dateStr; }
}
function fmtDayLong(dateStr) {
  try { return new Date(dateStr + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }); } catch { return dateStr; }
}
function fmtCost(amount, currency) {
  if (!amount) return "";
  const sym = currency === "AUD" ? "$" : currency === "USD" ? "US$" : currency === "GBP" ? "\u00a3" : "$";
  return sym + Number(amount).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function refreshTravelDashboard(item) {
  spaceItemData = item;
  renderSpaceTravel(item);
}

// ── Plugin Registration ──

registerSpacePlugin({
  name: "travel",
  label: "Travel",
  icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></svg>',
  description: "Trip planning workspace with day-by-day itinerary",
  capabilities: { coverImage: true, liveRefresh: true },
  render: renderSpaceTravel,
  refreshDiscussion: renderTravelDiscussion,
  refreshDashboard: refreshTravelDashboard,
  cleanup: () => {
    if (travelSaveTimer) { clearTimeout(travelSaveTimer); travelSaveTimer = null; }
    document.querySelectorAll(".travel-form-modal").forEach(m => m.remove());
  },
});
