"""由 index.html 產生 preview.html（示範版：預設顯示示範資料、可切換狀態）。修改 index.html 後執行：python make_preview.py"""
from pathlib import Path
here = Path(__file__).parent
s = (here / "index.html").read_text(encoding="utf-8")
def r(a, b):
    global s
    assert a in s, a
    s = s.replace(a, b, 1)
r("const demo = new URLSearchParams(location.search).get('demo');",
  "let demo = new URLSearchParams(location.search).get('demo') || 'busy';  // 預覽版：預設示範模式")
r('<a href="?demo=busy">使用中</a> · <a href="?demo=free">空閒</a> · <a href="?demo=offline">連線中斷</a> · <a href="?">返回</a>',
  '<a href="#" data-m="busy">使用中</a> · <a href="#" data-m="free">空閒</a> · <a href="#" data-m="offline">連線中斷</a>')
r("$('demo').hidden = !(demo && DEMO[demo]);",
  "$('demo').hidden = !(demo && DEMO[demo]);\ndocument.querySelectorAll('[data-m]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); demo = a.dataset.m; refresh(); }));")
r('.demo-banner{', '.demo-banner a{padding:8px 6px;display:inline-block}.demo-banner{')
(here / "preview.html").write_text(s, encoding="utf-8")
print("preview.html updated")
