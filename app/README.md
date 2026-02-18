# PlanRiseAI (MVP)

## 실행

```bash
cd app
npm install
npm run dev
```

- 기본 주소: `http://localhost:3000`
- 테스트 계정: `a@b.c / 3087`

## 키 설정

우선순위:
1. 루트 `keys.json`
2. `app/keys.json`

### OpenAI
- `openai.apiKey`를 넣으면 `/api/plan/generate`가 OpenAI 응답을 우선 사용
- 없으면 내부 스케줄러로 fallback

### Auth
- 현재 인증 모드는 로컬 인증 고정입니다.
- 모든 API 인증은 Body의 `user`, `password`를 사용합니다.

### Web Push (VAPID)
- `webPush.subject`, `webPush.publicKey`, `webPush.privateKey`를 채우면 실발송 활성화
- 키 생성:

```bash
npx web-push generate-vapid-keys
```

- 브라우저에서 `설정 > Push 구독 저장` 실행 후 `서버 푸시 테스트`로 발송 가능

### 로그 저장/조회
- API 요청/응답 로그를 `app/logs/YYYY-MM-DD.jsonl`로 저장합니다.
- 민감 정보(`password`, `token`, `apiKey`, `privateKey`)는 자동 마스킹됩니다.
- 로그 범위 기본/최대값은 `keys.json`의 `app` 섹션으로 조정할 수 있습니다.
  - `logRetentionDays`
  - `logQueryDefaultDays`
  - `logQueryMaxDays`
  - `logQueryDefaultLimit`
  - `logQueryMaxLimit`

## 주요 기능

- 이메일/비밀번호 로컬 인증
- 플랜 생성 (문제집 끝내기 / 내신 대비)
- 오프데이 제외 + 버퍼(기본 20%) 적용
- 미완료 일정 재분배 (`오늘 할 일 다음으로 미루기`)
- 캘린더 기반 저장 (`app/data/<username>/*.json`)
- 요금제별 월간 제한
  - free: AI 2회, 재분배 2회
  - pro_monthly: AI 6회, 재분배 10회
  - pro_yearly: 무제한
- PWA 설치 버튼 + 서비스워커 + 브라우저 알림/Push 구독 저장

## 주요 API

- `POST /api/auth/local-signup`
- `POST /api/auth/local-login`
- `POST /api/home`
- `POST /api/calendar`
- `POST /api/plan/generate`
- `POST /api/plan/commit`
- `POST /api/plan/rebalance`
- `POST /api/task/status`
- `POST /api/task/update`
- `POST /api/task/delete`
- `POST /api/settings/get`
- `POST /api/settings/update`
- `POST /api/calendar/clear`
- `POST /api/account/get`
- `POST /api/account/plan`
- `POST /api/push/subscribe`
- `POST /api/push/test`
- `POST /api/logs`

`POST /api/logs` 예시:

```json
{
  "user": "a@b.c",
  "password": "3087",
  "days": 90,
  "limit": 2000
}
```

- `scope: \"all\"`은 현재 테스트 관리자 계정(`a@b.c`)에서만 전체 로그 조회 가능합니다.

요청 시 인증:
- Body에 `user`, `password`

플랜 생성 플로우:
1. `POST /api/plan/generate`로 미리보기 생성
2. 사용자 확인 후 `POST /api/plan/commit`으로 실제 저장
