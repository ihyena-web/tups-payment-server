# TUPS Thailand — Payment Server (예시)

Omise 결제 승인을 처리하는 최소 구성 백엔드입니다. `checkout.html`에서 결제 토큰을 이 서버로 보내면, 이 서버가 (오직 여기에만 있는) Secret Key로 실제 결제를 승인합니다.

## 로컬에서 테스트하기

```bash
cd server-example
npm install
cp .env.example .env
# .env 파일을 열어서 pkey_test_...  /  skey_test_... 를 실제 값으로 교체
npm start
```

`http://localhost:3000` 에서 서버가 뜹니다.

## 배포하기 (택 1 — 무료/저가 옵션)

- **Render.com**: GitHub 저장소 연결 → "Web Service"로 배포 → Environment 탭에 `OMISE_PUBLIC_KEY`, `OMISE_SECRET_KEY` 입력
- **Railway.app**: 위와 동일한 방식, 무료 크레딧 제공
- **Vercel / Netlify Functions**: `index.js`를 서버리스 함수 형태로 일부 수정 필요 (원하시면 그 버전도 만들어드릴 수 있습니다)

## 배포 후 할 일

1. 배포된 서버 주소(예: `https://tups-payment.onrender.com`) 확인
2. `checkout.html`의 `BACKEND_URL` 값을 `https://tups-payment.onrender.com/charge`로 변경
3. `checkout.html`의 `data-key`와 `OMISE_PUBLIC_KEY_PLACEHOLDER`를 실제 Public Key로 변경
4. 테스트 카드(`docs.omise.co/testing`)로 결제 테스트
5. 문제없으면 Live 키로 교체 → 실결제 시작

## 보안 체크리스트

- [ ] `.env` 파일이 `.gitignore`에 포함되어 있는지 확인
- [ ] Secret Key(`skey_...`)가 브라우저 코드 어디에도 없는지 확인
- [ ] `cors()` 설정을 실제 도메인으로 제한 (현재는 전체 허용 상태)
- [ ] 프로덕션 전환 전 Omise 대시보드에서 Live 계정 승인 완료
