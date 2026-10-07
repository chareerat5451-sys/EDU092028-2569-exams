import { randomUUID } from "node:crypto";
import { CRITERIA } from "./criteria.js";

/* ตรรกะหลักของระบบสอบข้อเขียน (แยกจาก Netlify เพื่อให้ทดสอบได้)
   store ที่ส่งเข้ามาต้องมี: get(key) -> object|null, set(key, obj), list(prefix) -> string[], del(key) */

export const MAX_TEXT = 100000;
export const GRACE_MS = 90 * 1000; // เผื่อเวลาส่งคำตอบสุดท้ายหลังหมดเวลาเล็กน้อย (เครือข่ายช้า)
const HOUR = 3600 * 1000;
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAX_FAILS = 10;

export function sanitizeId(s) {
  return String(s || "").trim().replace(/[^A-Za-z0-9._~:@+-]/g, "_").slice(0, 120) || "unknown";
}

export function normName(s) {
  return String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function countWords(text) {
  const t = String(text || "").trim();
  if (!t) return 0;
  try {
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      const seg = new Intl.Segmenter("th", { granularity: "word" });
      let n = 0;
      for (const s of seg.segment(t)) if (s.isWordLike) n++;
      return n;
    }
  } catch (e) { /* ใช้วิธีสำรองด้านล่าง */ }
  return Math.round(t.replace(/\s/g, "").length / 4.5);
}

function res(status, data) { return { status, data }; }

function safeEqual(a, b) {
  a = String(a || ""); b = String(b || "");
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function sanitizePaste(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 200).map(e => ({
    at: Number(e && e.at) || 0,
    length: Math.max(0, Math.floor(Number(e && e.length) || 0))
  }));
}

function sessionInfo(att, now) {
  return { token: att.token, startedAt: att.startedAt, deadlineAt: att.deadlineAt, leaveCount: att.leaveCount, serverNow: now };
}

async function finalize(deps, att, reason, override) {
  const id = sanitizeId(att.studentId);
  const draft = override || (await deps.store.get("draft:" + id));
  const text = (draft && typeof draft.text === "string") ? draft.text : "";
  const pasteEvents = (draft && draft.pasteEvents) || [];
  const now = deps.now();
  const submittedAt = reason === "timeout" ? Math.min(now, att.deadlineAt) : now;
  const wordCount = countWords(text);
  await deps.store.set("final:" + id, {
    text, wordCount, charCount: text.replace(/\s/g, "").length, submittedAt, pasteEvents
  });
  att.status = "submitted";
  att.submittedAt = submittedAt;
  att.submitReason = reason;
  att.wordCount = wordCount;
  att.pasteCount = pasteEvents.length;
  att.maxPaste = pasteEvents.reduce((m, e) => Math.max(m, e.length || 0), 0);
  await deps.store.set("att:" + id, att);
  return att;
}

async function ensureFresh(deps, att) {
  if (att && att.status === "in_progress" && deps.now() > att.deadlineAt + GRACE_MS) {
    return await finalize(deps, att, "timeout");
  }
  return att;
}

async function requireSession(deps, body) {
  const id = sanitizeId(body.studentId);
  const att = await deps.store.get("att:" + id);
  if (!att || !body.token || !safeEqual(body.token, att.token)) {
    return { error: res(403, { ok: false, err: "bad_session" }) };
  }
  return { id, att };
}

async function checkAdmin(deps, ip, passcode) {
  const key = "sys:authfail:" + sanitizeId(ip);
  const rec = (await deps.store.get(key)) || { count: 0, first: 0, lockedUntil: 0 };
  const now = deps.now();
  if (rec.lockedUntil && now < rec.lockedUntil) {
    return { ok: false, out: res(429, { ok: false, err: "too_many_attempts", retryAfterSec: Math.ceil((rec.lockedUntil - now) / 1000) }) };
  }
  if (safeEqual(passcode, deps.passcode)) {
    if (rec.count) await deps.store.set(key, { count: 0, first: 0, lockedUntil: 0 });
    return { ok: true };
  }
  const fresh = !rec.first || now - rec.first > AUTH_WINDOW_MS;
  const count = fresh ? 1 : rec.count + 1;
  const first = fresh ? now : rec.first;
  const lockedUntil = count >= AUTH_MAX_FAILS ? now + AUTH_WINDOW_MS : 0;
  await deps.store.set(key, { count, first, lockedUntil });
  return { ok: false, out: res(401, { ok: false, err: "unauthorized" }) };
}

function validIdentity(body) {
  const f = k => String(body[k] == null ? "" : body[k]).trim();
  const studentId = f("studentId"), name = f("name"), lastname = f("lastname"), section = f("section");
  if (!studentId || !name || !lastname) return { error: res(400, { ok: false, err: "missing_fields" }) };
  if (studentId.length > 40 || name.length > 80 || lastname.length > 80 || section.length > 40) {
    return { error: res(400, { ok: false, err: "field_too_long" }) };
  }
  return { studentId, name, lastname, section };
}

async function openOrResume(deps, body, allowCreate) {
  const v = validIdentity(body);
  if (v.error) return v.error;
  const id = sanitizeId(v.studentId);
  const now = deps.now();
  let att = await deps.store.get("att:" + id);

  if (!att) {
    if (!allowCreate) return res(200, { ok: true, state: "none" });
    att = {
      studentId: v.studentId, name: v.name, lastname: v.lastname, section: v.section,
      token: randomUUID(), startedAt: now, deadlineAt: now + deps.examHours * HOUR,
      status: "in_progress", leaveCount: 0, leaveEvents: [], submittedAt: null, submitReason: null
    };
    await deps.store.set("att:" + id, att);
    return res(200, { ok: true, state: "started", session: sessionInfo(att, now), draft: { text: "", savedAt: 0, pasteEvents: [] } });
  }

  if (normName(att.name) !== normName(v.name) || normName(att.lastname) !== normName(v.lastname)) {
    return res(403, { ok: false, err: "identity_mismatch" });
  }
  att = await ensureFresh(deps, att);
  if (att.status === "submitted") {
    return res(200, { ok: true, state: "submitted", reason: att.submitReason, submittedAt: att.submittedAt });
  }
  const draft = (await deps.store.get("draft:" + id)) || { text: "", savedAt: 0, pasteEvents: [] };
  return res(200, { ok: true, state: "resumed", session: sessionInfo(att, now), draft });
}

async function handleGet(query, ip, passcode, deps) {
  const action = query.action || "";
  const now = deps.now();

  if (action === "ping") {
    await deps.store.get("sys:ping");
    return res(200, { ok: true, serverNow: now, examHours: deps.examHours, consistency: deps.mode ? deps.mode() : "unknown" });
  }

  if (action === "auth" || action === "list" || action === "detail" || action === "rubric") {
    const a = await checkAdmin(deps, ip, passcode);
    if (!a.ok) return a.out;

    if (action === "auth") return res(200, { ok: true });

    if (action === "rubric") return res(200, { ok: true, rubric: deps.rubric || [] });

    if (action === "list") {
      const keys = await deps.store.list("att:");
      const items = await mapLimit(keys, 12, async key => {
        let att = await deps.store.get(key);
        if (!att) return null;
        att = await ensureFresh(deps, att);
        const g = await deps.store.get("grade:" + sanitizeId(att.studentId));
        return {
          studentId: att.studentId, name: att.name, lastname: att.lastname, section: att.section,
          status: att.status, startedAt: att.startedAt, deadlineAt: att.deadlineAt,
          submittedAt: att.submittedAt, submitReason: att.submitReason,
          leaveCount: att.leaveCount, wordCount: att.wordCount || 0,
          pasteCount: att.pasteCount || 0, maxPaste: att.maxPaste || 0,
          gradeTotal: g ? g.total : null, gradedAt: g ? g.gradedAt : null,
          gradePoints: g ? g.points : null, gradeComment: g ? g.comment : ""
        };
      });
      return res(200, { ok: true, serverNow: now, items: items.filter(Boolean) });
    }

    if (action === "detail") {
      const id = sanitizeId(query.studentId);
      let att = await deps.store.get("att:" + id);
      if (!att) return res(404, { ok: false, err: "not_found" });
      att = await ensureFresh(deps, att);
      const grade = await deps.store.get("grade:" + id);
      let body;
      if (att.status === "submitted") {
        const fin = (await deps.store.get("final:" + id)) || { text: "", wordCount: 0, charCount: 0, pasteEvents: [] };
        body = { text: fin.text, wordCount: fin.wordCount, charCount: fin.charCount, pasteEvents: fin.pasteEvents || [] };
      } else {
        const d = (await deps.store.get("draft:" + id)) || { text: "", pasteEvents: [] };
        body = { text: d.text, wordCount: countWords(d.text), charCount: String(d.text || "").replace(/\s/g, "").length, pasteEvents: d.pasteEvents || [] };
      }
      const { token, ...attPublic } = att; // ไม่ส่ง token ออกไป
      return res(200, { ok: true, serverNow: now, att: attPublic, essay: body, grade: grade || null });
    }
  }
  return res(400, { ok: false, err: "unknown_action" });
}

async function handlePost(body, ip, passcode, deps) {
  const action = body.action;
  const now = deps.now();

  if (action === "start") return await openOrResume(deps, body, true);
  if (action === "resume") return await openOrResume(deps, body, false);

  if (action === "save" || action === "leave" || action === "submit") {
    const s = await requireSession(deps, body);
    if (s.error) return s.error;
    const id = s.id;
    let att = await ensureFresh(deps, s.att);

    if (att.status === "submitted") {
      return res(200, { ok: true, state: "submitted", reason: att.submitReason, leaveCount: att.leaveCount });
    }

    const hasText = typeof body.text === "string";
    if (hasText && body.text.length > MAX_TEXT) return res(413, { ok: false, err: "text_too_long" });

    let written = null; // ร่างที่เพิ่งรับมาในคำขอนี้ ใช้ส่งต่อให้ finalize โดยไม่ต้องอ่านซ้ำจากที่เก็บข้อมูล
    async function writeDraft() {
      let paste;
      if (Array.isArray(body.pasteEvents)) paste = sanitizePaste(body.pasteEvents);
      else { const prev = await deps.store.get("draft:" + id); paste = (prev && prev.pasteEvents) || []; }
      written = { text: body.text, savedAt: now, pasteEvents: paste };
      await deps.store.set("draft:" + id, written);
    }

    if (action === "save") {
      if (!hasText) return res(400, { ok: false, err: "missing_text" });
      await writeDraft();
      return res(200, { ok: true, state: "in_progress", savedAt: now, serverNow: now, deadlineAt: att.deadlineAt, leaveCount: att.leaveCount });
    }

    if (action === "leave") {
      const eventId = String(body.eventId || "").slice(0, 64);
      if (!eventId) return res(400, { ok: false, err: "missing_event_id" });
      if (hasText) await writeDraft();
      const dur = (body.durationMs === null || body.durationMs === undefined) ? null : Math.max(0, Number(body.durationMs) || 0);
      const kind = body.kind === "blur" ? "blur" : "hidden";
      const counted = !!body.counted;
      att.leaveEvents = att.leaveEvents || [];
      const existing = att.leaveEvents.find(e => e.id === eventId);
      if (existing) {
        if (dur !== null && (existing.durationMs === null || existing.durationMs === undefined || dur > existing.durationMs)) existing.durationMs = dur;
        if (kind === "hidden") existing.kind = "hidden";
        if (counted && !existing.counted) { existing.counted = true; att.leaveCount++; }
      } else {
        if (att.leaveEvents.length < 500) att.leaveEvents.push({ id: eventId, kind, at: Number(body.at) || now, durationMs: dur, counted });
        if (counted) att.leaveCount++;
      }
      if (att.leaveCount >= deps.maxLeaves) {
        att = await finalize(deps, att, "auto_leave", written);
      } else {
        await deps.store.set("att:" + id, att);
      }
      return res(200, { ok: true, state: att.status, reason: att.submitReason || null, leaveCount: att.leaveCount });
    }

    if (action === "submit") {
      if (hasText) await writeDraft();
      const reason = now > att.deadlineAt ? "timeout" : "manual";
      att = await finalize(deps, att, reason, written);
      return res(200, { ok: true, state: "submitted", reason: att.submitReason, submittedAt: att.submittedAt });
    }
  }

  if (action === "suggest_grade") {
    const a = await checkAdmin(deps, ip, passcode);
    if (!a.ok) return a.out;
    if (!deps.grader) return res(501, { ok: false, err: "grader_not_configured" });
    const id = sanitizeId(body.studentId);
    const att = await deps.store.get("att:" + id);
    if (!att) return res(404, { ok: false, err: "not_found" });
    const fresh = await ensureFresh(deps, att);
    if (fresh.status !== "submitted") return res(400, { ok: false, err: "not_submitted" });
    const fin = await deps.store.get("final:" + id);
    if (!fin || !fin.text) return res(404, { ok: false, err: "no_essay_text" });
    const rubric = (Array.isArray(deps.rubric) && deps.rubric.length) ? deps.rubric : (Array.isArray(body.rubric) ? body.rubric : []);
    if (!rubric.length) return res(400, { ok: false, err: "missing_rubric" });
    try {
      const suggestions = await deps.grader(fin.text, rubric);
      return res(200, { ok: true, suggestions });
    } catch (e) {
      return res(502, { ok: false, err: "grader_failed", detail: String((e && e.message) || e).slice(0, 300) });
    }
  }

  if (action === "grade" || action === "delete") {
    const a = await checkAdmin(deps, ip, passcode);
    if (!a.ok) return a.out;
    const id = sanitizeId(body.studentId);
    const att = await deps.store.get("att:" + id);
    if (!att) return res(404, { ok: false, err: "not_found" });

    if (action === "delete") {
      for (const k of ["att:", "draft:", "final:", "grade:"]) await deps.store.del(k + id);
      return res(200, { ok: true });
    }

    const fresh = await ensureFresh(deps, att);
    if (fresh.status !== "submitted") return res(400, { ok: false, err: "not_submitted" });
    const pts = body.points || {};
    let total = 0;
    const clean = {};
    for (const c of CRITERIA) {
      const p = pts[c.id];
      if (typeof p !== "number" || !Number.isInteger(p) || p < 0 || p > c.max) {
        return res(400, { ok: false, err: "invalid_points", criterion: c.id });
      }
      clean[c.id] = p;
      total += p;
    }
    await deps.store.set("grade:" + id, {
      points: clean, total, comment: String(body.comment || "").slice(0, 3000), gradedAt: now
    });
    return res(200, { ok: true, total });
  }

  return res(400, { ok: false, err: "unknown_action" });
}

export async function handle(req, deps) {
  const { method, query = {}, body = null, ip = "unknown", passcode = "" } = req;
  try {
    if (method === "GET") return await handleGet(query, ip, passcode, deps);
    if (method === "POST") return await handlePost(body || {}, ip, passcode, deps);
    return res(405, { ok: false, err: "method_not_allowed" });
  } catch (e) {
    return res(500, { ok: false, err: "server_error", detail: String((e && e.message) || e) });
  }
}
