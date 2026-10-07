import { getStore } from "@netlify/blobs";
import { handle } from "../lib/essay-core.js";
import { buildStore } from "../lib/blob-store.js";
import { RUBRIC_FULL } from "../lib/rubric-full.js";

/* ค่าที่ปรับได้ (แนะนำให้ตั้งใน Netlify → Project configuration → Environment variables
   แล้วสั่ง Deploy ใหม่ 1 ครั้ง แทนการแก้ไฟล์นี้):
     ADMIN_PASSCODE     รหัสผ่านอาจารย์ (ตรวจสอบฝั่งเซิร์ฟเวอร์เท่านั้น นักศึกษาไม่มีทางเห็น)
     EXAM_HOURS         จำนวนชั่วโมงต่อคน นับจากกดเริ่ม (ค่าเริ่มต้น 24)
     ANTHROPIC_API_KEY  กุญแจ API ของ Claude (สมัคร/สร้างได้ที่ console.anthropic.com)
                        ใส่ค่านี้ถึงจะใช้ปุ่ม "ให้ AI ช่วยประเมิน" ในหน้าตรวจข้อสอบได้
                        ไม่ใส่ก็ใช้งานส่วนอื่นได้ตามปกติ แค่ปุ่มนี้จะกดไม่ได้
   ถ้าไม่ตั้ง จะใช้ค่าเริ่มต้นด้านล่างนี้ */
const DEFAULT_PASSCODE = "pl092028-2569";
const DEFAULT_EXAM_HOURS = 24;
const DEFAULT_MAX_LEAVES = 4; // ต้องตรงกับ maxLeaves ในหน้าเว็บ (public/index.html) และข้อความในคำชี้แจง
const GRADER_MODEL = "claude-sonnet-5";
let strongOk = true; // จำไว้ข้ามคำขอ: ถ้าโหมด strong ใช้ไม่ได้ในสภาพแวดล้อมนี้ จะไม่ลองซ้ำทุกครั้ง

function env(name) {
  try {
    if (globalThis.Netlify && globalThis.Netlify.env && globalThis.Netlify.env.get) {
      const v = globalThis.Netlify.env.get(name);
      if (v) return v;
    }
  } catch (e) { /* ข้าม */ }
  try { return process.env[name]; } catch (e) { return undefined; }
}

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

/* เรียก Claude API ให้อ่านคำตอบแล้วเสนอคะแนน+เหตุผลตามเกณฑ์ที่ส่งมา
   เป็นเพียงข้อเสนอแนะ ไม่ใช่คะแนนสุดท้าย — อาจารย์ต้องตรวจทานและกดบันทึกเองเสมอ */
async function suggestGrade(essayText, rubric) {
  const apiKey = env("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("missing_api_key");

  const criteriaBlock = rubric.map(c => {
    const levels = (c.levels || []).map(l =>
      `  - ${l.name} (${l.min}-${l.max} คะแนน): ${l.desc}`).join("\n");
    const kp = (c.keyPoints || []).map(k => `  * ${k}`).join("\n");
    return `เกณฑ์ ${c.id}: ${c.title} (คะแนนเต็ม ${c.max})\n${levels}${kp ? "\nแนวคำตอบ/ประเด็นที่ควรพบ:\n" + kp : ""}`;
  }).join("\n\n");

  const prompt = `คุณเป็นผู้ช่วยตรวจข้อสอบอัตนัยระดับบัณฑิตศึกษา อ่านคำตอบของนักศึกษาด้านล่าง แล้วประเมินตามเกณฑ์ที่กำหนดอย่างเคร่งครัดและเป็นกลาง

เกณฑ์การให้คะแนน:
${criteriaBlock}

คำตอบของนักศึกษา:
"""
${essayText}
"""

ให้คะแนนแต่ละเกณฑ์เป็นจำนวนเต็มในช่วงที่กำหนดของเกณฑ์นั้น พร้อมเหตุผลสั้นๆ ภาษาไทย 1-2 ประโยคต่อเกณฑ์ อ้างอิงเนื้อหาที่นักศึกษาเขียนจริงประกอบเหตุผล
ตอบกลับเป็น JSON เท่านั้น ห้ามมีข้อความอื่นนอกเหนือจาก JSON ตามรูปแบบนี้เป๊ะๆ:
{"suggestions":[{"id":"c1","points":0,"reasoning":"..."}]}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: GRADER_MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`anthropic_api_${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find(b => b.type === "text");
  if (!textBlock) throw new Error("no_text_in_response");

  let parsed;
  try {
    const cleaned = textBlock.text.trim().replace(/^```json\s*|\s*```$/g, "");
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error("unparseable_response: " + textBlock.text.slice(0, 200));
  }
  if (!Array.isArray(parsed.suggestions)) throw new Error("bad_shape");
  return parsed.suggestions;
}

export default async (req, context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  const url = new URL(req.url);
  let body = null;
  if (req.method === "POST") {
    try { body = await req.json(); }
    catch (e) { return reply({ ok: false, err: "bad_json" }, 400); }
  }

  let store;
  try {
    store = buildStore(getStore, "essay_pl092028", { strong: strongOk, onFallback: () => { strongOk = false; } });
  } catch (e) {
    return reply({ ok: false, err: "store_unavailable", detail: String((e && e.message) || e) }, 500);
  }

  const hours = Number(env("EXAM_HOURS"));
  const hasApiKey = !!env("ANTHROPIC_API_KEY");
  const result = await handle(
    {
      method: req.method,
      query: Object.fromEntries(url.searchParams),
      body,
      ip: (context && context.ip) || "unknown",
      passcode: req.headers.get("x-admin-passcode") || ""
    },
    {
      store,
      now: () => Date.now(),
      passcode: env("ADMIN_PASSCODE") || DEFAULT_PASSCODE,
      examHours: hours > 0 ? hours : DEFAULT_EXAM_HOURS,
      maxLeaves: DEFAULT_MAX_LEAVES,
      rubric: RUBRIC_FULL,
      mode: () => store.mode(),
      grader: hasApiKey ? suggestGrade : null
    }
  );
  return reply(result.data, result.status);
};
