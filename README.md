# multilingual-docs

화면 기반 다국어 텍스트 QA 맵 MVP입니다.

## 로컬 실행

```bash
npm install
npm run dev
```

브라우저에서 `http://localhost:3000`을 엽니다.

## Supabase / Vercel 환경변수

로컬은 `.env.local`, Vercel은 Project Settings의 Environment Variables에 아래 값을 설정합니다.

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_SUPABASE_STORAGE_BUCKET=screen-images
```

- Production, Preview, Development에 같은 Supabase 프로젝트 값을 설정하면 모든 환경이 `app_snapshots/default`를 원본으로 사용합니다.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`는 브라우저에 공개되는 anon key이며 `service_role` key를 넣으면 안 됩니다.
- `.env.local`은 Git에 커밋되지 않습니다. 필요한 변수 이름은 `.env.example`에서 확인합니다.
- 최초 1회 Supabase SQL Editor에서 `supabase-setup.sql`을 실행해야 테이블, RLS 정책, Storage bucket이 준비됩니다.

## 데이터 저장 정책

- 원본 데이터: Supabase `public.app_snapshots` 테이블의 `id = default`
- 화면 이미지: Supabase Storage `screen-images` bucket
- 로컬 캐시: IndexedDB
- 로드 순서: Supabase 성공 시 해당 데이터를 사용하고 IndexedDB 캐시를 갱신합니다. Supabase 로드 실패 또는 데이터가 없을 때만 IndexedDB를 fallback으로 읽습니다.
- 저장 순서: Supabase 저장이 성공한 뒤에만 동일 스냅샷을 IndexedDB 캐시에 기록합니다.
- Supabase 저장 실패 시 IndexedDB에 새 상태를 기록하지 않으며 앱 화면에 오류와 재시도 버튼을 표시합니다.

## MVP 사용 흐름

1. 기본 진입 화면은 View Mode입니다. 등록된 화면이 있으면 화면 이미지와 다국어 번역 테이블이 먼저 표시됩니다.
2. 등록된 화면이 없으면 `화면 추가`를 눌러 Add Mode로 진입합니다.
3. Add/Edit Mode에서 `로컬 HTML 불러오기`로 `20260108_번역.html`을 파싱하거나 HTML 파일을 직접 업로드합니다.
4. Add/Edit Mode에서 피그마 export 화면 이미지를 업로드하고 화면 정보를 저장합니다.
5. `영역 생성`을 누르고 화면 이미지 위에서 드래그해 텍스트 박스를 만듭니다.
6. 선택된 영역에 화면 표시 문구, 상태, 메모를 입력합니다.
7. 오른쪽 검색에서 key, KR, EN 등으로 번역 항목을 찾아 연결합니다.
8. View Mode로 돌아가 화면 이미지와 연결된 문구별 11개 언어 번역 테이블을 확인합니다.

데이터는 Supabase에 저장되며 새로고침과 브라우저 재시작 후에도 유지됩니다. IndexedDB는 fallback/cache 용도로만 사용합니다.
