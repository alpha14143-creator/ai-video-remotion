# LINE 分享縮圖
- 圖檔：og-image.jpg（1200×630），由 og.html 產生
- 網址：https://nan-simpledesign.nansimpledesign-studio.workers.dev/og-image.jpg?v=1
- 做法：圖片嵌入 Worker ASSETS（路徑 /og-image.jpg），index.html 加 og:* 標籤，並把 /og-image.jpg 加入 Worker 的公開讀取清單
- 換圖時把 ?v=1 改成 ?v=2，LINE 才會抓新圖
