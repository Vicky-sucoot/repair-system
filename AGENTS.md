# 儲存庫指南

## 專案結構

純前端靜態網站（GitHub Pages），不需建置。頁面為 `index.html`、`style.css`；邏輯放在 `src/`（`dca.js` 為試算核心純函式，`yahoo.js` 解析股價 API，`taifex.js` 解析期交所夜盤資料，`chart.js` 繪圖，`app.js` 處理畫面）；資料下載腳本放在 `scripts/`，產生的股價資料為 `data/prices.json`（由 GitHub Actions 更新，請勿手動編輯）；測試放在 `tests/`，檔名為 `*.test.js`。

## 建置、測試與開發指令

需要 Node.js 20 以上，無相依套件。`npm test` 執行全部測試，`node --test tests/dca.test.js` 執行單一檔案；`npm run serve` 在 http://localhost:8000 預覽；`npm run fetch-prices` 下載最新股價。提交前可執行 `git diff --check` 檢查空白字元。

## 程式碼風格與命名

目前尚未設定特定語言的風格規範或格式化工具。縮排與命名請遵循所選生態系的慣例。若第一版實作引入格式化工具或程式碼檢查工具，請將設定檔納入版本控制，並記錄執行方式。模組名稱應能反映各自的用途。

## 測試

使用 Node 內建 `node:test`。變更試算規則時，請在 `tests/dca.test.js` 涵蓋主要流程及失敗情境（缺資料、假日順延、待成交、整股與手續費、配息）。

## 提交與合併請求

目前尚無提交紀錄可供參考。提交標題應簡短並以動詞開頭，例如 `Add contributor guidelines`。提出合併請求（Pull Request）時，請說明變更內容、原因與驗證方式。如有相關議題，請附上連結。若介面有可見變更，可附上有助於審查的畫面截圖。
