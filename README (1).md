# krx-web-mcp

KRX(한국거래소) Open API를 claude.ai 웹 커스텀 커넥터에서 쓰기 위한 원격 MCP 서버입니다.

## 환경변수
- `KRX_API_KEY` : KRX Open API 인증키
- `MCP_SECRET` : 접속 주소용 비밀 문자열(16자 이상)

## 접속 주소
`https://<배포주소>/mcp/<MCP_SECRET>`

## 도구
- get_today_date, get_stock_trade_info, get_stock_base_info, search_stock, get_market_top, get_index_daily
