# AI Station — 私人 AI 對話工作空間

Node.js 24+、Express、SQLite、Vite。前端依照 `design.md` 的奶油白 #faf9f5、珊瑚色 #cc785c、深色 #181715 與 serif 標題建立。單一管理員，不提供註冊。

## 本機啟動（Windows）

```powershell
Copy-Item .env.example .env
# 編輯 .env：ADMIN_USERNAME、ADMIN_PASSWORD (>=12 字元)、SESSION_SECRET、DATA_ENCRYPTION_KEY (各 >=32 字元)
npm install
npm run build
npm start
```

使用瀏覽器開啟 `http://127.0.0.1:3000`。要開放外部連線請配置 `HOST=0.0.0.0`、`PORT=3000` 和防火牆。

## 本機開發

配置好 `.env` 並安裝套件後，在兩個終端機分別執行 `npm start`（API 後端）與 `npm run dev`（Vite 前端），瀏覽器開啟 Vite 顯示的網址。Vite 的 `/api` 代理預設連至 `http://127.0.0.1:<PORT>`，沿用 `.env` 中的 PORT；後端位於其他網址時可設定 `DEV_API_TARGET`。代理保留瀏覽器的 Host，讓登入 Cookie 與 Origin 檢查可正常運作。此設定只供開發使用。

## VPS 一鍵安裝 / 更新（Linux/systemd）

```bash
cd /path/to/aistation
sudo bash scripts/install.sh
sudo nano .env  # 必須設定強密碼，安裝腳本會隨機生成兩個秘密值
sudo systemctl start aistation
sudo systemctl status aistation
```

後續更新：`bash scripts/update.sh`。建議以一般使用者安裝程式與資料目錄，並由 sudo 建立 systemd 單元。更新前會備份 SQLite。腳本不負責安裝 Node.js；請先安裝 24+，並確保服務使用者對目錄有寫入權限。

## 聊天操作與瀏覽器效能

- 每個對話的未送出草稿會在瀏覽器本機保存，切換模型、對話、管理頁或重新整理後可恢復；刪除對話也會清除該對話草稿。草稿仍未進入伺服器佇列，不會自動送出，也不跨裝置同步。瀏覽器停用本機儲存時，只能在目前頁面的記憶體保留。
- 訊息送出等待確認時，可繼續輸入下一則草稿；較晚回來的確認只會清除沒有再修改過的原草稿。送出中的同一對話暫時禁止重複提交，其他對話仍可操作。
- 快速切換對話會取消前一次載入，且忽略過期回應。載入期間顯示狀態，失敗可重試。
- 串流文字每 50ms 合併更新正在生成的訊息；歷史訊息保留既有 DOM 與渲染結果。閱讀上方內容時不會被強制捲到底部，可按「回到最新訊息」恢復追蹤；切換頁面也保留閱讀位置。
- 手機版持續顯示「＋」新增對話按鈕，使用動態視窗高度、適配安全區域及觸控輸入字級。軟鍵盤、瀏覽器工具列和安全區域仍需在實際手機確認。
- 正式建置的帶內容雜湊 JS、CSS 與字型檔可長期快取；HTML、登入及私人 API 仍使用 `no-store`。

- Markdown 解析在第一則非空訊息出現時才載入；KaTeX 僅在數學公式出現時載入，程式碼高亮僅在程式碼區塊出現時載入。載入期間先顯示可閱讀的文字，格式載入完成會保留捲動位置及正在編輯的歷史訊息。下載失敗時保留文字並提供重新整理入口，輸入框草稿仍會保存。
- 程式碼高亮使用 Highlight.js 的常用語言集，另加入 PowerShell 和 Dockerfile。未標示語言、不支援的語言或超過 50000 字元的區塊保留純文字與複製功能，避免串流期間反覆自動偵測語言。公式解析遵循 Markdown 的程式碼區塊／行內程式碼規則，不會把其中的 `$...$` 當成公式。
- 分頁隱藏時暫停生成狀態的定時查詢，回到前景立即同步；伺服器背景生成仍繼續。管理中心延遲回傳的統計不會覆蓋已切換的聊天畫面。
- 移除會被目前 CSP 阻擋的外部 Google Fonts 載入；介面使用既有的系統字型備援，數學字型仍由本機建置資產提供。


開發驗證：`npm run check`、`npm test`、`npm run build`。另外提供 `npm run test:ui` 瀏覽器回歸測試，覆蓋草稿、延遲送出確認、切換競爭、串流 DOM／捲動保留、手機新增入口、HTTP 快取、延遲格式載入與失敗恢復、隱藏分頁輪詢、管理中心切頁及開發 API 代理。需先建置並另備 Playwright（例如 `npm install --no-save --package-lock=false playwright` 和 `npx playwright install chromium`）；也可用 `PLAYWRIGHT_MODULE` 指定既有 Playwright 的 `index.mjs` 路徑，或以 `PLAYWRIGHT_CHANNEL=chrome` 使用已安裝的 Chrome。

## 端點與模型設定

OpenAI 相容 Endpoint 需填完整的 `https://host/v1/chat/completions`，Claude 相容則 `https://host/v1/messages`。模型偵測會呼叫同一路徑衍生的 `/models`；部分中轉站不支援此路徑，請手動新增 Model ID。新增 Endpoint 時會自動嘗試偵測並加入模型；後續只有按「偵測」才會重新查詢，聊天從 SQLite 讀模型清單。若第三方中轉站不支援模型列表 API，請手動新增。模型唯一性使用 provider record + Model ID，而提供者 Endpoint 在資料庫中唯一，因此相當於 Endpoint + Model ID。

聊天排程現由 **SQLite 後端持久化 FIFO** 管理，每個對話的待發送訊息在關閉瀏覽器或 VPS 重啟後仍保存；不同對話可並行，單一對話一次只執行一個上游請求。失敗則暫停該對話佇列，可手動恢復；尚未執行的訊息可取消。每次送出要求提供 UUID `idempotency_key`，相同 Key 與內容只建立一次任務，不同內容重複使用同一 Key 會回 HTTP 409。

使用量僅記錄上游明確提供的數值，未知為 NULL；統計 SQL SUM 忽略 NULL，若混合已知與未知數值，總和為**已知部分之和，並非真實完整總量**。成功與失敗請求各自留存狀態。OpenAI / Claude 的第三方中轉站可能有不相容事件或 token 欄位，需要個別驗證。

「匯出對話」包含對話、訊息、統計與錯誤紀錄；「匯出設定」包含端點、模型與偏好，但**不包含 Key**。完整資料備份請保存 `data/` SQLite 檔與 `.env`（加密 Key 必須完整保留），妥善保護備份。

## Gemini 原生 API

管理中心新增 Endpoint 時，協定選擇 **Gemini 原生**，Endpoint 填 `https://generativelanguage.googleapis.com/v1beta`，API Key 填入獨立的密碼欄位。支援以 `/v1` 或 `/v1beta` 結尾的相容中轉基底 URL；貼入 `/models` 或完整 `:generateContent` / `:streamGenerateContent` URL 時會轉為基底 URL。URL 不可包含 `?key=...` 或其他查詢參數，金鑰只透過 `x-goog-api-key` Header 傳送。

- 模型偵測呼叫 `/models` 並讀取所有分頁，排除僅支援嵌入等非內容生成的模型；保存 Model ID 時移除 `models/` 前綴，也可手動新增模型。
- 聊天依選定模型呼叫 `/models/{model}:streamGenerateContent?alt=sse`，將使用者／助理歷史轉為 `user` / `model` 的 `contents`，System Prompt 使用 `systemInstruction`。支援現有背景生成、持久佇列、停止與 SSE 斷線重播。
- 僅 `parts[].thought=true` 的文字顯示為思考摘要；`thoughtSignature` 不顯示，也不保存重播。此版本限純文字對話，未加入工具呼叫、圖片或音訊。
- 成功結束以候選回覆的 `finishReason=STOP` 或 `MAX_TOKENS` 為準；後者保留截斷回答及結束原因。提前斷線、提示詞阻擋、其他異常結束和 API 錯誤會保存錯誤並暫停該對話佇列。
- 使用量保存 `usageMetadata` 明確提供的輸入、回答、快取讀取、思考與總 Token。Gemini 回答 Token 不包含獨立的思考 Token，總量直接使用供應商的 `totalTokenCount`，缺少的欄位仍為未知。
- Gemini 也可選為自動命名模型，使用非串流 `:generateContent`，獨立保存命名用量。
- 啟動時自動更新舊 SQLite 的供應商協定限制；保留既有端點、加密 Key、模型、對話、請求與佇列的關聯。

官方格式參考：[內容生成 REST API](https://ai.google.dev/api/generate-content)、[模型列表](https://ai.google.dev/api/models)、[思考設定](https://ai.google.dev/gemini-api/docs/generate-content/thinking)。實際 Google API 的模型可用性、額度與中轉相容性仍需使用自己的憑證驗證。

## 每次訊息選擇思考額度

聊天輸入框底部有「思考額度」選單；每次點擊傳送時會**連同訊息**保存選擇，對話佇列中的後續選擇不會覆蓋已排隊訊息的額度。切換聊天視窗時，每個聊天保留各自的前端選擇（重新整理頁面會恢復為 API 預設）。

- **API 預設**：不傳送任何額外的思考參數，最適合不支援推理設定的第三方中轉站。
- **OpenAI 相容 /chat/completions**：依選擇傳送 `reasoning_effort`（`none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）。不是每個模型都支援所有值；不支援時會顯示供應商原始錯誤。
- **Claude 4.6 及更新的模型**：傳送 `thinking: {type: "adaptive"}`、`output_config: {effort: "low" | "medium" | "high" | "xhigh" | "max"}`；模型的允許值依供應商而定。
- **已辨識的 Claude 4.5 及以前模型**：思考等級對應至手動 `thinking: {type: "enabled", budget_tokens: N}`（低 1024、中 4096、高 8192、極高 16384、最大 32768），預留至少 2048 token 作為回覆空間。第三方非標準 Model ID 可以選擇「自訂 Token 預算」，發送相同的手動 thinking 格式。
- **Claude 自訂 Token 預算**：允許 1024～32768 的整數。Claude 4.6 目前已棄用手動 thinking，4.7 以上不支援；在這些模型選自訂額度可能會收到 HTTP 400。
- **Gemini 3 及更新模型**：傳送 `generationConfig.thinkingConfig.thinkingLevel`（`minimal`、`low`、`medium`、`high`）與 `includeThoughts: true`。各模型允許值不同，不支援的選擇會顯示供應商錯誤；不將 `minimal` 當成保證關閉思考。
- **Gemini 2.5**：等級對應至 `thinkingBudget`（最低 512、低 1024、中 4096、高 8192），或使用自訂整數預算。Flash／Flash-Lite 上限 24576，Pro 上限 32768 且最低 128、不可關閉思考；Flash-Lite 非零預算至少 512。Flash／Flash-Lite 可選「關閉」傳送 0。API 預設不附加思考設定。
- SQLite `requests` 表以非破壞性的 schema migration 增加 `thinking_mode`、`thinking_effort`、`thinking_budget_tokens`，每次訊息都記錄所要求的設定；這不是模型實際消耗的推理 token 數。實際使用量仍只採用上游傳回的數值。

官方參考：[OpenAI Chat Completions reasoning_effort](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Claude extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)、[Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort)。

## SSE 即時思考顯示與斷線保護

現在使用 **POST 建立佇列工作 + GET EventSource** 續接串流。`POST /api/conversations/:id/send` 回 HTTP 202 JSON，不再持續佔用 POST 連線。登入後，GET `/api/conversations/:id/events?after=<seq>` 會重播 SQLite 事件日誌中游標之後的事件，並持續接收新增事件；斷線重連支援標準 `Last-Event-ID`。伺服器將上游 OpenAI / Claude 事件轉成以下 SSE 事件：

| SSE 事件 | 內容 |
|---|---|
| `queued` | 已進入持久佇列，尚未向供應商發送 |
| `started` | 開始執行，提供請求 ID、對話訊息 ID |
| `thinking_delta` | 僅供應商明確回傳的可閱讀思考／摘要增量 |
| `delta` | 正式回答文字增量 |
| `complete` | 上游正式完成並保留 Token 使用量 |
| `stopped` | 使用者停止生成，保存部分思考與回答 |
| `error` | HTTP／供應商錯誤碼與已產生的部分內容；後續工作暫停 |
| `cancelled` / `resumed` | 待發送工作取消／對話佇列恢復 |
| `title` | 命名模型完成並更新對話標題 |

- Claude 相容 API 讀取 `thinking_delta` 和 `text_delta`；有選擇思考額度時設定 `thinking.display: "summarized"`，讓支援此參數的模型回傳可閱讀的思考摘要。簽章 `signature_delta` 為驗證資料，不會顯示給使用者，也不當成推理文字。
- OpenAI 官方 Chat Completions 通常**不提供可閱讀的內部推理文字**；只有第三方相容端點真正回傳 `choices[].delta.reasoning_content`、`reasoning` 或 `thinking` 時，才會顯示思考內容。不會由 Token 數推導或捏造思考過程。
- OpenAI 正式完成以 `data: [DONE]` 為準（`finish_reason` 不足以判斷完整）；Claude 以 `message_stop` 為準。若上游提前斷線，請求狀態為錯誤，保留已收到內容。
- 共用 SSE 增量解析器支援跨 chunk UTF-8 字元、CR／LF／CRLF、多行 `data:`、ping、註解心跳與不完整封包保護。
- `UPSTREAM_IDLE_TIMEOUT_MS`（預設 90 秒）只有在**沒有收到任何上游網路資料**時才計時；思考、文字、ping、心跳都會重設閒置計時。另有 `UPSTREAM_MAX_TIMEOUT_MS`（預設 10 分鐘）限制單次請求最長時間。
- SQLite 自動為舊的 `messages` 表新增 `thinking_content` 欄位，不會刪除原有對話。思考內容與回答分開顯示及保存；不把思考摘要拼入後續對話的 assistant 正文。**目前沒有保存供應商思考區塊簽章來原樣重播 Claude thinking blocks**，因此多輪上下文仍保留原有文字對話紀錄，但不包含已產生的 signed thinking block。

## 瀏覽器離線背景生成與歷史上下文操作

- **已送出的 API 請求不中斷**：SSE 瀏覽器連線關閉、切換對話、關閉頁面時，VPS 的 Node.js 程序會繼續讀取上游串流；上游任務不以瀏覽器連線壽命為基準。每 750ms 最多更新一次 SQLite 暫存內容，完成、錯誤或停止時正式記錄完整回答、思考內容、Token 用量與狀態。
- **重新進入後顯示**：登入時恢復上次開啟的對話（瀏覽器本地只記錄對話 ID）。`GET /api/generations` 回傳仍在執行的對話，前端約每 2.5 秒查詢狀態。重新進入時，執行中的訊息只顯示「背景生成中」；完整結束後從 SQLite 載入答案。原本保持 SSE 連線的頁面仍可即時觀看增量。
- **重新進入可停止**：重新登入後可按原本的「停止」，取消該對話在伺服器上的執行中任務，並保留部分回覆及思考。
- **編輯歷史訊息**：任一使用者／助理訊息旁有「編輯」，儲存後內容即成為下一次完整上下文的一部分。助理回答若經人工編輯，原先的思考摘要會清空，避免不一致。
- **刪除歷史訊息**：刪除指定訊息後，下一次 API 請求不再附帶該段上下文；舊請求 Token 統計與供應商請求紀錄仍保留。
- **回退至此**：僅使用者訊息有「回退至此」，確認後**永久刪除該則使用者訊息及其之後所有訊息**，原訊息放回輸入框，修改後可重新發送。回退同時清除該聊天視窗尚未發送的前端佇列；原始 API 用量歷史不會刪除。建議回退前匯出 JSON 備份。
- **並行隔離**：生成中的聊天禁止編輯、刪除或回退歷史訊息（HTTP 409），不同聊天可同時生成；只刪除指定聊天歷史不影響其他聊天。
- **持久化佇列與重啟策略**：已由 SQLite 保存尚未執行的排隊訊息，關閉瀏覽器仍依 FIFO 自動送出。重啟時，排隊狀態的工作會在未暫停時自動恢復；正在執行中的請求因上游結果無法確認，標記為 `SERVER_RESTARTED` 並暫停同一對話佇列，**不自動重新發送**，避免重複計費。需登入後手動按「繼續傳送」處理後續訊息。尚未到達後端的本地編輯草稿不是排隊任務。

相關 API：`POST /api/conversations/:id/send`（`{ "idempotency_key": "UUID", "content": "...", "thinking": { "mode": "default" } }`）、`GET /api/conversations/:id/events?after=序號`、`GET /api/conversations/:id/jobs/:jobId`、`DELETE /api/conversations/:id/queue/:jobId`、`POST /api/conversations/:id/queue/resume`、`GET /api/generations`、`PATCH /api/conversations/:id/messages/:messageId`、`DELETE /api/conversations/:id/messages/:messageId`、`POST /api/conversations/:id/rewind`（`{ "message_id": "..." }`）。

## 管理後臺指定自動命名模型

在管理中心的「新對話自動命名」選擇已啟用的模型，按「儲存命名設定」即可生效；選擇「停用自動命名」則不會發送額外命名請求。

- 僅在**新對話第一輪助理回答成功完成**後嘗試一次，使用當前對話的第一輪使用者訊息與助理完整回覆（有長度保護），向指定模型另送一次**非串流** OpenAI Chat Completions、Claude Messages 或 Gemini GenerateContent 請求。
- 命名模型可與聊天模型不同，並使用各自 Endpoint/API Key。要求模型只產生一行簡短繁體中文標題；移除外層引號、截斷過長內容，成功後自動改標題並透過 SSE `title` 事件同步。
- 若已人工重新命名，就不會再被自動命名覆蓋。命名失敗或所選模型不支援該非串流格式，也不影響聊天正常完成；已啟動的命名請求不會反覆重試。
- 命名請求與使用量獨立寫入 `requests`，`kind='naming'`，僅統計供應商確實回傳的 Token，不會推估。
- 現有對話不會批次改名；重新編輯或回退已命名對話不會再次觸發命名。

SSE 事件逐條保存在 SQLite，可斷線補收；高頻增量會增加資料庫大小，應定期監看磁碟空間與備份。單一 VPS Node.js 程序／SQLite 為目前部署目標；若要多工作程序橫向擴展，需另行設計跨程序工作鎖與事件通知。

## 安全

請不要將本服務直接暴露於公網上使用明文 HTTP。雖可依你的要求不設定 HTTPS，但這意味帳號、密碼、Cookie 與聊天內容會以明文傳輸。建議至少使用 Tailscale/WireGuard 私人網路和防火牆 IP 白名單。加密 Key 不要放進版本控制。更新後請重新確認 API 中轉站對 SSE 的行為。

## 尚待驗證

- 真實 OpenAI/Claude/Gemini 官方與第三方端點的串流完成事件、Token 使用量及中斷行為，需有實際憑證才能做整合測試。
- OpenAI Responses API（/responses）與多模態不是首版支援範圍。
