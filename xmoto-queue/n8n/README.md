# n8n：把網頁上傳到 R2

## 1. 建立 R2 金鑰（只要做一次）
Cloudflare 後台 → R2 → 右邊「Manage R2 API Tokens / 管理 API 權杖」→ Create API token
- 權限：**Object Read & Write（物件讀取和寫入）**，限定你的 bucket
- 建立後記下：**Access Key ID**、**Secret Access Key**、**Account ID**（R2 首頁右側也看得到）

## 2. 匯入流程
n8n → 右上角「⋯」或「+」→ **Import from File** → 選 `upload-web-to-r2.json`

## 3. 設定「上傳到 R2」節點
雙擊「上傳到 R2」節點：
- **Credential**：如果已經有之前建立的「**S3 account**」，直接選它；沒有的話 Create New → 類型 **S3**：
  - Endpoint：`https://<你的 Account ID>.r2.cloudflarestorage.com`
  - Region：`auto`
  - Access Key ID / Secret Access Key：填剛剛建立的
  - **Force Path Style：打開**
- **Bucket Name**：改成你的 bucket 名稱（就是現在放 GPT 初稿的那個）

## 4. 執行
按 **Execute Workflow**，然後點最後的「**核對結果**」節點看結果。每個檔案都會列出：
- 結果：✅ 成功可以打開，或 ❌ 失敗與原因
- 實際路徑：檔案在 R2 裡的位置（確認有在 `xmoto-queue/` 資料夾裡，不是在最外層）
- 網址：可以直接用手機打開

只有看到 ✅ 才算完成。出現 404 時，先到 R2 後台確認檔案位置，不要重複上傳。

成功後兩個檔案會在：
- `xmoto-queue/preview.html`：示範版，手機打開 `https://pub-…r2.dev/xmoto-queue/preview.html`
- `xmoto-queue/index.html`：正式版（等店內電腦開始上傳 status.json 後才會有數字）

要換資料夾名稱，改「準備網頁檔案」節點第一行的 `FOLDER`；店內電腦 `config.json` 的 `r2.key` 也要改成同一個資料夾。
網頁有修改時，請 Claude 重新產生這個流程檔再匯入執行即可。
