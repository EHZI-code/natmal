(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const SEP = /[\s,，、·]+/;

  /* ---------- 상태 ---------- */
  let sb = null;             // Supabase client
  let session = null;
  let view = "boot";         // boot | auth | app | setup
  let authMode = "login";    // login | signup | reset | newpass | sent
  let authMsg = "", authErr = false, authBusy = false;

  let words = [];            // sort 오름차순
  let loaded = false;
  let pending = [];          // [{key, raw}]
  let arranging = false;
  let openId = null;         // 편집 칸이 열린 카드
  let pickOpen = null;       // 다른 뜻을 다시 연 카드
  let hj = null;             // 한자 풀이 {id, stack:[]}
  let accountOpen = false;
  let armedDelete = null;
  const drafts = {};

  /* ---------- 날짜·문자 ---------- */
  const z = (n) => String(n).padStart(2, "0");
  const fmtDate = (t) => { const d = new Date(t || Date.now()); return `${d.getFullYear()}/${z(d.getMonth() + 1)}/${z(d.getDate())}`; };
  const isHan = (ch) => /\p{Script=Han}/u.test(ch);
  const newId = () => "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const topOrder = () => (words.length ? Math.min(...words.map((w) => w.sort ?? 0)) - 1 : 0);
  const sortWords = () => words.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const needsPick = (w) => Array.isArray(w.entries) && w.entries.length > 1 && (w.pick === null || w.pick === undefined);

  /* ---------- 시작 ---------- */
  boot();
  async function boot() {
    render();
    let cfg;
    try { cfg = await (await fetch("/api/config", { cache: "no-store" })).json(); } catch (e) { cfg = null; }
    if (!cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase) { view = "setup"; render(); return; }
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    sb.auth.onAuthStateChange((event, s) => {
      session = s;
      if (event === "PASSWORD_RECOVERY") { view = "auth"; authMode = "newpass"; authMsg = ""; render(); return; }
      if (s && view !== "app") startApp();
      if (!s) { view = "auth"; words = []; loaded = false; stopLive(); render(); }
    });
    const { data } = await sb.auth.getSession();
    session = data.session;
    if (session) startApp(); else { view = "auth"; render(); }
    loadHanjaData();
  }

  /* ---------- 저장소 ---------- */
  let live = null;
  async function startApp() {
    if (view === "app") return;
    view = "app"; loaded = false; render();
    await reload();
    startLive();
  }
  async function reload() {
    const { data, error } = await sb.from("words").select("id, body, sort, created_at").order("sort", { ascending: true });
    if (error) { notice("낱말을 불러오지 못했습니다. 잠시 뒤 새로 열어 주세요."); loaded = true; render(); return; }
    words = data.map(rowToWord);
    sortWords(); loaded = true; render();
  }
  const rowToWord = (r) => Object.assign({}, r.body, { id: r.id, sort: r.sort, createdAt: r.body.createdAt || Date.parse(r.created_at) });
  const wordToBody = (w) => { const { id, sort, ...body } = w; return body; };

  function startLive() {
    stopLive();
    live = sb.channel("words-" + session.user.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "words", filter: "user_id=eq." + session.user.id }, (p) => {
        if (p.eventType === "DELETE") words = words.filter((w) => w.id !== p.old.id);
        else { const w = rowToWord(p.new); words = words.filter((x) => x.id !== w.id).concat([w]); }
        sortWords(); render();
      })
      .subscribe();
  }
  function stopLive() { if (live) { sb.removeChannel(live); live = null; } }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && view === "app") reload(); });

  async function putWord(w) {
    words = words.filter((x) => x.id !== w.id).concat([w]); sortWords(); render();
    const { error } = await sb.from("words").upsert({ id: w.id, body: wordToBody(w), sort: w.sort ?? 0 });
    if (error) writeFailed();
  }
  async function patchWord(id, fields) {
    const w = words.find((x) => x.id === id); if (!w) return;
    Object.assign(w, fields); sortWords(); render();
    const { error } = await sb.from("words").update({ body: wordToBody(w), sort: w.sort ?? 0 }).eq("id", id);
    if (error) writeFailed();
  }
  async function removeWord(id) {
    words = words.filter((x) => x.id !== id); render();
    const { error } = await sb.from("words").delete().eq("id", id);
    if (error) writeFailed();
  }
  const writeFailed = () => toast("저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");

  /* ---------- 사전 ---------- */
  const dictCache = {};
  async function dict(q) {
    if (dictCache[q]) return dictCache[q];
    const r = await fetch("/api/dict?q=" + encodeURIComponent(q));
    if (!r.ok) throw new Error("dict " + r.status);
    const d = await r.json();
    const entries = (d.entries || []).map((e) => ({
      headword: e.headword || q, supNo: e.supNo || 0, hanja: e.hanja || "", pos: e.pos || "",
      kind: e.kind || "", region: e.region || "", standard: e.standard || "", senses: (e.senses || []).filter(Boolean),
    })).filter((e) => e.senses.length);
    return (dictCache[q] = entries);
  }
  const entryFields = (e) => ({ headword: e.headword, hanja: e.hanja, pos: e.pos, kind: e.kind, region: e.region, standard: e.standard, senses: e.senses });
  function fromEntries(raw, entries) {
    const base = { raw, headword: raw, hanja: "", pos: "", kind: "", region: "", standard: "", senses: [], entries, pick: null };
    if (entries.length) Object.assign(base, entryFields(entries[0]));
    if (entries.length === 1) base.pick = 0;
    return base;
  }

  async function lookup(raw) {
    raw = raw.trim(); if (!raw) return;
    const hit = words.find((w) => w.raw === raw || w.headword === raw);
    if (hit) { $("#q").value = ""; render(); flash(hit.id); toast(`‘${hit.headword}’은 이미 모아 둔 낱말입니다.`); return; }
    if (pending.some((p) => p.raw === raw)) return;
    $("#q").value = "";
    const key = newId();
    pending.unshift({ key, raw }); render();
    let entries = [], failed = false;
    try { entries = await dict(raw); } catch (e) { failed = true; }
    pending = pending.filter((p) => p.key !== key);
    const w = Object.assign(fromEntries(raw, entries), { id: key, example: "", createdAt: Date.now(), sort: topOrder() });
    await putWord(w);
    flash(key);
    if (failed) toast("사전에 연결하지 못했습니다. 잠시 뒤 ‘다시 찾기’를 눌러 주세요.");
    else if (!entries.length) toast("이 낱말의 뜻은 아직 찾지 못했습니다.");
  }

  async function lookupMany(list) {
    const seen = new Set();
    const todo = list.filter((r) => {
      if (!r || seen.has(r)) return false; seen.add(r);
      return !words.some((w) => w.raw === r || w.headword === r) && !pending.some((p) => p.raw === r);
    });
    const skipped = list.length - todo.length;
    $("#q").value = "";
    if (!todo.length) { render(); toast("모두 이미 모아 둔 낱말입니다."); return; }
    const base = topOrder();
    const items = todo.map((raw, i) => ({ raw, key: newId() + i, sort: base - (todo.length - 1) + i }));
    pending = items.map((it) => ({ key: it.key, raw: it.raw })).concat(pending);
    render();
    let empty = 0, choose = 0, at = 0;
    const worker = async () => {
      while (at < items.length) {
        const it = items[at++];
        let entries = [];
        try { entries = await dict(it.raw); } catch (e) { entries = []; }
        const w = Object.assign(fromEntries(it.raw, entries), { id: it.key, example: "", createdAt: Date.now(), sort: it.sort });
        if (!w.senses.length) empty++;
        if (needsPick(w)) choose++;
        pending = pending.filter((p) => p.key !== it.key);
        await putWord(w);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    toast(`${items.length}개의 낱말을 적어 두었습니다` + (choose ? ` · ${choose}개는 뜻을 골라 주세요` : "") + (empty ? ` · ${empty}개는 뜻을 찾지 못했습니다` : "") + (skipped ? ` · ${skipped}개는 이미 모아 둔 낱말입니다` : ""));
  }

  async function relookup(id) {
    const w = words.find((x) => x.id === id); if (!w) return;
    toast("뜻을 다시 찾아보는 중…");
    delete dictCache[w.raw];
    let entries;
    try { entries = await dict(w.raw); } catch (e) { toast("사전에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요."); return; }
    if (!entries.length) { toast("이 낱말의 뜻은 아직 찾지 못했습니다."); return; }
    const f = fromEntries(w.raw, entries); delete f.raw;
    await patchWord(id, f);
    if (needsPick(f)) pickOpen = id;
    render();
  }

  /* ---------- 한자 데이터 (libhangul) ---------- */
  let hanjaData = null, hanjaLoading = null;
  function loadHanjaData() {
    if (hanjaData || hanjaLoading) return hanjaLoading;
    hanjaLoading = fetch("/hanja.json").then((r) => r.json()).then((d) => { hanjaData = d; render(); }).catch(() => { hanjaLoading = null; });
    return hanjaLoading;
  }
  // 한 글자에 음이 여럿일 수 있다: 金 → [["금","성 금, 쇠 금"], ["김","사람의 성 김, 쇠 김"]]
  const readingsOf = (c) => (hanjaData && hanjaData.chars[c]) || [];
  // 두음 법칙(락↔낙, 녀↔여)을 감안해 낱말 속 소리와 맞는 음을 고른다
  const initialFree = (syl) => {
    const code = (syl || "").charCodeAt(0) - 0xac00;
    if (code < 0 || code > 11171) return syl;
    return String(Math.floor(code / 588)) === "5" || String(Math.floor(code / 588)) === "2" ? String.fromCharCode(0xac00 + 11 * 588 + (code % 588)) : syl;
  };
  function readingFor(c, syl) {
    const rs = readingsOf(c);
    if (!rs.length) return null;
    return rs.find((r) => r[0] === syl) || rs.find((r) => initialFree(r[0]) === initialFree(syl)) || rs[0];
  }
  // 성씨 뜻은 뒤로 미룬다: "성 금, 쇠 금" → ["쇠 금", "성 금"]
  const meaningList = (r) => {
    const ms = (r ? r[1] : "").split(/,\s*/).filter(Boolean);
    return ms.filter((m) => !/^(사람의 )?성 /.test(m)).concat(ms.filter((m) => /^(사람의 )?성 /.test(m)));
  };
  const sylAt = (word, hanja, i) => {
    const ws = Array.from((word || "").replace(/\s/g, "")), hs = Array.from(hanja || "");
    return ws.length === hs.length ? ws[i] : "";
  };
  const partsText = (hanja, word) => {
    if (!hanjaData || !hanja) return "";
    const ps = Array.from(hanja).map((c, i) => isHan(c) ? meaningList(readingFor(c, sylAt(word, hanja, i)))[0] : "").filter(Boolean);
    return ps.length ? `<span class="parts">${ps.map(esc).join('<span class="dot">·</span>')}</span>` : "";
  };

  /* ---------- 그리기 ---------- */
  const naver = (q) => "https://ko.dict.naver.com/#/search?query=" + encodeURIComponent(q);
  const urimal = (q) => "https://opendict.korean.go.kr/search/searchResult?query=" + encodeURIComponent(q);
  const stdictLink = (q) => "https://stdict.korean.go.kr/search/searchResult.do?searchKeyword=" + encodeURIComponent(q);
  const naverHanja = (c) => "https://hanja.dict.naver.com/#/search?query=" + encodeURIComponent(c);
  const cnt = (n) => `<span class="cnt"><span class="pr">(</span>${n}<span class="pr">)</span></span>`;

  function highlight(text, w) {
    let html = esc(text);
    const keys = [w.raw, w.headword, (w.headword || "").replace(/다$/, "")].filter(Boolean).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      const ek = esc(k);
      if (ek && html.includes(ek)) { html = html.split(ek).join("<mark>" + ek + "</mark>"); break; }
    }
    return html;
  }
  const chipsHTML = (e) => {
    const c = [];
    if (e.pos) c.push(`<span class="chip">${esc(e.pos)}</span>`);
    if (e.kind) c.push(`<span class="chip">${esc(e.region ? e.region + " " : "")}${esc(e.kind)}</span>`);
    return c.join("");
  };
  const sensesHTML = (senses) => `<ol class="senses${senses.length === 1 ? " one" : ""}">${senses.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`;
  const hanjaButtons = (str, word) => Array.from(str).map((ch, i) => isHan(ch) ? `<button class="hj" type="button" data-act="hanja" data-c="${esc(ch)}" data-r="${esc(sylAt(word, str, i))}" aria-label="${esc(ch)} 한자 풀이">${esc(ch)}</button>` : esc(ch)).join("");
  const supOf = (w) => {
    if (!Array.isArray(w.entries) || w.entries.length < 2 || w.pick == null) return "";
    const n = (w.entries[w.pick] && w.entries[w.pick].supNo) || w.pick + 1;
    return `<sup class="sn">${n}</sup>`;
  };

  function pickerHTML(w) {
    return `<div class="choices">${w.entries.map((e, i) => `
        <button class="choice" type="button" data-act="pick" data-i="${i}">
          <span class="choice-head"><span class="hw-s">${esc(e.headword)}<sup class="sn">${e.supNo || i + 1}</sup></span>${e.hanja ? `<span class="hanja">${esc(e.hanja)}</span>` : ""}${partsText(e.hanja, e.headword)}<span class="chips">${chipsHTML(e)}</span></span>
          ${e.standard ? `<div class="std">표준어로는 <b>${esc(e.standard)}</b></div>` : ""}
          ${sensesHTML(e.senses)}
        </button>`).join("")}
      </div>`;
  }

  function editorHTML(w) {
    const d = drafts[w.id] || {};
    const sensesVal = d.senses ?? (w.senses || []).join("\n");
    const exVal = d.example ?? (w.example || "");
    const exBlock = `<div class="field">
        <div class="field-head"><label for="ex-${w.id}">읽은 문장</label></div>
        <textarea class="ex-in" id="ex-${w.id}" data-field="example" rows="1" placeholder="낱말을 발견한 문장">${esc(exVal)}</textarea>
      </div>`;
    const snBlock = `<div class="field">
        <div class="field-head"><label for="sn-${w.id}">뜻 (한 줄에 하나)</label></div>
        <textarea id="sn-${w.id}" data-field="senses" rows="1" placeholder="사전에서 찾은 뜻">${esc(sensesVal)}</textarea>
      </div>`;
    const noSense = !(w.senses && w.senses.length);
    return `<div class="editor">${noSense ? snBlock + exBlock : exBlock + snBlock}</div>`;
  }

  function hanjaPanelHTML() {
    const { c, r } = hj.stack[hj.stack.length - 1];
    const top = (extra) => `<div class="field hrow"><div class="hchar"><span class="big">${esc(c)}</span>${extra || ""}</div></div>`;
    if (!hanjaData) return `<div class="editor hpanel">${top(`<span class="hmeta">풀이를 불러오는 중…</span>`)}</div>`;
    const rd = readingFor(c, r);
    if (!rd) return `<div class="editor hpanel">${top(`<span class="hmeta">풀이가 없는 한자입니다.</span>`)}</div>`;
    // 고른 음의 뜻을 먼저, 다른 음의 뜻을 뒤에
    const hunList = meaningList(rd).concat(...readingsOf(c).filter((x) => x !== rd).map(meaningList));
    const rel = ((hanjaData.rel && hanjaData.rel[c]) || []).slice(0, 8).map((s) => { const [word, hanja] = s.split(":"); return { word, hanja }; });
    const rows = rel.map((x) => {
      const saved = words.some((w) => w.headword === x.word || w.raw === x.word);
      const m = relMeaning(x.word);
      return `<div class="field hrel">
        <div class="choice-head"><span class="hw-s">${esc(x.word)}</span><span class="hanja">${relHanja(x.hanja, c, x.word)}</span>
          <span class="hadd">${saved ? `<span class="hmeta">모아 둔 낱말</span>` : `<button class="act" data-act="hadd" data-w="${esc(x.word)}" type="button">+ 단어장에 넣기</button>`}</span></div>
        <div class="hrel-m">${m === null ? `<span class="hmeta">뜻을 불러오는 중…</span>` : m ? esc(m) : `<span class="hmeta">뜻을 찾지 못했습니다.</span>`}</div>
      </div>`;
    }).join("");
    const means = hunList.length > 1 ? `<div class="field hmeans">${sensesHTML(hunList)}</div>` : "";
    return `<div class="editor hpanel">
      ${top(`<span class="hun">${esc(hunList[0])}</span>`)}
      ${means}
      ${rows ? `<div class="field hrel-title"><div class="field-head"><span class="flabel">${esc(c)} 자가 쓰인 낱말 · 다른 한자를 누르면 그 한자로 넘어갑니다</span></div></div>${rows}` : ""}
    </div>`;
  }
  const relHanja = (str, cur, word) => Array.from(str || "").map((ch, i) =>
    ch === cur ? `<span class="hcur">${esc(ch)}</span>` : isHan(ch) ? `<button class="hj" type="button" data-act="hgo" data-c="${esc(ch)}" data-r="${esc(sylAt(word, str, i))}">${esc(ch)}</button>` : esc(ch)).join("");

  // 관련 낱말 뜻: 사전에서 첫 뜻만 가져와 기억해 둔다 (null = 불러오는 중)
  const relMeanings = {};
  function relMeaning(word) {
    if (word in relMeanings) return relMeanings[word];
    relMeanings[word] = null;
    relQueue.push(word); pumpRel();
    return null;
  }
  const relQueue = []; let relRunning = 0;
  function pumpRel() {
    while (relRunning < 3 && relQueue.length) {
      const w = relQueue.shift(); relRunning++;
      dict(w).then((es) => { relMeanings[w] = (es[0] && es[0].senses[0]) || ""; })
        .catch(() => { relMeanings[w] = ""; })
        .finally(() => { relRunning--; renderSoon(); pumpRel(); });
    }
  }
  let renderTimer = 0;
  const renderSoon = () => { clearTimeout(renderTimer); renderTimer = setTimeout(render, 60); };

  function cardHTML(w, i, total, isExample) {
    const picking = !isExample && (needsPick(w) || pickOpen === w.id) && Array.isArray(w.entries) && w.entries.length > 1;
    const order = arranging && !isExample ? `<div class="order">
        <button class="btn" data-act="top" ${i === 0 ? "disabled" : ""} aria-label="맨 위로">⤒</button>
        <button class="btn" data-act="up" ${i === 0 ? "disabled" : ""} aria-label="위로">↑</button>
        <button class="btn" data-act="down" ${i === total - 1 ? "disabled" : ""} aria-label="아래로">↓</button>
        <button class="btn btn-danger${armedDelete === w.id ? " armed" : ""}" data-act="del">${armedDelete === w.id ? "정말 지우기" : "지우기"}</button>
      </div>` : "";
    let body;
    if (picking) body = pickerHTML(w);
    else {
      const std = w.standard ? `<p class="std">표준어로는 <b>${esc(w.standard)}</b></p>` : "";
      const raw = w.raw && w.raw !== w.headword ? `<div class="raw">찾은 꼴: ${esc(w.raw)}</div>` : "";
      const senses = w.senses && w.senses.length ? sensesHTML(w.senses) : `<p class="empty-sense">이 낱말의 뜻은 아직 비어 있습니다.</p>`;
      const ex = w.example ? `<p class="ex">${highlight(w.example, w)}</p>` : "";
      body = raw + std + senses + ex;
    }
    const hjOpen = !isExample && hj && hj.id === w.id && !picking;
    const open = openId === w.id && !isExample && !picking && !hjOpen;
    const others = Array.isArray(w.entries) && w.entries.length > 1;
    const links = `<a href="${naver(w.headword)}" target="_blank" rel="noopener">네이버</a>
        <a href="${urimal(w.headword)}" target="_blank" rel="noopener">우리말샘</a>`;
    let acts;
    if (hjOpen) {
      const cur = hj.stack[hj.stack.length - 1].c, prev = hj.stack[hj.stack.length - 2];
      acts = `${prev ? `<button class="btn btn-ghost" data-act="hback" type="button">← ${esc(prev.c)}</button>` : ""}
        <button class="btn btn-ghost" data-act="hclose" type="button">닫기</button>
        <a href="${naverHanja(cur)}" target="_blank" rel="noopener">네이버 한자사전</a>`;
    } else if (open) acts = `<button class="btn btn-ghost" data-act="cancel" type="button">취소</button>
        <button class="btn btn-ghost btn-strong" data-act="save" type="button">저장</button>`;
    else if (picking) acts = (needsPick(w) ? "" : `<button class="btn btn-ghost" data-act="pickclose" type="button">닫기</button>`) + links;
    else acts = `<button class="btn btn-ghost" data-act="edit" type="button">${!(w.senses && w.senses.length) ? "뜻 넣기" : w.example ? "고치기" : "예문 넣기"}</button>
        ${others ? `<button class="btn btn-ghost" data-act="pickopen" type="button">다른 뜻${cnt(w.entries.length)}</button>` : ""}
        <button class="btn btn-ghost" data-act="relookup" type="button">다시 찾기</button>
        ${links}`;
    const foot = isExample ? "" : `<footer class="card-foot">${acts}<span class="date">${fmtDate(w.createdAt)}</span></footer>`;
    const headHanja = !picking && w.hanja ? `<span class="hanja">${hanjaButtons(w.hanja, w.headword)}</span>${partsText(w.hanja, w.headword)}` : "";
    return `<article class="card${isExample ? " example" : ""}${open || picking || hjOpen ? " open" : ""}" data-id="${esc(w.id)}">
      ${isExample ? `<div class="label-ex">예시 카드</div>` : ""}
      <div class="card-head"><h2 class="hw">${esc(picking ? w.raw : w.headword)}${picking ? "" : supOf(w)}</h2>${headHanja}${picking ? `<span class="choose-note">여러 뜻 가운데 찾고 있던 것을 골라 보세요.</span>` : `<div class="chips">${chipsHTML(w)}</div>`}${order}</div>
      ${body}${open ? editorHTML(w) : ""}${hjOpen ? hanjaPanelHTML() : ""}${foot}
    </article>`;
  }

  /* ---------- 계정 ---------- */
  let pwBusy = false, mailBusy = false;
  function accountHTML() {
    const times = words.map((w) => w.createdAt).filter(Boolean);
    const first = times.length ? Math.min(...times) : null, last = times.length ? Math.max(...times) : null;
    const withEx = words.filter((w) => w.example).length;
    const email = (session && session.user && session.user.email) || "";
    const joined = session && session.user && session.user.created_at ? fmtDate(Date.parse(session.user.created_at)) : "";
    return `<section class="card open account">
      <div class="card-head"><h2 class="hw">계정</h2></div>
      <div class="editor">
        <div class="field"><div class="field-head"><span class="flabel">로그인</span></div>
          <div class="acc-v">${esc(email)}</div>
          ${joined ? `<div class="acc-s"><span>가입 ${joined}</span></div>` : ""}</div>
        <div class="field"><div class="field-head"><span class="flabel">기록</span></div>
          <div class="acc-v">모은 낱말 ${words.length}개 · 예문이 있는 낱말 ${withEx}개</div>
          ${first ? `<div class="acc-s"><span>처음 기록 ${fmtDate(first)}</span><span>마지막 기록 ${fmtDate(last)}</span></div>` : ""}</div>
        <div class="field"><div class="field-head"><span class="flabel">백업</span></div>
          <div class="acc-v">모은 낱말을 내 메일로 보내 두거나 파일로 내려받습니다. 되살릴 때는 백업 파일을 불러오세요. 이미 있는 낱말은 건너뜁니다.</div>
          <div class="acc-acts"><button class="act" data-act="acc-mail" type="button"${mailBusy ? " disabled" : ""}>${mailBusy ? "보내는 중…" : "메일로 백업 보내기"}</button><button class="act" data-act="acc-json" type="button">백업 파일 내려받기 (JSON)</button><button class="act" data-act="acc-csv" type="button">표로 내려받기 (CSV)</button><button class="act" data-act="acc-import" type="button">백업 불러오기</button></div></div>
        <div class="field"><div class="field-head"><label for="newpw">비밀번호 바꾸기</label><button class="act" data-act="acc-pw" type="button"${pwBusy ? " disabled" : ""}>${pwBusy ? "바꾸는 중…" : "바꾸기"}</button></div>
          <input id="newpw" type="password" autocomplete="new-password" placeholder="새 비밀번호 (6자 이상)"></div>
      </div>
      <footer class="card-foot"><button class="btn btn-ghost" data-act="acc-close" type="button">닫기</button><button class="btn btn-ghost" data-act="acc-logout" type="button">로그아웃</button></footer>
    </section>`;
  }

  function saveFile(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const stamp = () => { const d = new Date(); return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}`; };

  async function accountAction(act, b) {
    if (act === "acc-close") { accountOpen = false; render(); return; }
    if (act === "acc-logout") { await sb.auth.signOut(); accountOpen = false; return; }
    if (act === "acc-json") {
      saveFile(`낱말장-백업-${stamp()}.json`, JSON.stringify({ app: "natmal", version: 2, exportedAt: new Date().toISOString(), words }, null, 2), "application/json");
      toast("백업 파일을 내려받았습니다.");
    }
    if (act === "acc-csv") {
      const q = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
      const rows = [["낱말", "한자", "품사", "뜻", "예문", "기록한 날"]].concat(words.map((w) => [w.headword, w.hanja, w.pos, (w.senses || []).map((x, i) => `${i + 1}. ${x}`).join(" "), w.example, fmtDate(w.createdAt)]));
      saveFile(`낱말장-${stamp()}.csv`, "﻿" + rows.map((r) => r.map(q).join(",")).join("\r\n"), "text/csv");
      toast("표 파일을 내려받았습니다.");
    }
    if (act === "acc-mail") {
      mailBusy = true; render();
      let ok = false, to = "";
      try {
        const { data } = await sb.auth.getSession();
        const r = await fetch("/api/backup-mail", { method: "POST", headers: { Authorization: "Bearer " + (data.session && data.session.access_token) } });
        const j = await r.json().catch(() => ({}));
        ok = r.ok && j.ok; to = j.to || "";
      } catch (e) { ok = false; }
      mailBusy = false; render();
      toast(ok ? `${to}로 백업을 보냈습니다.` : "메일을 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
      return;
    }
    if (act === "acc-import") { $("#import-input").value = ""; $("#import-input").click(); }
    if (act === "acc-pw") {
      const pw = ($("#newpw") || {}).value || "";
      if (pw.length < 6) { toast("비밀번호는 6자 이상이어야 합니다."); return; }
      pwBusy = true; render();
      const { error } = await sb.auth.updateUser({ password: pw });
      pwBusy = false; render();
      toast(error ? "비밀번호를 바꾸지 못했습니다. 잠시 뒤 다시 시도해 주세요." : "비밀번호를 바꾸었습니다.");
    }
  }

  // 백업 불러오기: 지금 앱(Claude) 백업과 이 앱 백업 모두 받는다
  $("#import-input").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); } catch (err) { toast("백업 파일을 읽을 수 없습니다."); return; }
    const list = Array.isArray(data) ? data : Array.isArray(data && data.words) ? data.words : null;
    if (!list) { toast("낱말장 백업 파일이 아닙니다."); return; }
    const have = new Set(words.map((w) => w.headword + "|" + (w.raw || "")));
    const rows = [];
    let skipped = 0;
    for (const x of list) {
      if (!x || !x.headword) continue;
      const k = x.headword + "|" + (x.raw || "");
      if (have.has(k)) { skipped++; continue; }
      have.add(k);
      const w = {
        id: String(x.id || newId()), raw: x.raw || x.headword, headword: x.headword, hanja: x.hanja || "", pos: x.pos || "",
        kind: x.kind || "", region: x.region || "", standard: x.standard || "", senses: Array.isArray(x.senses) ? x.senses : [],
        entries: Array.isArray(x.entries) ? x.entries.map((e) => ({ headword: e.headword || x.headword, supNo: e.supNo || 0, hanja: e.hanja || "", pos: e.pos || "", kind: e.kind || "", region: e.region || "", standard: e.standard || "", senses: e.senses || [] })) : [],
        pick: x.pick ?? (Array.isArray(x.entries) && x.entries.length === 1 ? 0 : null),
        example: x.example || "", createdAt: x.createdAt || Date.now(),
      };
      w.sort = typeof x.sort === "number" ? x.sort : typeof x.order === "number" ? x.order : rows.length;
      rows.push(w);
    }
    if (!rows.length) { toast(skipped ? "모두 이미 모아 둔 낱말입니다." : "불러올 낱말이 없습니다."); return; }
    toast(`${rows.length}개를 불러오는 중…`);
    const { error } = await sb.from("words").upsert(rows.map((w) => ({ id: w.id, body: wordToBody(w), sort: w.sort })));
    if (error) { toast("불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요."); return; }
    await reload();
    toast(`${rows.length}개의 낱말을 불러왔습니다` + (skipped ? ` · ${skipped}개는 이미 모아 둔 낱말입니다` : ""));
  });

  /* ---------- 로그인 화면 ---------- */
  function authHTML() {
    const T = { login: "로그인", signup: "가입하기", reset: "비밀번호 찾기", newpass: "새 비밀번호", sent: "메일을 확인해 주세요" }[authMode];
    const intro = {
      login: "이메일과 비밀번호로 로그인합니다. 어느 기기에서든 같은 낱말장이 보입니다.",
      signup: "이메일과 비밀번호를 정하면 가입 확인 메일이 갑니다. 메일의 링크를 누르면 가입이 끝납니다.",
      reset: "가입한 이메일을 적으면 비밀번호를 다시 정하는 링크를 보내 드립니다.",
      newpass: "새로 쓸 비밀번호를 적어 주세요.",
      sent: authMsg,
    }[authMode];
    const email = `<div class="field"><div class="field-head"><label for="au-email">이메일</label></div><input id="au-email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com"></div>`;
    const pw = (id, ph, ac) => `<div class="field"><div class="field-head"><label for="${id}">비밀번호</label></div><input id="${id}" type="password" autocomplete="${ac}" placeholder="${ph}"></div>`;
    let fields = "", acts = "";
    if (authMode === "login") {
      fields = email + pw("au-pw", "비밀번호", "current-password");
      acts = `<button class="btn btn-ghost btn-strong" data-act="au-login" type="submit">로그인</button><button class="btn btn-ghost" data-act="au-to-signup" type="button">가입하기</button><button class="btn btn-ghost" data-act="au-to-reset" type="button">비밀번호를 잊었습니다</button>`;
    } else if (authMode === "signup") {
      fields = email + pw("au-pw", "6자 이상", "new-password");
      acts = `<button class="btn btn-ghost btn-strong" data-act="au-signup" type="submit">가입하기</button><button class="btn btn-ghost" data-act="au-to-login" type="button">로그인으로 돌아가기</button>`;
    } else if (authMode === "reset") {
      fields = email;
      acts = `<button class="btn btn-ghost btn-strong" data-act="au-reset" type="submit">링크 보내기</button><button class="btn btn-ghost" data-act="au-to-login" type="button">로그인으로 돌아가기</button>`;
    } else if (authMode === "newpass") {
      fields = pw("au-newpw", "6자 이상", "new-password");
      acts = `<button class="btn btn-ghost btn-strong" data-act="au-newpass" type="submit">비밀번호 정하기</button>`;
    } else {
      acts = `<button class="btn btn-ghost" data-act="au-to-login" type="button">로그인으로 돌아가기</button>`;
    }
    return `<form class="card open auth account" id="auth-form" novalidate>
      <div class="card-head"><h2 class="hw">${T}</h2></div>
      <p class="auth-intro">${esc(intro)}</p>
      ${fields ? `<div class="editor">${fields}</div>` : ""}
      ${authMsg && authMode !== "sent" ? `<p class="auth-msg${authErr ? " err" : ""}">${esc(authMsg)}</p>` : ""}
      <footer class="card-foot">${authBusy ? `<span class="hmeta">잠시만요…</span>` : acts}</footer>
    </form>`;
  }

  const authError = (e) => {
    const m = String((e && e.message) || "");
    if (/Invalid login credentials/i.test(m)) return "이메일이나 비밀번호가 맞지 않습니다.";
    if (/Email not confirmed/i.test(m)) return "가입 확인 메일의 링크를 먼저 눌러 주세요.";
    if (/already registered/i.test(m)) return "이미 가입한 이메일입니다. 로그인해 주세요.";
    if (/at least 6|Password should be/i.test(m)) return "비밀번호는 6자 이상이어야 합니다.";
    if (/rate limit|too many/i.test(m)) return "요청이 많습니다. 잠시 뒤 다시 시도해 주세요.";
    if (/valid email|invalid.*email/i.test(m)) return "이메일 주소를 다시 확인해 주세요.";
    return "처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.";
  };

  async function authAction(act) {
    const val = (id) => (($("#" + id) || {}).value || "").trim();
    const go = (mode) => { authMode = mode; authMsg = ""; authErr = false; render(); const f = $("#auth-form input"); if (f) f.focus(); };
    if (act === "au-to-signup") return go("signup");
    if (act === "au-to-login") return go("login");
    if (act === "au-to-reset") return go("reset");
    const email = val("au-email"), pw = ($("#au-pw") || {}).value || "", npw = ($("#au-newpw") || {}).value || "";
    const fail = (msg) => { authBusy = false; authMsg = msg; authErr = true; render(); };
    authBusy = true; authMsg = ""; render();
    if (act === "au-login") {
      if (!email || !pw) return fail("이메일과 비밀번호를 적어 주세요.");
      const { error } = await sb.auth.signInWithPassword({ email, password: pw });
      authBusy = false;
      if (error) return fail(authError(error));
      return;
    }
    if (act === "au-signup") {
      if (!email || pw.length < 6) return fail("이메일과 6자 이상의 비밀번호를 적어 주세요.");
      const { data, error } = await sb.auth.signUp({ email, password: pw, options: { emailRedirectTo: location.origin } });
      authBusy = false;
      if (error) return fail(authError(error));
      if (data && data.session) return; // 메일 확인을 끈 경우 바로 로그인
      authMode = "sent"; authMsg = `${email}로 가입 확인 메일을 보냈습니다. 메일의 링크를 누르면 낱말장이 열립니다.`; authErr = false; render();
      return;
    }
    if (act === "au-reset") {
      if (!email) return fail("가입한 이메일을 적어 주세요.");
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
      authBusy = false;
      if (error) return fail(authError(error));
      authMode = "sent"; authMsg = `${email}로 비밀번호를 다시 정하는 링크를 보냈습니다.`; authErr = false; render();
      return;
    }
    if (act === "au-newpass") {
      if (npw.length < 6) return fail("비밀번호는 6자 이상이어야 합니다.");
      const { error } = await sb.auth.updateUser({ password: npw });
      authBusy = false;
      if (error) return fail(authError(error));
      toast("비밀번호를 정했습니다.");
      authMode = "login";
      if (session) { view = "boot"; startApp(); } else render();
    }
  }

  /* ---------- 화면 ---------- */
  function render() {
    const inApp = view === "app";
    $("#headtools").hidden = !inApp;
    $("#searchband").hidden = !inApp;
    const list = $("#list");

    if (view === "boot") { list.innerHTML = `<div class="empty"><p>불러오는 중…</p></div>`; return; }
    if (view === "setup") {
      list.innerHTML = `<div class="empty"><p>아직 연결이 끝나지 않았습니다. Vercel의 환경 변수 SUPABASE_URL, SUPABASE_ANON_KEY를 확인해 주세요.</p></div>`;
      return;
    }
    if (view === "auth") {
      // 입력 중이던 값은 다시 그려도 남긴다
      const keep = {}; list.querySelectorAll("input").forEach((i) => { keep[i.id] = i.value; });
      list.innerHTML = authHTML();
      Object.keys(keep).forEach((id) => { const i = document.getElementById(id); if (i) i.value = keep[id]; });
      return;
    }

    const qRaw = $("#q").value.trim();
    const multi = SEP.test(qRaw);
    const q = multi ? "" : qRaw;
    const filtered = q ? words.filter((w) => [w.raw, w.headword, w.standard, ...(w.senses || []), w.example].join(" ").includes(q)) : words;
    let html = "";
    if (!q) html += pending.map((p) => `<article class="card pending"><h2 class="hw">${esc(p.raw)}</h2><span class="dots">뜻을 찾는 중…</span></article>`).join("");

    const count = $("#count");
    if (!loaded) count.textContent = "불러오는 중";
    else if (multi) count.innerHTML = `${qRaw.split(SEP).filter(Boolean).length}개의 낱말을 한 번에 찾아봅니다.`;
    else if (!words.length && !pending.length) {
      count.textContent = "아직 모아 둔 낱말이 없습니다.";
      html += `<div class="empty"><p>낯선 낱말을 발견했다면 이곳에 모아 보세요. 낱말의 여러 뜻 중 기억하고 싶은 뜻을 골라 보세요. 전에 쓰던 낱말장이 있다면 ‘계정’에서 백업을 불러올 수 있습니다.</p></div>`;
    } else if (q) count.textContent = filtered.length ? "이미 모아 둔 낱말입니다. 필요하다면 뜻을 다시 살펴보세요." : "아직 모으지 않은 낱말입니다. 찾기를 눌러 뜻을 찾아보세요.";
    else {
      const toPick = words.filter(needsPick).length;
      count.innerHTML = `모은 낱말 ${words.length}개` + (toPick ? ` · <span class="long">뜻을 고르지 않은 낱말</span><span class="short">고를 뜻</span> ${toPick}개` : "");
    }
    if (loaded) html += filtered.map((w) => cardHTML(w, words.indexOf(w), words.length, false)).join("");
    if (accountOpen) html = accountHTML() + html;

    // 열려 있는 입력칸의 글과 커서는 다시 그려도 남긴다
    const act = document.activeElement;
    const focusId = act && list.contains(act) && act.id ? act.id : null;
    const sel = focusId && act.selectionStart != null ? [act.selectionStart, act.selectionEnd] : null;
    const pwVal = ($("#newpw") || {}).value;
    list.innerHTML = html;
    if (pwVal && $("#newpw")) $("#newpw").value = pwVal;
    if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); if (sel && el.setSelectionRange) el.setSelectionRange(sel[0], sel[1]); } }
    list.querySelectorAll(".editor textarea").forEach(grow);

    $("#arrange").hidden = !words.length || !!q;
    $("#arrange").textContent = arranging ? "정리 끝" : "정리하기";
    $("#go").textContent = q && words.some((w) => w.raw === q || w.headword === q) ? "보기" : "찾기";
  }

  /* ---------- 알림 ---------- */
  function notice(msg) { const n = $("#notice"); n.textContent = msg; n.hidden = !msg; }
  let toastTimer;
  function toast(msg, action) {
    const t = $("#toast");
    t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ""}`;
    t.hidden = false;
    if (action) t.querySelector("button").onclick = () => { t.hidden = true; action.run(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, action ? 6000 : 3200);
  }
  let flashTimer;
  function flash(id) {
    const el = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
    el.classList.add("flash"); clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove("flash"), 1600);
  }
  const grow = (t) => { t.style.height = "auto"; t.style.height = t.scrollHeight + "px"; };

  /* ---------- 입력 ---------- */
  $("#search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const parts = $("#q").value.split(SEP).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) lookupMany(parts); else lookup(parts[0] || "");
  });
  $("#q").addEventListener("input", render);
  $("#arrange").addEventListener("click", () => { arranging = !arranging; armedDelete = null; render(); });
  $("#account").addEventListener("click", () => { accountOpen = !accountOpen; render(); if (accountOpen) window.scrollTo({ top: 0 }); });

  $("#list").addEventListener("submit", (e) => {
    if (e.target.id !== "auth-form") return;
    e.preventDefault();
    const b = e.target.querySelector('[type="submit"]');
    if (b && !authBusy) authAction(b.dataset.act);
  });

  $("#list").addEventListener("input", (e) => {
    if (e.target.tagName === "TEXTAREA") grow(e.target);
    const f = e.target.dataset.field; if (!f) return;
    const id = e.target.closest(".card").dataset.id;
    drafts[id] = Object.assign(drafts[id] || {}, { [f]: e.target.value });
  });

  $("#list").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]"); if (!b) return;
    const act = b.dataset.act;
    if (act.startsWith("au-")) { if (b.type !== "submit") { e.preventDefault(); if (!authBusy) authAction(act); } return; }
    if (act.startsWith("acc-")) { accountAction(act, b); return; }
    const card = b.closest(".card"); const id = card && card.dataset.id;
    const i = words.findIndex((w) => w.id === id); const w = words[i];
    if (!w) return;
    if (act !== "del") armedDelete = null;

    if (act === "hanja") { hanjaGo(id, b.dataset.c, b.dataset.r, true); return; }
    if (act === "hgo") { hanjaGo(id, b.dataset.c, b.dataset.r, false); return; }
    if (act === "hback") { if (hj && hj.stack.length > 1) { hj.stack.pop(); render(); } return; }
    if (act === "hclose") { hj = null; render(); return; }
    if (act === "hadd") { b.disabled = true; b.textContent = "적는 중…"; lookup(b.dataset.w).then(render); return; }

    if (act === "pick") {
      const k = Number(b.dataset.i); const entry = w.entries[k];
      if (!entry) return;
      pickOpen = null;
      patchWord(id, Object.assign(entryFields(entry), { pick: k }));
      toast(`‘${entry.headword}’의 ${entry.supNo || k + 1}번 뜻으로 적어 두었습니다.`);
    }
    else if (act === "pickopen") { pickOpen = id; openId = null; hj = null; render(); }
    else if (act === "pickclose") { pickOpen = null; render(); }
    else if (act === "edit") { openId = openId === id ? null : id; hj = null; render(); }
    else if (act === "cancel") { delete drafts[id]; openId = null; render(); }
    else if (act === "save") {
      const d = drafts[id] || {};
      const fields = {};
      if (d.example !== undefined) fields.example = d.example.trim();
      if (d.senses !== undefined) fields.senses = d.senses.split("\n").map((s) => s.trim()).filter(Boolean);
      delete drafts[id]; openId = null;
      if (Object.keys(fields).length) { patchWord(id, fields); toast("낱말을 적어 두었습니다."); } else render();
    }
    else if (act === "relookup") relookup(id);
    else if (act === "up" && i > 0) swap(i, i - 1);
    else if (act === "down" && i < words.length - 1) swap(i, i + 1);
    else if (act === "top" && i > 0) patchWord(id, { sort: topOrder() });
    else if (act === "del") {
      if (armedDelete !== id) { armedDelete = id; render(); return; }
      armedDelete = null;
      const copy = Object.assign({}, w);
      removeWord(id);
      toast(`‘${w.headword}’을 지웠습니다.`, { label: "되돌리기", run: () => putWord(copy) });
    }
  });

  function hanjaGo(id, c, r, fresh) {
    if (!c) return;
    const item = { c, r: r || "" };
    if (fresh || !hj || hj.id !== id) hj = { id, stack: [item] };
    else if (hj.stack[hj.stack.length - 1].c !== c) hj.stack.push(item);
    openId = null; pickOpen = null;
    loadHanjaData();
    render();
  }

  async function swap(a, b) {
    const A = words[a], B = words[b];
    let sa = A.sort ?? a, sbb = B.sort ?? b;
    if (sa === sbb) sbb = sa + (b > a ? 1 : -1);
    await patchWord(A.id, { sort: sbb });
    await patchWord(B.id, { sort: sa });
  }
})();
