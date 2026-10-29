// KRX(한국거래소) Open API 원격 MCP 서버
// claude.ai 웹 커스텀 커넥터에서 쓰기 위한 Streamable HTTP 서버입니다.
// 필요한 환경변수:
//   KRX_API_KEY : KRX Open API 인증키
//   MCP_SECRET  : 접속 주소에 들어가는 비밀 문자열 (주소: /mcp/<MCP_SECRET>)
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const KRX_API_KEY = process.env.KRX_API_KEY;
const MCP_SECRET = process.env.MCP_SECRET;
const PORT = Number(process.env.PORT || 3000);
const KRX_BASE = "https://data-dbg.krx.co.kr/svc/apis";

if (!KRX_API_KEY || !MCP_SECRET || MCP_SECRET.length < 16) {
  console.error("환경변수 KRX_API_KEY와 MCP_SECRET(16자 이상)을 설정하세요.");
  process.exit(1);
}

const MARKETS = {
  KOSPI: { trade: "sto/stk_bydd_trd", base: "sto/stk_isu_base_info" },
  KOSDAQ: { trade: "sto/ksq_bydd_trd", base: "sto/ksq_isu_base_info" },
  KONEX: { trade: "sto/knx_bydd_trd", base: "sto/knx_isu_base_info" },
};
const INDEXES = {
  KRX: "idx/krx_dd_trd",
  KOSPI: "idx/kospi_dd_trd",
  KOSDAQ: "idx/kosdaq_dd_trd",
};

const dateSchema = z.string().regex(/^\d{8}$/, "YYYYMMDD 형식");

async function krxCall(path, basDd) {
  const url = `${KRX_BASE}/${path}?basDd=${basDd}`;
  const res = await fetch(url, {
    headers: { AUTH_KEY: KRX_API_KEY, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const hint =
      res.status === 401
        ? " (인증키 또는 해당 API 이용신청 승인 상태를 KRX 마이페이지에서 확인하세요)"
        : "";
    throw new Error(`KRX API 오류 ${res.status}${hint}`);
  }
  const data = await res.json();
  return data.OutBlock_1 || [];
}

// 여러 날짜를 순서대로 조회 (KRX 호출 한도 보호를 위해 최대 31일)
async function multiDay(path, dates, filterFn) {
  if (dates.length > 31) throw new Error("한 번에 최대 31일까지 조회할 수 있어요.");
  const out = {};
  for (const d of dates) {
    const rows = await krxCall(path, d);
    out[d] = filterFn ? rows.filter(filterFn) : rows;
  }
  return out;
}

const asText = (obj) => ({
  content: [{ type: "text", text: JSON.stringify(obj) }],
});

function buildServer() {
  const server = new McpServer({ name: "krx-web-mcp", version: "1.0.0" });

  server.tool(
    "get_today_date",
    "오늘 날짜를 한국시간(KST) 기준 YYYYMMDD로 알려줍니다. KRX 자료는 전 영업일 종가까지 제공됩니다.",
    {},
    async () => {
      const kst = new Date(Date.now() + 9 * 3600 * 1000);
      return asText({ kst: kst.toISOString().slice(0, 10).replace(/-/g, "") });
    }
  );

  server.tool(
    "get_stock_trade_info",
    "코스피·코스닥·코넥스 종목의 일별 시세(종가, 등락률, 시가, 고가, 저가, 거래량, 거래대금, 시가총액, 상장주식수)를 조회합니다. codeList는 6자리 종목코드(예: 005930). 날짜는 최대 31개.",
    {
      market: z.enum(["KOSPI", "KOSDAQ", "KONEX"]),
      basDdList: z.array(dateSchema).min(1),
      codeList: z.array(z.string()).min(1),
    },
    async ({ market, basDdList, codeList }) =>
      asText(
        await multiDay(MARKETS[market].trade, basDdList, (r) =>
          codeList.includes(r.ISU_CD)
        )
      )
  );

  server.tool(
    "get_stock_base_info",
    "코스피·코스닥·코넥스 종목의 기본정보(종목명, 영문명, 상장일, 주식종류, 액면가, 상장주식수)를 조회합니다. codeList는 6자리 종목코드.",
    {
      market: z.enum(["KOSPI", "KOSDAQ", "KONEX"]),
      basDd: dateSchema,
      codeList: z.array(z.string()).min(1),
    },
    async ({ market, basDd, codeList }) =>
      asText(
        await multiDay(MARKETS[market].base, [basDd], (r) =>
          codeList.includes(r.ISU_SRT_CD)
        )
      )
  );

  server.tool(
    "search_stock",
    "종목명 일부로 종목코드를 찾습니다(예: '하이닉스'). 기준일의 종목기본정보에서 검색합니다.",
    {
      market: z.enum(["KOSPI", "KOSDAQ", "KONEX"]),
      basDd: dateSchema,
      keyword: z.string().min(1),
    },
    async ({ market, basDd, keyword }) => {
      const rows = await krxCall(MARKETS[market].base, basDd);
      const hits = rows
        .filter((r) => (r.ISU_ABBRV || "").includes(keyword) || (r.ISU_NM || "").includes(keyword))
        .slice(0, 30)
        .map((r) => ({ code: r.ISU_SRT_CD, name: r.ISU_ABBRV, kind: r.KIND_STKCERT_TP_NM }));
      return asText(hits);
    }
  );

  server.tool(
    "get_market_top",
    "기준일에 시장 전체 종목 중 상승률·하락률·거래대금·시가총액 상위 종목을 보여줍니다.",
    {
      market: z.enum(["KOSPI", "KOSDAQ", "KONEX"]),
      basDd: dateSchema,
      sortBy: z.enum(["rise", "fall", "value", "mktcap"]),
      limit: z.number().int().min(1).max(50).default(20),
    },
    async ({ market, basDd, sortBy, limit }) => {
      const rows = await krxCall(MARKETS[market].trade, basDd);
      const num = (v) => Number(String(v).replace(/,/g, "")) || 0;
      const key = { rise: "FLUC_RT", fall: "FLUC_RT", value: "ACC_TRDVAL", mktcap: "MKTCAP" }[sortBy];
      const dir = sortBy === "fall" ? 1 : -1;
      rows.sort((a, b) => dir * (num(a[key]) - num(b[key])));
      return asText(
        rows.slice(0, limit).map((r) => ({
          code: r.ISU_CD, name: r.ISU_NM, close: r.TDD_CLSPRC,
          changePct: r.FLUC_RT, tradeValue: r.ACC_TRDVAL, mktcap: r.MKTCAP,
        }))
      );
    }
  );

  server.tool(
    "get_index_daily",
    "KRX·KOSPI·KOSDAQ 지수 시리즈의 일별 시세(종가, 등락률 등)를 조회합니다. KRX에서 지수 API 이용신청·승인이 필요합니다. nameFilter로 지수명을 거를 수 있어요(예: '코스피', '코스닥 150').",
    {
      series: z.enum(["KRX", "KOSPI", "KOSDAQ"]),
      basDdList: z.array(dateSchema).min(1),
      nameFilter: z.string().optional(),
    },
    async ({ series, basDdList, nameFilter }) =>
      asText(
        await multiDay(INDEXES[series], basDdList, nameFilter ? (r) => (r.IDX_NM || "").includes(nameFilter) : null)
      )
  );

  return server;
}

const mcpPath = `/mcp/${MCP_SECRET}`;

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/" || url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("ok");
  }
  if (url.pathname !== mcpPath) {
    res.writeHead(404);
    return res.end();
  }
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" });
    return res.end();
  }

  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) {
      res.writeHead(413);
      return res.end();
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400);
    return res.end("invalid json");
  }

  // 요청마다 새 서버/전송 계층을 만드는 무상태(stateless) 방식
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
});

httpServer.listen(PORT, () => {
  console.log(`krx-web-mcp listening on :${PORT}`);
});
