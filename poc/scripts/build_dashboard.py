#!/usr/bin/env python3
"""Inject data + logos into dashboard/template.html -> dashboard/index.html (single self-contained file)."""
import base64, json
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
html = (ROOT / "dashboard/template.html").read_text()
b64 = lambda f: "data:image/png;base64," + base64.b64encode((ROOT / "brand" / f).read_bytes()).decode()
for key, f in {"__LOGO_BI_BLUE__": "bi-blue.png", "__LOGO_BI_WHITE__": "bi-white.png",
               "__LOGO_BL_COLOR__": "bl-color.png", "__LOGO_BL_WHITE__": "bl-white.png"}.items():
    html = html.replace(key, b64(f))
data = json.loads((ROOT / "data/dashboard.json").read_text())
html = html.replace("__DATA__", json.dumps(data, ensure_ascii=False).replace("</", "<\\/"))
(ROOT / "dashboard/index.html").write_text(html)
print("dashboard/index.html", len(html) // 1024, "KB")

# login page (served without auth by middleware.js)
login = (ROOT / "scripts/login.template.html").read_text()
for key, f in {"__LOGO_BI_BLUE__": "bi-blue.png", "__LOGO_BI_WHITE__": "bi-white.png",
               "__LOGO_BL_COLOR__": "bl-color.png", "__LOGO_BL_WHITE__": "bl-white.png"}.items():
    login = login.replace(key, b64(f))
(ROOT / "dashboard/login.html").write_text(login)
print("dashboard/login.html", len(login) // 1024, "KB")
