const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const app = express();

app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 10000;

// ========================================
// 輸出資料夾
// ========================================

const outputDir = path.join(__dirname, "outputs");

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

app.use("/outputs", express.static(outputDir));

// ========================================
// 下載影片
// ========================================

async function downloadFile(url, destination) {
  console.log("下載影片：", url);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `影片下載失敗：${response.status} ${response.statusText}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();

  fs.writeFileSync(destination, Buffer.from(arrayBuffer));

  console.log("下載完成：", destination);
}

// ========================================
// 執行 FFmpeg
// ========================================

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log("開始執行 FFmpeg");
    console.log(ffmpegPath, args.join(" "));

    execFile(
      ffmpegPath,
      args,
      {
        maxBuffer: 1024 * 1024 * 20,
      },
      (error, stdout, stderr) => {
        if (stdout) {
          console.log(stdout);
        }

        if (stderr) {
          console.log(stderr);
        }

        if (error) {
          reject(error);
          return;
        }

        resolve();
      }
    );
  });
}

// ========================================
// 首頁測試
// ========================================

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "FFmpeg Video API is running",
    ffmpeg: ffmpegPath,
  });
});

// ========================================
// FFmpeg 合併 API
// ========================================

app.post("/render", async (req, res) => {
  const workDir = path.join(
    os.tmpdir(),
    `ffmpeg-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );

  try {
    const { scenes } = req.body;

    if (!Array.isArray(scenes) || scenes.length === 0) {
      return res.status(400).json({
        success: false,
        error: "scenes 必須是非空陣列",
      });
    }

    for (const scene of scenes) {
      if (!scene.video_url) {
        return res.status(400).json({
          success: false,
          error: "每個 scene 都必須包含 video_url",
        });
      }
    }

    console.log("收到影片合併工作");
    console.log("影片數量：", scenes.length);

    fs.mkdirSync(workDir, { recursive: true });

    // ========================================
    // 下載所有影片
    // ========================================

    const localFiles = [];

    for (let i = 0; i < scenes.length; i++) {
      const filePath = path.join(workDir, `scene-${i + 1}.mp4`);

      await downloadFile(scenes[i].video_url, filePath);

      localFiles.push(filePath);
    }

    // ========================================
    // 建立 FFmpeg concat 清單
    // ========================================

    const concatFile = path.join(workDir, "list.txt");

    const concatContent = localFiles
      .map((file) => {
        const safePath = file.replace(/'/g, "'\\''");
        return `file '${safePath}'`;
      })
      .join("\n");

    fs.writeFileSync(concatFile, concatContent);

    // ========================================
    // 輸出檔案
    // ========================================

    const fileName = `video-${Date.now()}.mp4`;
    const outputPath = path.join(outputDir, fileName);

    console.log("開始 FFmpeg 快速合併");

    try {
      // 第一優先：
      // 不重新編碼，速度最快
      await runFFmpeg([
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatFile,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        outputPath,
      ]);

      console.log("快速合併成功");
    } catch (copyError) {
      // ========================================
      // 如果影片規格不同，自動重新編碼
      // ========================================

      console.log("快速合併失敗，改用重新編碼模式");
      console.log(copyError.message);

      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }

      await runFFmpeg([
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatFile,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        outputPath,
      ]);

      console.log("重新編碼合併成功");
    }

    // ========================================
    // 回傳影片網址
    // ========================================

    const protocol =
      req.headers["x-forwarded-proto"] ||
      req.protocol ||
      "https";

    const host = req.get("host");

    const videoUrl =
      `${protocol}://${host}/outputs/${fileName}`;

    console.log("影片完成：", videoUrl);

    res.json({
      success: true,
      message: "FFmpeg video merge completed",
      sceneCount: scenes.length,
      video_url: videoUrl,
    });
  } catch (error) {
    console.error("FFmpeg 處理失敗");
    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message,
    });
  } finally {
    try {
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, {
          recursive: true,
          force: true,
        });
      }
    } catch (cleanupError) {
      console.log("暫存檔清理失敗：", cleanupError.message);
    }
  }
});

// ========================================
// 啟動伺服器
// ========================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`FFmpeg API running on port ${PORT}`);
  console.log(`FFmpeg path: ${ffmpegPath}`);
});