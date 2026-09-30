// 배송흐름 조회 프록시 서버
// - 프론트(엑셀 업로드 도구)에서 오는 요청: GET /track?t_code=05&t_invoice=1234567890
//   (t_code는 SweetTracker 스타일 코드 그대로 사용 → 기존 도구 수정 없이 그대로 연결됨)
// - 내부적으로 셀프호스팅한 Delivery Tracker GraphQL 서버(DELIVERY_TRACKER_ENDPOINT)를 호출해서
//   lastEvent(마지막 배송흐름)를 가져온 뒤, 기존 SweetTracker 응답과 비슷한 형태로 변환해서 돌려줌

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import officeCrypto from "officecrypto-tool";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const EXCEL_PASSWORD = "0000"; // 회사에서 기본으로 거는 고정 암호

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());

// cors() 패키지 설정과 무관하게 항상 명시적으로 헤더를 강제 부여 (안전장치)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 8787;

// 셀프호스팅한 Delivery Tracker GraphQL 서버 주소 (예: https://your-delivery-tracker.up.railway.app/graphql)
const DELIVERY_TRACKER_ENDPOINT = process.env.DELIVERY_TRACKER_ENDPOINT;

// Delivery Tracker Cloud(관리형)를 쓰는 경우에만 필요. 셀프호스팅이면 보통 비워둬도 됨.
const DT_CLIENT_ID = process.env.DELIVERY_TRACKER_CLIENT_ID || "";
const DT_CLIENT_SECRET = process.env.DELIVERY_TRACKER_CLIENT_SECRET || "";

if (!DELIVERY_TRACKER_ENDPOINT) {
  console.warn("[경고] DELIVERY_TRACKER_ENDPOINT 환경변수가 설정되지 않았습니다.");
}

// SweetTracker 코드 → Delivery Tracker carrierId 매핑
// 참고: https://tracker.delivery/en/carriers 에서 최신 코드 확인 가능
// 롯데(kr.lotte)는 레포(packages/core/src/carriers)에서 정확한 값 재확인 권장
const CODE_TO_CARRIER_ID = {
  "04": "kr.epost",        // 우체국택배
  "05": "kr.cjlogistics",  // CJ대한통운
  "06": "kr.hanjin",       // 한진택배
  "08": "kr.logen",        // 로젠택배
  "11": "kr.lotte",        // 롯데택배 (정확한 id는 레포에서 재확인)
  "24": "kr.cvsnet",       // GS Postbox 편의점택배
};

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
  // 셀프호스팅 서버는 보통 별도 인증이 필요 없습니다. 관리형(Cloud)을 쓸 때만 사용됩니다.
  if (!DT_CLIENT_ID || !DT_CLIENT_SECRET) return null;
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

  const basic = Buffer.from(`${DT_CLIENT_ID}:${DT_CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://apis.tracker.delivery/oauth/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials" }),
  });
  const data = await res.json();
  cachedToken = data.access_token;
  cachedTokenExpiry = Date.now() + (data.expires_in ? data.expires_in * 1000 - 30000 : 60000);
  return cachedToken;
}

const TRACK_QUERY = `
  query GetTrackLastEvent($carrierId: ID!, $trackingNumber: String!) {
    track(carrierId: $carrierId, trackingNumber: $trackingNumber) {
      lastEvent {
        time
        status { code name }
        description
        location { name }
      }
      recipient {
        name
        phone
      }
    }
  }
`;

app.get("/track", async (req, res) => {
  const { t_code, t_invoice } = req.query;

  if (!t_code || !t_invoice) {
    return res.status(400).json({ error: "t_code, t_invoice 파라미터가 필요합니다." });
  }
  if (!DELIVERY_TRACKER_ENDPOINT) {
    return res.status(500).json({ error: "서버에 DELIVERY_TRACKER_ENDPOINT가 설정되지 않았습니다." });
  }

  const carrierId = CODE_TO_CARRIER_ID[t_code];
  if (!carrierId) {
    return res.status(400).json({ error: `알 수 없는 택배사 코드: ${t_code}` });
  }

  try {
    const headers = { "Content-Type": "application/json" };
    const token = await getAccessToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const gqlRes = await fetch(DELIVERY_TRACKER_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: TRACK_QUERY,
        variables: { carrierId, trackingNumber: String(t_invoice) },
      }),
    });

    const gqlJson = await gqlRes.json();

    if (gqlJson.errors) {
      return res.status(502).json({ error: "GraphQL 오류", detail: gqlJson.errors });
    }

    const track = gqlJson.data?.track;
    const lastEvent = track?.lastEvent;
    const recipient = track?.recipient;

    if (!lastEvent) {
      return res.json({ complete: false, trackingDetails: [], recipientName: recipient?.name || "", recipientPhone: recipient?.phone || "" });
    }

    const statusCode = lastEvent.status?.code || "";
    const isComplete = /delivered|done|complete/i.test(statusCode);

    // 기존 엑셀 업로드 도구가 기대하는 SweetTracker 스타일 응답으로 변환 + 수취인 정보 추가
    res.json({
      complete: isComplete,
      trackingDetails: [
        {
          kind: lastEvent.status?.name || lastEvent.description || statusCode,
          where: lastEvent.location?.name || "",
          time: lastEvent.time || "",
        },
      ],
      recipientName: recipient?.name || "",
      recipientPhone: recipient?.phone || "",
    });
  } catch (err) {
    res.status(500).json({ error: "조회 중 오류", detail: err.message });
  }
});

// 암호(0000)로 잠긴 엑셀을 서버에서 미리 풀어서 돌려줌 (암호 없는 파일은 그대로 통과)
app.post("/decrypt-xlsx", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "파일이 없습니다" });
    const buf = req.file.buffer;

    let isEncrypted = false;
    try {
      isEncrypted = officeCrypto.isEncrypted(buf);
    } catch {
      isEncrypted = false;
    }

    if (!isEncrypted) {
      res.set("Content-Type", "application/octet-stream");
      return res.send(buf);
    }

    const decrypted = await officeCrypto.decrypt(buf, { password: EXCEL_PASSWORD });
    res.set("Content-Type", "application/octet-stream");
    res.send(decrypted);
  } catch (err) {
    res.status(500).json({ error: "엑셀 복호화 실패", detail: err.message });
  }
});

// 조회 화면(엑셀 업로드 도구 / 빠른 조회 페이지)을 이 서버가 직접 서빙
// → 화면과 API가 같은 출처(origin)가 되어 브라우저 fetch 제한 문제가 생기지 않음
app.use(express.static(__dirname));

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`배송조회 프록시 서버 실행 중: http://localhost:${PORT}`);
});
