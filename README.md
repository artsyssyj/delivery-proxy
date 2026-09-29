# 배송흐름 조회 프록시 — 배포 가이드 (Railway 기준)

이 프록시는 셀프호스팅한 Delivery Tracker(GraphQL) 서버를 호출해서,
기존에 만든 엑셀 업로드 도구가 기대하는 SweetTracker 스타일 응답으로 바꿔주는 역할만 합니다.
**서버가 두 개** 필요합니다: (A) Delivery Tracker 본체, (B) 이 프록시.

---

## 1단계 — Delivery Tracker 본체 셀프호스팅

1. https://github.com/shlee322/delivery-tracker 를 본인 GitHub 계정으로 Fork
2. https://railway.app 가입 → New Project → **Deploy from GitHub repo** → 방금 Fork한 저장소 선택
3. 레포 안 `packages/http` 에 있는 Dockerfile을 기준으로 빌드되도록 Root Directory를 `packages/http`로 지정
   (Railway 설정 화면의 "Root Directory" 항목)
4. 배포가 끝나면 Railway가 자동으로 부여하는 URL을 확인 (예: `https://delivery-tracker-production-xxxx.up.railway.app`)
5. 이 서버의 GraphQL 엔드포인트는 보통 `<그 URL>/graphql` 형태입니다. 배포 후 `curl <URL>/graphql` 등으로 응답이 오는지 확인하세요.

> 일부 택배사는 헤드리스 브라우저로 페이지를 읽어오는 방식이라 메모리를 더 씁니다.
> 처음 배포 후 CJ대한통운, 한진 등 몇 건 조회해보고 메모리 부족 오류가 뜨면 Railway 플랜을 한 단계 올리세요.

## 2단계 — 이 프록시 배포

1. 이 폴더(`server.js`, `package.json`)를 별도 GitHub 저장소로 올리기 (또는 같은 저장소의 다른 폴더로 관리)
2. Railway에서 New Project → Deploy from GitHub repo → 이 프록시 저장소 선택
3. Variables(환경변수) 탭에서 추가:
   - `DELIVERY_TRACKER_ENDPOINT` = 1단계에서 확인한 GraphQL 주소 (예: `https://delivery-tracker-production-xxxx.up.railway.app/graphql`)
4. 배포 후 부여된 URL이 곧 엑셀 업로드 도구의 "프록시 서버 URL" 입력칸에 넣을 값입니다.
   예: `https://your-proxy-production.up.railway.app/track`

## 3단계 — 동작 확인

```
curl "https://your-proxy-production.up.railway.app/track?t_code=05&t_invoice=테스트운송장번호"
```

`trackingDetails` 배열에 마지막 배송흐름이 담겨서 오면 정상입니다.
엑셀 업로드 도구의 "조회 서버 설정"에 위 프록시 URL을 넣고 그대로 쓰시면 됩니다.

## 참고

- GraphQL 스키마의 정확한 필드명은 배포된 서버의 GraphQL Playground/introspection으로 확인 가능합니다.
  `lastEvent`, `status`, `location`, `description` 필드명이 실제 응답과 다르면 `server.js`의
  `TRACK_QUERY` 부분만 맞춰 수정하면 됩니다.
- 롯데택배의 정확한 carrierId(`kr.lotte`로 가정)는 레포의 `packages/core` 하위 캐리어 목록에서 한 번 더 확인해 주세요.
- 라이선스: 상업적으로 사용하기 전 레포의 LICENSE 파일을 꼭 확인하세요.
