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

## 安全

請不要將本服務直接暴露於公網上使用明文 HTTP。雖可依你的要求不設定 HTTPS，但這意味帳號、密碼、Cookie 與聊天內容會以明文傳輸。建議至少使用 Tailscale/WireGuard 私人網路和防火牆 IP 白名單。加密 Key 不要放進版本控制。更新後請重新確認 API 中轉站對 SSE 的行為。

## 尚待驗證

- 真實 OpenAI/Claude 官方與第三方端點的串流完成事件、Token 使用量及中斷行為，需有實際憑證才能做整合測試。
- OpenAI Responses API（/responses）與多模態不是首版支援範圍。
