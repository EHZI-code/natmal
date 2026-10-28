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

  // 검색 결과만으로 만든다 (상세 view.do는 JSON으로 빈 답이 온다).
  // 한자는 origin 칸에 있다. 같은 표제어(target_code)가 뜻마다 여러 줄로 오거나 sense가 배열일 수 있어 모두 모은다.
  const groups = new Map();
  for (const it of items) {
    const code = String(it.target_code || it.word + "|" + it.sup_no);
    if (!groups.has(code)) groups.set(code, { it, senses: [], types: [] });
    const g = groups.get(code);
    for (const sn of asArray(it.sense)) {
      const d = clean(sn && sn.definition);
      if (d && !g.senses.includes(d)) { g.senses.push(d); g.types.push((sn && sn.type) || ""); }
    }
  }
  return [...groups.values()].slice(0, MAX_ENTRIES).map(({ it, senses, types }) => {
    const origin = clean(it.origin || "");
    return withDialect({
      headword: cleanWord(it.word), supNo: Number(it.sup_no) || 0,
      hanja: /\p{Script=Han}/u.test(origin) ? origin.replace(/[-^]/g, "") : "",
      pos: it.pos && it.pos !== "품사 없음" ? it.pos : "",
      senses: senses.slice(0, 6), types,
    });
  }).filter((e) => e.senses.length);
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
      const o = it.origin || s.origin || s.original_language || "";
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
