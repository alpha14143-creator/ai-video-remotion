const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { bundle } = require("@remotion/bundler");
const {
  selectComposition,
  renderMedia,
} = require("@remotion/renderer");

const app = express();

app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 10000;

// 成品輸出資料夾
const outputDir = path.join(__dirname, "outputs");

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// 讓輸出的 MP4 可以透過網址下載
app.use("/outputs", express.static(outputDir));


// -------------------------
// 建立 Remotion 影片模板
// -------------------------

const remotionEntry = `
import React from "react";
import {
  registerRoot,
  Composition,
  Sequence,
  AbsoluteFill,
  OffthreadVideo
} from "remotion";

const FPS = 30;

const AutoVideo = ({ scenes }) => {

  let currentFrame = 0;

  return React.createElement(
    AbsoluteFill,
    {
      style: {
        backgroundColor: "black"
      }
    },

    ...(scenes || []).map((scene, index) => {

      const durationFrames =
        Math.max(1, Math.round((scene.duration || 8) * FPS));

      const startFrame = currentFrame;

      currentFrame += durationFrames;

      return React.createElement(
        Sequence,
        {
          key: index,
          from: startFrame,
          durationInFrames: durationFrames
        },

        React.createElement(OffthreadVideo, {
          src: scene.video_url,
          muted: true,
          style: {
            width: "100%",
            height: "100%",
            objectFit: "cover"
          }
        })
      );
    })
  );
};


const RemotionRoot = () => {

  return React.createElement(Composition, {
    id: "AutoVideo",
    component: AutoVideo,

    durationInFrames: 300,
    fps: FPS,

    width: 1280,
    height: 720,

    defaultProps: {
      scenes: []
    }
  });
};

registerRoot(RemotionRoot);
`;

const entryPath = path.join(
  os.tmpdir(),
  "remotion-entry.jsx"
);

fs.writeFileSync(
  entryPath,
  remotionEntry,
  "utf8"
);


// 快取 Remotion bundle
let bundlePromise = null;

const getBundle = async () => {

  if (!bundlePromise) {

    console.log("建立 Remotion bundle...");

    bundlePromise = bundle({
      entryPoint: entryPath
    });

  }

  return bundlePromise;
};


// -------------------------
// API 狀態
// -------------------------

app.get("/", (req, res) => {

  res.json({
    status: "ok",
    service: "AI Video Remotion API"
  });

});


// -------------------------
// Render API
// -------------------------

app.post("/render", async (req, res) => {

  try {

    const { scenes } = req.body;

    if (!scenes || !Array.isArray(scenes)) {

      return res.status(400).json({
        success: false,
        error: "scenes must be an array"
      });

    }


    if (scenes.length === 0) {

      return res.status(400).json({
        success: false,
        error: "scenes is empty"
      });

    }


    // 檢查每一段影片
    for (const scene of scenes) {

      if (!scene.video_url) {

        return res.status(400).json({
          success: false,
          error: "Every scene needs video_url"
        });

      }

    }


    console.log(
      "收到影片場景：",
      scenes.length
    );


    // 計算影片總長度
    const totalDuration = scenes.reduce(
      (sum, scene) =>
        sum + Number(scene.duration || 8),
      0
    );

    const totalFrames =
      Math.max(
        1,
        Math.round(totalDuration * 30)
      );


    console.log(
      "影片總秒數：",
      totalDuration
    );

    console.log(
      "影片總幀數：",
      totalFrames
    );


    // 建立 Remotion bundle
    console.log("準備建立 Remotion bundle...");

    const serveUrl =
      await getBundle();

    console.log("Remotion bundle 完成");


    const inputProps = {
      scenes
    };


    // 找到 Composition
    console.log("開始 selectComposition...");

    const composition =
      await selectComposition({
        serveUrl,
        id: "AutoVideo",
        inputProps
      });

    console.log("selectComposition 完成");


    // 改成實際影片總長度
    const finalComposition = {
      ...composition,
      durationInFrames: totalFrames
    };


    const fileName =
      `video-${Date.now()}.mp4`;

    const outputLocation =
      path.join(
        outputDir,
        fileName
      );


    console.log(
      "開始 Remotion Render..."
    );


    let lastLoggedPercent = -1;

    await renderMedia({
      composition: finalComposition,
      serveUrl,
      codec: "h264",
      outputLocation,
      inputProps,
      concurrency: 1,

      onProgress: ({ progress }) => {
        const percent =
          Math.round(progress * 100);

        if (
          percent !== lastLoggedPercent &&
          percent % 5 === 0
        ) {
          lastLoggedPercent = percent;

          console.log(
            `Render progress: ${percent}%`
          );
        }
      }
    });


    console.log(
      "影片完成：",
      outputLocation
    );


    const videoUrl =
      `${req.protocol}://${req.get("host")}/outputs/${fileName}`;


    res.json({

      success: true,

      message:
        "Video rendered successfully",

      sceneCount:
        scenes.length,

      duration:
        totalDuration,

      video_url:
        videoUrl

    });


  }

  catch (error) {

    console.error(
      "Render error:",
      error
    );


    res.status(500).json({

      success: false,

      error:
        error.message

    });

  }

});


app.listen(PORT, () => {

  console.log(
    `Server running on port ${PORT}`
  );

});