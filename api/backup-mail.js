// 백업 파일을 로그인한 사람의 메일로 보낸다 (Gmail로 발송).
// POST /api/backup-mail  (Authorization: Bearer <Supabase 로그인 토큰>)
//
// 필요한 Vercel 환경 변수
//   SUPABASE_URL, SUPABASE_ANON_KEY  — 로그인한 사람 확인·낱말 읽기 (그 사람 권한으로만 읽는다)
//   GMAIL_USER                       — 보내는 Gmail 주소 (예: hanmid2026003@gmail.com)
//   GMAIL_APP_PASSWORD               — Google 계정의 "앱 비밀번호" 16자리 (일반 비밀번호 아님)
import nodemailer from "nodemailer";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method" });

  const url = process.env.SUPABASE_URL, anon = process.env.SUPABASE_ANON_KEY;
  const gUser = process.env.GMAIL_USER, gPass = String(process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  if (!url || !anon || !gUser || !gPass) return res.status(500).json({ error: "not_configured" });

  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "no_token" });

  // 1. 토큰으로 사람 확인
  const ur = await fetch(`${url}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${token}` } });
  if (!ur.ok) return res.status(401).json({ error: "bad_token" });
  const user = await ur.json();
  if (!user || !user.email) return res.status(401).json({ error: "no_email" });

  // 2. 그 사람 권한으로 낱말 읽기 (행 보안 규칙이 본인 것만 돌려준다)
  const wr = await fetch(`${url}/rest/v1/words?select=id,body,sort,created_at&order=sort.asc`, {
    headers: { apikey: anon, Authorization: `Bearer ${token}` },
  });
  if (!wr.ok) return res.status(502).json({ error: "read_failed" });
  const rows = await wr.json();
  const words = rows.map((r) => Object.assign({}, r.body, { id: r.id, sort: r.sort, createdAt: r.body.createdAt || Date.parse(r.created_at) }));

  // 3. 첨부 파일 만들기 (날짜는 한국 시각)
  const z = (n) => String(n).padStart(2, "0");
  const kst = (t) => new Date((t || Date.now()) + 9 * 3600 * 1000);
  const fmt = (t) => { const d = kst(t); return `${d.getUTCFullYear()}/${z(d.getUTCMonth() + 1)}/${z(d.getUTCDate())}`; };
  const dayText = fmt(Date.now()), day = dayText.replace(/\//g, "");
  const json = JSON.stringify({ app: "natmal", version: 2, exportedAt: new Date().toISOString(), words }, null, 2);
  const q = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  const csv = "﻿" + [["낱말", "한자", "품사", "뜻", "예문", "기록한 날"]]
    .concat(words.map((w) => [w.headword, w.hanja, w.pos, (w.senses || []).map((x, i) => `${i + 1}. ${x}`).join(" "), w.example, fmt(w.createdAt)]))
    .map((r) => r.map(q).join(",")).join("\r\n");

  // 4. 보내기
  const withEx = words.filter((w) => w.example).length;
  const html = `<div style="font-family:'Nanum Myeongjo',serif;color:#1C1B19;line-height:1.7">
    <p style="font-size:20px;font-weight:800;margin:0 0 12px">( &nbsp; )</p>
    <p style="margin:0">${dayText} 낱말장 백업입니다.</p>
    <p style="margin:0;color:#6E6A63">모은 낱말 ${words.length}개 · 예문이 있는 낱말 ${withEx}개</p>
    <p style="margin:16px 0 0;color:#6E6A63;font-family:sans-serif;font-size:13px">되살릴 때는 낱말장 → 계정 → 백업 불러오기에서 첨부된 JSON 파일을 고르세요. CSV 파일은 엑셀에서 열 수 있습니다.</p>
  </div>`;
  try {
    const mailer = nodemailer.createTransport({ service: "gmail", auth: { user: gUser, pass: gPass } });
    await mailer.sendMail({
      from: `"낱말장" <${gUser}>`,
      to: user.email,
      subject: `낱말장 백업 ${dayText} · 낱말 ${words.length}개`,
      html,
      attachments: [
        { filename: `natmal-backup-${day}.json`, content: json, contentType: "application/json" },
        { filename: `natmal-${day}.csv`, content: csv, contentType: "text/csv; charset=utf-8" },
      ],
    });
  } catch (e) {
    return res.status(502).json({ error: "mail_failed", detail: String((e && e.message) || e).slice(0, 300) });
  }
  return res.status(200).json({ ok: true, to: user.email, count: words.length });
}
