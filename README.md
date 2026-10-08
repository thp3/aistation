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

## VPS 一鍵安裝 / 更新（Linux/systemd）

```bash
cd /path/to/aistation
sudo bash scripts/install.sh
sudo nano .env  # 必須設定強密碼，安裝腳本會隨機生成兩個秘密值
sudo systemctl start aistation
sudo systemctl status aistation
```

後續更新：`bash scripts/update.sh`。建議以一般使用者安裝程式與資料目錄，並由 sudo 建立 systemd 單元。更新前會備份 SQLite。腳本不負責安裝 Node.js；請先安裝 24+，並確保服務使用者對目錄有寫入權限。

## 管理設定

OpenAI 相容 Endpoint 需填完整的 `https://host/v1/chat/completions`，Claude 相容則 `https://host/v1/messages`。模型偵測會呼叫同一路徑衍生的 `/models`；部分中轉站不支援此路徑，請手動新增 Model ID。新增 Endpoint 時會自動嘗試偵測並加入模型；後續只有按「偵測」才會重新查詢，聊天從 SQLite 讀模型清單。若第三方中轉站不支援模型列表 API，請手動新增。模型唯一性使用 provider record + Model ID，而提供者 Endpoint 在資料庫中唯一，因此相當於 Endpoint + Model ID。

聊天 SSE 事件：`started`, `delta`, `complete`, `error`, `stopped`。停止生成會保留已產生的文字。前端排程為每聊天獨立記憶體 FIFO，換頁時保留但**重新整理網頁即清除尚未發送訊息**；伺服器不會儲存未送出佇列。失敗時暫停該對話佇列，保留其他待送訊息；可按「繼續傳送」恢復排程。任何一對話同時僅允許一個後端串流。

使用量僅記錄上游明確提供的數值，未知為 NULL；統計 SQL SUM 忽略 NULL，若混合已知與未知數值，總和為**已知部分之和，並非真實完整總量**。成功與失敗請求各自留存狀態。OpenAI / Claude 的第三方中轉站可能有不相容事件或 token 欄位，需要個別驗證。

「匯出對話」包含對話、訊息、統計與錯誤紀錄；「匯出設定」包含端點、模型與偏好，但**不包含 Key**。完整資料備份請保存 `data/` SQLite 檔與 `.env`（加密 Key 必須完整保留），妥善保護備份。

## 每次訊息選擇思考額度

聊天輸入框底部有「思考額度」選單；每次點擊傳送時會**連同訊息**保存選擇，對話佇列中的後續選擇不會覆蓋已排隊訊息的額度。切換聊天視窗時，每個聊天保留各自的前端選擇（重新整理頁面會恢復為 API 預設）。

- **API 預設**：不傳送任何額外的思考參數，最適合不支援推理設定的第三方中轉站。
- **OpenAI 相容 /chat/completions**：依選擇傳送 `reasoning_effort`（`none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）。不是每個模型都支援所有值；不支援時會顯示供應商原始錯誤。
- **Claude 4.6 及更新的模型**：傳送 `thinking: {type: "adaptive"}`、`output_config: {effort: "low" | "medium" | "high" | "xhigh" | "max"}`；模型的允許值依供應商而定。
- **已辨識的 Claude 4.5 及以前模型**：思考等級對應至手動 `thinking: {type: "enabled", budget_tokens: N}`（低 1024、中 4096、高 8192、極高 16384、最大 32768），預留至少 2048 token 作為回覆空間。第三方非標準 Model ID 可以選擇「自訂 Token 預算」，發送相同的手動 thinking 格式。
- **自訂 Token 預算**：僅 Claude 相容 Endpoint，允許 1024～32768 的整數。Claude 4.6 目前已棄用手動 thinking，4.7 以上不支援；在這些模型選自訂額度可能會收到 HTTP 400。
- SQLite `requests` 表以非破壞性的 schema migration 增加 `thinking_mode`、`thinking_effort`、`thinking_budget_tokens`，每次訊息都記錄所要求的設定；這不是模型實際消耗的推理 token 數。實際使用量仍只採用上游傳回的數值。

官方參考：[OpenAI Chat Completions reasoning_effort](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Claude extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)、[Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort)。

## SSE 即時思考顯示與斷線保護

已支援雙向增量串流（瀏覽器透過 `fetch` 讀取 POST 回應，不使用只能 GET 的 EventSource）。伺服器將上游 OpenAI / Claude 事件轉成以下 SSE 事件：

| SSE 事件 | 內容 |
|---|---|
| `started` | 請求 ID、對話訊息 ID、使用的思考額度 |
| `thinking_delta` | 僅供應商明確回傳的可閱讀思考／摘要增量 |
| `delta` | 正式回答文字增量 |
| `complete` | 上游正式完成並保留 Token 使用量 |
| `stopped` | 使用者停止生成，保存部分思考與回答 |
| `error` | HTTP／供應商錯誤碼與已產生的部分內容 |

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
- **限制**：這是 **VPS Node.js 程序仍在執行期間** 的背景任務，不是外部持久化佇列或跨伺服器重啟自動重試。若伺服器重啟，未完成任務被標記 `SERVER_RESTARTED`，已寫入的部分文字保留，必須自行重送。尚未傳送出去的**前端 FIFO 佇列**仍保存在該瀏覽器分頁記憶體，重新整理或關閉頁面會丟失，並不會在背景自動傳送。只有**已送至後端**的請求會繼續生成。

相關 API：`GET /api/generations`、`PATCH /api/conversations/:id/messages/:messageId`、`DELETE /api/conversations/:id/messages/:messageId`、`POST /api/conversations/:id/rewind`（`{ "message_id": "..." }`）。

## 安全

請不要將本服務直接暴露於公網上使用明文 HTTP。雖可依你的要求不設定 HTTPS，但這意味帳號、密碼、Cookie 與聊天內容會以明文傳輸。建議至少使用 Tailscale/WireGuard 私人網路和防火牆 IP 白名單。加密 Key 不要放進版本控制。更新後請重新確認 API 中轉站對 SSE 的行為。

## 尚待驗證

- 真實 OpenAI/Claude 官方與第三方端點的串流完成事件、Token 使用量及中斷行為，需有實際憑證才能做整合測試。
- OpenAI Responses API（/responses）與多模態不是首版支援範圍。
