"""把 web/ 裡的網頁（index.html、preview.html）和縮圖（*.jpg / *.png）放進 n8n 上傳流程。
修改網頁後執行：python n8n/build_workflow.py"""
import base64, json, re
from pathlib import Path
root = Path(__file__).resolve().parent.parent
web = root / "web"
p = root / "n8n" / "upload-web-to-r2.json"
MIME = {".html": "text/html", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}
files = [web / "preview.html", web / "index.html"] + sorted(f for f in web.iterdir() if f.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp"))
items = ",\n".join(
    "  { name: %s, mime: %s, b64: %s }" % (json.dumps(f.name), json.dumps(MIME[f.suffix.lower()]),
                                         json.dumps(base64.b64encode(f.read_bytes()).decode()))
    for f in files)
wf = json.loads(p.read_text(encoding="utf-8"))
node = next(n for n in wf["nodes"] if n["name"] == "準備網頁檔案")
code = node["parameters"]["jsCode"]
code = re.sub(r"const FILES = \[\n.*?\n\];", lambda m: "const FILES = [\n" + items + "\n];", code, flags=re.S)
code = code.replace("mimeType: 'text/html', fileName: f.name, fileExtension: 'html'",
                    "mimeType: f.mime || 'text/html', fileName: f.name, fileExtension: f.name.split('.').pop()")
node["parameters"]["jsCode"] = code
# 核對結果：圖片不檢查 <!doctype html>
chk = next(n for n in wf["nodes"] if n["name"] == "核對結果")
chk["parameters"]["jsCode"] = chk["parameters"]["jsCode"].replace(
    "const ok = status === 200 && body.toLowerCase().includes('<!doctype html');",
    "const ok = status === 200 && (!src.key.endsWith('.html') || body.toLowerCase().includes('<!doctype html'));")
p.write_text(json.dumps(wf, ensure_ascii=False, indent=2), encoding="utf-8")
print("updated", p, [f.name for f in files])
