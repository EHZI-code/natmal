// 낱말 뜻 찾기 — 표준국어대사전 공개 API, 없으면 우리말샘 공개 API.
// 키는 Vercel 환경 변수(STDICT_KEY, OPENDICT_KEY)에만 두고 브라우저에는 보내지 않는다.
//
// GET /api/dict?q=낱말  →  { query, source, entries: [{ headword, supNo, hanja, pos, kind, region, standard, senses[] }] }

const STDICT = "https://stdict.korean.go.kr/api";
const OPENDICT = "https://opendict.korean.go.kr/api";
const MAX_ENTRIES = 6;

export default async function handler(req, res) {
  const q = String((req.query && req.query.q) || "").trim().slice(0, 40);
  if (!q) return res.status(400).json({ error: "q_required" });

  const stKey = process.env.STDICT_KEY;
  const odKey = process.env.OPENDICT_KEY;
  if (!stKey && !odKey) return res.status(500).json({ error: "no_api_key" });

  try {
    let entries = [];
    let source = "";
    if (stKey) {
      entries = await fromStdict(q, stKey);
      source = "표준국어대사전";
    }
    if (!entries.length && odKey) {
      entries = await fromOpendict(q, odKey);
      source = entries.length ? "우리말샘" : source;
    }
    if (req.query && req.query.debug && stKey) {
      // 확인용: 사전이 보낸 글자를 그대로 보여 준다 (키는 들어 있지 않다)
      const rawText = async (u) => { try { const r = await fetch(u); return `HTTP ${r.status} ` + (await r.text()).slice(0, 2500); } catch (e) { return "fetch error: " + String(e); } };
      const sTxt = await rawText(`${STDICT}/search.do?key=${encodeURIComponent(stKey)}&q=${encodeURIComponent(q)}&req_type=json&num=10&advanced=n&part=word&sort=dict`);
      let code = ""; try { code = String(asArray(JSON.parse(sTxt.replace(/^HTTP \d+ /, "")).channel.item)[0].target_code || ""); } catch (e) {}
      const v1 = code ? await rawText(`${STDICT}/view.do?key=${encodeURIComponent(stKey)}&method=TARGET_CODE&q=${encodeURIComponent(code)}&req_type=json`) : "no code";
      const v2 = code ? await rawText(`${STDICT}/view.do?key=${encodeURIComponent(stKey)}&method=target_code&q=${encodeURIComponent(code)}&req_type=json`) : "no code";
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ code, search: sTxt.slice(0, 800), viewUpper: v1, viewLower: v2 });
    }
    res.setHeader("Cache-Control", "s-maxage=3600");
    return res.status(200).json({ query: q, source, entries });
  } catch (e) {
    return res.status(502).json({ error: "upstream", message: String((e && e.message) || e) });
  }
}

/* ---------- 표준국어대사전 ---------- */

async function fromStdict(q, key) {
  const url = `${STDICT}/search.do?key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}&req_type=json&num=20&advanced=n&part=word&sort=dict`;
  const data = await getJSON(url);
  const items = asArray(data && data.channel && data.channel.item);
  if (!items.length) return [];

  // 같은 표제어 번호(target_code)끼리 묶는다. 검색 결과에는 뜻이 하나씩만 실려 있어서
  // 표제어마다 view.do로 전체 뜻·한자를 다시 받는다.
  const groups = new Map();
  for (const it of items) {
    const code = String(it.target_code || "");
    if (!groups.has(code)) groups.set(code, it);
  }
  const heads = [...groups.values()].slice(0, MAX_ENTRIES);

  const full = await Promise.all(heads.map(async (it) => {
    let view = null;
    if (it.target_code) view = await stdictView(key, it.target_code);
    return stdictEntry(it, view);
  }));
  return full.filter((e) => e.senses.length);
}

// 상세 정보: 응답의 item이 배열일 수도, 객체일 수도 있다
async function stdictView(key, code) {
  for (const method of ["TARGET_CODE", "target_code"]) {
    try {
      const v = await getJSON(`${STDICT}/view.do?key=${encodeURIComponent(key)}&method=${method}&q=${encodeURIComponent(code)}&req_type=json`);
      const item = asArray(v && v.channel && v.channel.item)[0];
      if (item) return item;
    } catch (e) { /* 다음 방식으로 */ }
  }
  return null;
}

function stdictEntry(it, item) {
  const wi = item && (item.word_info || item);
  const word = cleanWord((wi && wi.word) || it.word);
  const supNo = Number(it.sup_no) || 0;

  let hanja = "";
  const origins = asArray(wi && wi.original_language_info).concat(asArray(item && item.original_language_info));
  for (const o of origins) {
    if (/한자/.test(o.language_type || "") || /\p{Script=Han}/u.test(o.original_language || "")) hanja += clean(o.original_language);
  }
  if (!hanja && wi && typeof wi.original_language === "string" && /\p{Script=Han}/u.test(wi.original_language)) hanja = clean(wi.original_language);

  let pos = "";
  const senses = [];
  const types = [];
  for (const p of asArray(wi && wi.pos_info)) {
    if (!pos && p.pos && p.pos !== "품사 없음") pos = p.pos;
    collectSenses(p, senses, types);
  }
  if (!senses.length) {
    for (const s of asArray(it.sense)) if (s.definition) { senses.push(clean(s.definition)); types.push(s.type || ""); }
  }
  if (!pos && it.pos && it.pos !== "품사 없음") pos = it.pos;

  return withDialect({ headword: word, supNo, hanja, pos, senses: senses.slice(0, 6), types });
}

function collectSenses(node, out, types) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach((n) => collectSenses(n, out, types)); return; }
  if (typeof node.definition === "string" && node.definition.trim()) {
    out.push(clean(node.definition));
    types.push(node.type || "");
    return;
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === "object") collectSenses(v, out, types);
  }
}

/* ---------- 우리말샘 ---------- */

async function fromOpendict(q, key) {
  const url = `${OPENDICT}/search?key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}&req_type=json&num=20&advanced=n&part=word&sort=dict`;
  const data = await getJSON(url);
  const items = asArray(data && data.channel && data.channel.item);
  const out = [];
  for (const it of items.slice(0, MAX_ENTRIES)) {
    const senses = [], types = [];
    let pos = "";
    for (const s of asArray(it.sense)) {
      if (s.definition) { senses.push(clean(s.definition)); types.push(s.type || ""); }
      if (!pos && s.pos && s.pos !== "품사 없음") pos = s.pos;
    }
    let hanja = "";
    for (const s of asArray(it.sense)) {
      const o = s.origin || s.original_language || "";
      if (/\p{Script=Han}/u.test(o)) { hanja = clean(o); break; }
    }
    if (senses.length) out.push(withDialect({ headword: cleanWord(it.word), supNo: Number(it.sup_no) || 0, hanja, pos, senses: senses.slice(0, 6), types }));
  }
  return out;
}

/* ---------- 공통 ---------- */

// ‘어머니’의 방언(경상, 전라). → kind 방언, region 경상, standard 어머니
function withDialect(e) {
  let kind = "", region = "", standard = "";
  const first = e.senses[0] || "";
  const m = first.match(/^‘([^’]+)’의\s*(방언|옛말|북한어)(?:\s*\(([^)]*)\))?/);
  if (m) {
    standard = m[1].replace(/[-^]/g, "");
    kind = m[2];
    region = (m[3] || "").split(/[,·]/)[0].trim();
  } else if (e.types.some((t) => /방언/.test(t))) kind = "방언";
  else if (e.types.some((t) => /옛말/.test(t))) kind = "옛말";
  else if (e.types.some((t) => /북한어/.test(t))) kind = "북한어";
  const { types, ...rest } = e;
  return Object.assign(rest, { kind, region, standard });
}

const clean = (s) => String(s || "")
  .replace(/<[^>]+>/g, "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
  .replace(/\s+/g, " ")
  .trim();

// 표제어 표기: 금-어 → 금어, 가-리^늦다 → 가리 늦다
const cleanWord = (s) => clean(s).replace(/-/g, "").replace(/\^/g, " ").replace(/\d+$/, "").trim();

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

async function getJSON(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  try { return JSON.parse(text); }
  catch (e) {
    // 결과가 없으면 빈 본문이나 XML 오류가 오기도 한다
    if (!text.trim() || /<error|<channel/i.test(text)) return null;
    throw new Error("bad_json");
  }
}
