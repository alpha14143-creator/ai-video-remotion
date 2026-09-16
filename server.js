
const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 10000;

const outputDir = path.join(__dirname, "outputs");
fs.mkdirSync(outputDir, { recursive: true });

app.use("/outputs", express.static(outputDir));

// ========================================
// BGM 音樂庫
// 音樂網址稍後在 Render Environment 設定
// ========================================

const BGM_LIBRARY = {
  warm: process.env.BGM_URL_WARM,
  playful: process.env.BGM_URL_PLAYFUL,
  mysterious: process.env.BGM_URL_MYSTERIOUS,
  calm: process.env.BGM_URL_CALM,
};

// ========================================
// 下載檔案
// ========================================

async function downloadFile(url, destination) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) {
    throw new Error(
      `下載失敗：${response.status} ${response.statusText}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();

  fs.writeFileSync(
    destination,
    Buffer.from(arrayBuffer)
  );
}

// ========================================
// 執行 FFmpeg
// ========================================

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      args,
      { maxBuffer: 1024 * 1024 * 20 },
      (error, stdout, stderr) => {
        if (error) {
          console.error(stderr);
          reject(error);
          return;
        }

        resolve();
      }
    );
  });
}

// ========================================
// 健康檢查
// ========================================

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "FFmpeg Video API is running",
    ffmpeg: ffmpegPath,
    bgm_enabled: true,
  });
});

// ========================================
// 影片合併與 BGM API
// ========================================

app.post("/render", async (req, res) => {
  const workDir = path.join(
    os.tmpdir(),
    `ffmpeg-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`
  );

  try {
    const {
      scenes,
      music_mood = "warm",
    } = req.body;

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

    fs.mkdirSync(workDir, { recursive: true });

    // ====================================
    // 下載所有分鏡影片
    // ====================================

    const localFiles = [];

    for (let i = 0; i < scenes.length; i++) {
      const filePath = path.join(
        workDir,
        `scene-${i + 1}.mp4`
      );

      await downloadFile(
        scenes[i].video_url,
        filePath
      );

      localFiles.push(filePath);
    }

    // ====================================
    // 建立合併清單
    // ====================================

    const concatFile = path.join(
      workDir,
      "list.txt"
    );

    const concatContent = localFiles
      .map((file) => {
        const safePath = file.replace(
          /'/g,
          "'\\''"
        );

        return `file '${safePath}'`;
      })
      .join("\n");

    fs.writeFileSync(
      concatFile,
      concatContent
    );

    // ====================================
    // 輸出路徑
    // ====================================

    const fileName =
      `video-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.mp4`;

    const mergedPath = path.join(
      workDir,
      "merged.mp4"
    );

    const outputPath = path.join(
      outputDir,
      fileName
    );

    // ====================================
    // 合併影片
    // ====================================

    try {
      // 優先快速合併，不重新編碼

      await runFFmpeg([
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concatFile,
        "-c", "copy",
        "-movflags", "+faststart",
        mergedPath,
      ]);

    } catch (copyError) {
      console.log(
        "快速合併失敗，改用重新編碼"
      );

      if (fs.existsSync(mergedPath)) {
        fs.unlinkSync(mergedPath);
      }

      await runFFmpeg([
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concatFile,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        mergedPath,
      ]);
    }

    // ====================================
    // 根據故事情緒選擇 BGM
    // ====================================

    const selectedMood =
      Object.prototype.hasOwnProperty.call(
        BGM_LIBRARY,
        music_mood
      )
        ? music_mood
        : "warm";

    const bgmUrl = BGM_LIBRARY[selectedMood];

    let bgmAdded = false;
    let bgmWarning = null;

    if (bgmUrl) {
      try {
        const parsedUrl = new URL(bgmUrl);

        // 音樂只允許從已設定的 R2 公開網址下載
        if (
          parsedUrl.protocol !== "https:" ||
          !parsedUrl.hostname.endsWith(".r2.dev")
        ) {
          throw new Error(
            "BGM 必須使用 HTTPS 的 R2 公開網址"
          );
        }

        const bgmPath = path.join(
          workDir,
          "bgm"
        );

        await downloadFile(
          bgmUrl,
          bgmPath
        );

        // ==================================
        // 混合原音與背景音樂
        // ==================================

        await runFFmpeg([
          "-y",

          "-i", mergedPath,

          // 音樂不足影片長度時自動循環
          "-stream_loop", "-1",
          "-i", bgmPath,

          "-filter_complex",
          [
            "[0:a]aresample=async=1:first_pts=0[voice]",
            "[1:a]volume=0.12[bgm]",
            "[voice][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]"
          ].join(";"),

          "-map", "0:v:0",
          "-map", "[aout]",

          // 保留原影片畫面，不重新編碼
          "-c:v", "copy",

          // 混音後輸出 AAC
          "-c:a", "aac",
          "-b:a", "192k",

          "-movflags", "+faststart",

          outputPath,
        ]);

        bgmAdded = true;

      } catch (bgmError) {
        console.error(
          "BGM 處理失敗：",
          bgmError.message
        );

        bgmWarning = bgmError.message;
      }
    }

    // ====================================
    // 若未加入 BGM，保留原合併影片
    // ====================================

    if (!bgmAdded) {
      fs.copyFileSync(
        mergedPath,
        outputPath
      );
    }

    // ====================================
    // 回傳影片網址
    // ====================================

    const protocol =
      req.headers["x-forwarded-proto"] ||
      req.protocol ||
      "https";

    const host = req.get("host");

    const videoUrl =
      `${protocol}://${host}/outputs/${fileName}`;

    res.json({
      success: true,
      message: "FFmpeg video merge completed",
      sceneCount: scenes.length,
      music_mood: selectedMood,
      bgm_added: bgmAdded,
      bgm_warning: bgmWarning,
      video_url: videoUrl,
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message,
    });

  } finally {
    try {
      fs.rmSync(workDir, {
        recursive: true,
        force: true,
      });
    } catch (error) {
      console.log(
        "暫存檔清理失敗：",
        error.message
      );
    }
  }
});

// ========================================
// 啟動伺服器
// ========================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `FFmpeg API running on port ${PORT}`
  );
});
