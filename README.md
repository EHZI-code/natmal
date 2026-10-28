# 낱말장

찾아본 낱말을 뜻·예문과 함께 모아 두는 개인 단어장입니다.

- 뜻: 국립국어원 **표준국어대사전** 공개 API, 없으면 **우리말샘** 공개 API
- 한자 훈음·관련 낱말: libhangul 한자 데이터(`hanja.json`, 출처와 사용 조건은 `HANJA-LICENSE.txt`)
- 로그인·저장: **Supabase** (이메일 + 비밀번호)
- 호스팅: **Vercel** (화면 + `api/` 서버 함수)
- 메일 백업: **Gmail** (앱 비밀번호로 발송)
- 홈 화면 앱: 아이콘(`icon-*.png` 등), `manifest.webmanifest`, `sw.js`

## 파일

| 파일 | 하는 일 |
|---|---|
| `index.html`, `style.css`, `app.js` | 화면 |
| `api/dict.js` | 사전 API 중계. 사전 키를 브라우저에 보내지 않으려고 서버에서 대신 묻습니다 |
| `api/config.js` | 브라우저에 Supabase 주소와 공개 키를 알려 줍니다 |
| `api/backup-mail.js` | 로그인한 사람의 낱말을 JSON·CSV로 첨부해 Gmail로 그 사람에게 보냅니다 |
| `schema.sql` | 데이터베이스 표와 보안 규칙 |
| `hanja.json` | 한자 7,374자의 훈음과 한자마다 자주 쓰는 낱말 |

## 처음 한 번 하는 설정

### 1. 사전 API 키 받기 (무료)
1. https://stdict.korean.go.kr 에 가입 → 화면 맨 아래 **오픈 API** → 키 신청 → 받은 키를 적어 둡니다 (`STDICT_KEY`).
2. (선택) https://opendict.korean.go.kr 에 가입 → **오픈 API** → 키 신청 (`OPENDICT_KEY`). 표준국어대사전에 없는 방언·옛말을 찾을 때 씁니다.

### 2. Supabase
1. https://supabase.com → **New project** (이름: natmal, 지역: Northeast Asia (Seoul)).
2. 왼쪽 **SQL Editor** → `schema.sql` 내용을 붙여 넣고 **Run**.
3. 왼쪽 **Project Settings → API**에서 두 값을 적어 둡니다.
   - Project URL → `SUPABASE_URL`
   - `anon` `public` 키 → `SUPABASE_ANON_KEY`

### 3. Gmail 앱 비밀번호 (메일 백업)
1. 백업을 보낼 Gmail 계정에 **2단계 인증**이 켜져 있어야 합니다 (Google 계정 → 보안).
2. https://myaccount.google.com/apppasswords → 앱 이름에 `낱말장` → **만들기** → 나오는 16자리를 적어 둡니다 (`GMAIL_APP_PASSWORD`).
3. 그 Gmail 주소도 적어 둡니다 (`GMAIL_USER`).

백업 메일은 이 Gmail에서 낱말장에 로그인한 이메일로 갑니다.

### 4. Vercel
1. https://vercel.com → **Add New → Project** → 이 저장소를 가져옵니다.
2. **Environment Variables**에 넣습니다: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `STDICT_KEY`, `OPENDICT_KEY`(선택), `GMAIL_USER`, `GMAIL_APP_PASSWORD`.
3. **Deploy**. 끝나면 `https://○○○.vercel.app` 주소가 생깁니다.

### 5. Supabase에 앱 주소 알려 주기
Supabase → **Authentication → URL Configuration**
- Site URL: Vercel 주소 (`https://○○○.vercel.app`)
- Redirect URLs: 같은 주소를 추가

가입 확인 메일과 비밀번호 재설정 메일의 링크가 이 주소로 돌아옵니다.

### 6. 가입하고 옮기기
1. 앱 주소에서 **가입하기** → 메일의 링크를 누르면 로그인됩니다.
2. 전에 쓰던 낱말장(Claude 안의 앱)에서 **계정 → 백업 파일 내려받기 (JSON)**.
3. 새 앱에서 **계정 → 백업 불러오기**로 그 파일을 고릅니다.

### 7. 홈 화면에 앱 아이콘 만들기
- **아이폰:** 사파리로 앱 주소를 열고 → 공유 버튼 → **홈 화면에 추가**
- **안드로이드:** 크롬으로 열고 → 메뉴(⋮) → **홈 화면에 추가** 또는 **앱 설치**
- **맥:** 사파리 → 파일 → **Dock에 추가** (크롬은 주소창 오른쪽의 설치 아이콘)

아이콘을 누르면 주소창 없이 앱처럼 열립니다.

## 확인 방법

`https://○○○.vercel.app/api/dict?q=금어` 를 열면 사전 결과가 JSON으로 보여야 합니다.
`{"error":"no_api_key"}`가 나오면 Vercel 환경 변수를 넣은 뒤 다시 배포(Redeploy)하세요.
