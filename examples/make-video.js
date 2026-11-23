// 用程式產生一支影片：幾個文字畫面 + 淡入淡出轉場 + 背景音
// 執行：node examples/make-video.js
// 輸出：examples/output.mp4

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// FFmpeg 路徑：優先用專案裡的 ffmpeg-static，沒有就用系統的 ffmpeg
let ffmpeg = "ffmpeg";
try { ffmpeg = require("ffmpeg-static"); } catch {}

// 中文字型路徑（不同電腦位置不同，可用環境變數 FONT 指定）
const FONT = process.env.FONT || "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc";

// ===== 影片內容：改這裡就能做出不同影片 =====
const scenes = [
  { text: "用程式做影片", color: "0x1e3a8a", seconds: 3 },
  { text: "每一段都是程式算出來的", color: "0x065f46", seconds: 3 },
  { text: "改資料，就能產生新影片", color: "0x7c2d12", seconds: 3 },
];
const W = 1280, H = 720, FPS = 30, FADE = 0.5;

const workDir = path.join(__dirname, "tmp");
fs.mkdirSync(workDir, { recursive: true });

// 1. 每個場景各產生一段影片：純色背景 + 置中文字 + 文字淡入
const parts = scenes.map((s, i) => {
  const textFile = path.join(workDir, `text-${i}.txt`);
  fs.writeFileSync(textFile, s.text); // 用檔案傳文字，避免特殊字元跳脫問題
  const out = path.join(workDir, `part-${i}.mp4`);

  execFileSync(ffmpeg, [
    "-y",
    "-f", "lavfi", "-i", `color=c=${s.color}:s=${W}x${H}:r=${FPS}:d=${s.seconds}`,
    "-vf",
    `drawtext=fontfile=${FONT}:textfile=${textFile}:fontsize=72:fontcolor=white:` +
      `x=(w-text_w)/2:y=(h-text_h)/2:alpha='min(t/0.8,1)'`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    out,
  ], { stdio: "inherit" });

  return out;
});

// 2. 用 xfade 把各段串起來，中間加淡入淡出轉場
const inputs = parts.flatMap((p) => ["-i", p]);
let filter = "";
let last = "[0:v]";
let offset = 0;
for (let i = 1; i < parts.length; i++) {
  offset += scenes[i - 1].seconds - FADE;
  const label = `[v${i}]`;
  filter += `${last}[${i}:v]xfade=transition=fade:duration=${FADE}:offset=${offset}${label};`;
  last = label;
}
const total = scenes.reduce((a, s) => a + s.seconds, 0) - FADE * (scenes.length - 1);

// 3. 加一段簡單的背景音（440Hz 正弦波，音量調小、結尾淡出）
filter += `sine=frequency=440:duration=${total},volume=0.1,afade=t=out:st=${total - 1}:d=1[a]`;

const output = path.join(__dirname, "output.mp4");
execFileSync(ffmpeg, [
  "-y", ...inputs,
  "-filter_complex", filter,
  "-map", last, "-map", "[a]",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
  output,
], { stdio: "inherit" });

fs.rmSync(workDir, { recursive: true, force: true });
console.log(`完成：${output}（約 ${total} 秒）`);
