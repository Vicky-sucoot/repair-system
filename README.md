# 0050 × S&P 500 定期定額追蹤

輸入**原始投入金額**與**每月定期定額金額**，網站依網路股價自動計算每月買進、**庫存股數**、平均成本、市值、**總損益**、報酬率與年化報酬率（XIRR），並以走勢圖比較資產總值與累計投入。所有金額以新台幣顯示。

支援標的：

| 標的 | 說明 | 幣別 |
|---|---|---|
| 0050 | 元大台灣50 | 新台幣 |
| VOO | Vanguard S&P 500 ETF（複委託） | 美元，依扣款日匯率換算 |
| 00646 | 元大S&P500 | 新台幣 |

畫面有兩個方案（預設 0050 與 VOO），每個方案都可以改標的、開始日期、扣款日、手續費率、最低手續費、股息預扣稅、整股買進與股息再投入。設定只存在瀏覽器的 localStorage，不會上傳。

## 股價資料

瀏覽器無法直接跨網域讀取 Yahoo Finance，因此由 GitHub Actions 工作流程 [`update-prices.yml`](.github/workflows/update-prices.yml) 執行 `scripts/fetch-prices.mjs`：

- 下載 0050.TW、VOO、00646.TW 的日收盤價與配息，以及美元兌新台幣匯率（`TWD=X`），寫入 `data/prices.json` 並提交回 `main`。
- 觸發時機：週一至週五 UTC 23:17（台灣時間週二至週六 07:17）、修改 `src/`／抓取腳本並推送到 `main` 時，或在 Actions 頁面手動執行「更新股價資料」。
- 單一標的下載失敗時沿用上一版資料；全部失敗則不更新。
- 網站顯示資料更新時間，超過 4 天未更新會提示資料可能已過期。

## 目錄結構

- `index.html`、`style.css`：頁面與樣式
- `src/dca.js`：定期定額試算核心（純函式，瀏覽器與測試共用）
- `src/yahoo.js`：解析 Yahoo Finance chart API
- `src/chart.js`：SVG 走勢圖
- `src/app.js`：表單、讀取資料與畫面更新
- `scripts/fetch-prices.mjs`：下載股價並產生 `data/prices.json`
- `tests/`：`node:test` 單元測試
- `sw.js`、`pwa.js`、`manifest.webmanifest`、`icons/`：PWA（網路優先，離線時使用上次快取的網頁與股價）

## 開發

需要 Node.js 20 以上（不需安裝套件）。

```bash
npm test                     # 執行全部測試
node --test tests/dca.test.js  # 執行單一測試檔
npm run fetch-prices         # 下載股價（需能連到 Yahoo Finance）
npm run serve                # 啟動 http://localhost:8000（不可用 file:// 開啟）
```

## 計算規則

- 原始投入於開始日（遇假日順延）以收盤價一次買進；每月於扣款日買進，遇假日順延到下一個交易日，扣款日大於當月天數時改為月底。
- 整股買進時只買得起的整數股數，未用完的金額不扣款；手續費＝成交金額 × 費率，不足最低手續費以最低計。
- 配息依除息日前的持股計算，扣除預扣稅後，可選擇當日再投入或列為現金（計入總報酬）。
- 試算以收盤價估算，未計入證交稅以外的其他費用與實際成交價差異，僅供參考，不構成投資建議。
