const express = require("express");

const app = express();
app.use(express.json({ limit: "50mb" }));

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "AI Video Remotion API"
  });
});

app.post("/render", async (req, res) => {
  try {
    const { scenes } = req.body;

    if (!scenes || !Array.isArray(scenes)) {
      return res.status(400).json({
        success: false,
        error: "scenes must be an array"
      });
    }

    console.log("收到影片場景：", scenes.length);

    res.json({
      success: true,
      message: "Render request received",
      sceneCount: scenes.length,
      scenes: scenes
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
