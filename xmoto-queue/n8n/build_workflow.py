"""把 web/ 裡最新的 index.html、preview.html 放進 n8n 上傳流程。修改網頁後執行：python n8n/build_workflow.py"""
import base64, json, re
from pathlib import Path
root = Path(__file__).resolve().parent.parent
p = root / "n8n" / "upload-web-to-r2.json"
wf = json.loads(p.read_text(encoding="utf-8"))
node = next(n for n in wf["nodes"] if n["name"] == "準備網頁檔案")
code = node["parameters"]["jsCode"]
for name in ("preview.html", "index.html"):
    b64 = base64.b64encode((root / "web" / name).read_bytes()).decode()
    code, n = re.subn(r'(name: "%s", b64: ")[^"]*(")' % re.escape(name), lambda m: m.group(1) + b64 + m.group(2), code)
    assert n == 1, name
node["parameters"]["jsCode"] = code
p.write_text(json.dumps(wf, ensure_ascii=False, indent=2), encoding="utf-8")
print("updated", p)
