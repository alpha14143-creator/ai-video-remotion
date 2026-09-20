
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
          reject(
            new Error(
              `FFmpeg 執行失敗：${stderr || error.message}`
            )
          );
          return;
        }

        resolve();
      }
    );
  });
}

// ========================================
// 檢查來源影片是否有音軌
// ========================================

function hasAudioStream(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      ["-hide_banner", "-i", filePath],
      { maxBuffer: 1024 * 1024 * 20 },
      (error, stdout, stderr) => {
        const info = stderr || "";

        if (!info.includes("Input #")) {
          reject(
            new Error(`無法讀取影片資訊：${info || error?.message}`)
          );
          return;
        }

        resolve(/Stream #\d+:\d+(?:\[[^\]]+\])?(?:\([^)]+\))?: Audio:/i.test(info));
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
    scene_trimming_enabled: true,
  });
});

// ========================================
// 影片裁切、合併與 BGM API
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

    // ====================================
    // 先驗證每段影片網址與裁切秒數
    // ====================================

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];

      if (
        typeof scene.video_url !== "string" ||
        !scene.video_url.trim()
      ) {
        return res.status(400).json({
          success: false,
          error: `第 ${i + 1} 段缺少 video_url`,
        });
      }

      if (
        !Number.isInteger(scene.duration) ||
        scene.duration < 1 ||
        scene.duration > 15
      ) {
        return res.status(400).json({
          success: false,
          error:
            `第 ${i + 1} 段 duration 必須是 1～15 的整數秒數`,
        });
      }
    }

    fs.mkdirSync(workDir, { recursive: true });

    const trimmedFiles = [];
    const totalDuration = scenes.reduce(
      (sum, scene) => sum + scene.duration,
      0
    );

    // ====================================
    // 逐段下載、裁切並統一影音格式
    // ====================================

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];

      const sourcePath = path.join(
        workDir,
        `source-${i + 1}.mp4`
      );

      const trimmedPath = path.join(
        workDir,
        `trimmed-${i + 1}.mp4`
      );

      await downloadFile(
        scene.video_url,
        sourcePath
      );

      const sourceHasAudio = await hasAudioStream(sourcePath);

      const args = [
        "-y",
        "-i", sourcePath,
      ];

      // 沒有原音軌的影片，補一條靜音音軌，
      // 避免後續合併或 BGM 混音失敗。
      if (!sourceHasAudio) {
        args.push(
          "-f", "lavfi",
          "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"
        );
      }

      args.push(
        "-map", "0:v:0",
        "-map", sourceHasAudio ? "0:a:0" : "1:a:0",

        // 統一成 1280×720，維持原畫面比例。
        "-vf",
        "scale=1280:720:force_original_aspect_ratio=decrease," +
        "pad=1280:720:(ow-iw)/2:(oh-ih)/2," +
        "fps=30,setsar=1,format=yuv420p",

        // 音訊不足時補靜音，避免短音軌截斷影片。
        "-af", "aresample=48000:async=1:first_pts=0,apad",

        // 依劇本秒數裁切。
        "-t", String(scene.duration),

        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",

        "-c:a", "aac",
        "-b:a", "128k",
        "-ar", "48000",
        "-ac", "2",

        "-movflags", "+faststart",
        trimmedPath
      );

      await runFFmpeg(args);

      trimmedFiles.push(trimmedPath);

      console.log(
        `第 ${i + 1} 段處理完成：保留 ${scene.duration} 秒`
      );
    }

    // ====================================
    // 建立合併清單
    // ====================================

    const concatFile = path.join(
      workDir,
      "list.txt"
    );

    const concatContent = trimmedFiles
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
    // 合併已裁切的影片
    // ====================================

    await runFFmpeg([
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", concatFile,
      "-c", "copy",
      "-movflags", "+faststart",
      mergedPath,
    ]);

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

          // 音樂不足影片長度時自動循環。
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

          "-c:v", "copy",
          "-c:a", "aac",
          "-b:a", "192k",

          "-t", String(totalDuration),
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
    // 回傳影片網址與裁切資訊
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
      message: "FFmpeg video trim and merge completed",
      sceneCount: scenes.length,
      planned_duration: totalDuration,
      scene_durations: scenes.map((scene) => scene.duration),
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
