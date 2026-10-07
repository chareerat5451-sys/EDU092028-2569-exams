/* ตัวห่อ Netlify Blobs: อ่าน-เขียนแบบ strong consistency (เห็นข้อมูลที่เพิ่งเขียนทันที)
   หากสภาพแวดล้อมไม่รองรับ (BlobsConsistencyError) จะสลับไปใช้โหมดปกติ (eventual) อัตโนมัติ
   ตรรกะหลักถูกเขียนให้ไม่พึ่งการอ่านซ้ำทันทีหลังเขียนอยู่แล้ว จึงยังทำงานถูกต้องในโหมดสำรอง */
export function buildStore(getStore, name, opts = {}) {
  const strong = getStore({ name, consistency: "strong" });
  const eventual = getStore({ name });
  let mode = opts.strong === false ? "eventual" : "strong";
  async function run(fn) {
    if (mode === "strong") {
      try { return await fn(strong); }
      catch (e) {
        if (e && e.name === "BlobsConsistencyError") { mode = "eventual"; if (opts.onFallback) opts.onFallback(); }
        else throw e;
      }
    }
    return await fn(eventual);
  }
  return {
    mode: () => mode,
    async get(key) { return await run(b => b.get(key, { type: "json" })); },
    async set(key, obj) { await run(b => b.set(key, JSON.stringify(obj))); },
    async list(prefix) { const r = await run(b => b.list({ prefix })); return r.blobs.map(x => x.key); },
    async del(key) { await run(b => b.delete(key)); }
  };
}
