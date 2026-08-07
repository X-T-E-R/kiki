"""Batch-2 re-shoots: code-block frame fix (01), CHANGES label case (03),
composer plan/effort with precise selector (06). No prompts are sent —
the archived batch2 session is reopened read-only for 01/03, and a fresh
throwaway session (created + archived, zero prompts) hosts 06."""

import json
import os
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://localhost:5177"
SERVER = os.environ.get("KIMI_SERVER_URL", "http://127.0.0.1:58627")
TOKEN = Path.home().joinpath(".kimi-code", "server.token").read_text(encoding="utf8").strip()
SHOTS = Path(__file__).resolve().parent.parent / "screenshots" / "batch2"


def api(method: str, path: str, body=None) -> dict:
    headers = {"Authorization": f"Bearer {TOKEN}"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        f"{SERVER}/api/v1{path}", method=method, headers=headers,
        data=json.dumps(body).encode() if body is not None else None,
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.on("pageerror", lambda e: print(f"[pageerror] {e}"))
    page.goto(f"{BASE}/?server=&token={TOKEN}", wait_until="networkidle")
    page.wait_for_selector("text=New session", timeout=15000)
    page.wait_for_timeout(1200)

    # --- reopen the archived batch2 session read-only ------------------------
    page.click("text=Show archived")
    page.wait_for_timeout(1200)
    page.locator("aside div.group", has_text="kiki gui batch2").first.click()
    page.wait_for_selector("text=echo hello-kiki", timeout=15000)
    page.wait_for_timeout(2000)  # let shiki upgrade the fence

    # 01 — markdown region (table + code fence)
    page.mouse.move(720, 450)
    page.mouse.wheel(0, -100000)
    page.wait_for_timeout(500)
    page.screenshot(path=str(SHOTS / "01-markdown-table-code.png"))
    print("[shot] 01 re-taken")

    # 03 — expand the Edit card again, shoot the diff card region
    page.locator("button", has_text="Edit").last.click()
    page.wait_for_timeout(400)
    edit_region = page.locator("text=Replaced 1 occurrence").first
    edit_region.scroll_into_view_if_needed()
    page.wait_for_timeout(300)
    page.screenshot(path=str(SHOTS / "03-diff-card.png"))
    print("[shot] 03 re-taken")

    # --- 06: composer on a fresh zero-prompt throwaway session ----------------
    workspaces = api("GET", "/workspaces")["data"]["items"]
    live = [w for w in workspaces if os.path.isdir(w["root"])]
    ws = sorted(live, key=lambda w: w["last_opened_at"], reverse=True)[0]
    created = api("POST", "/sessions", {"title": "kiki composer shot (throwaway)", "workspace_id": ws["id"]})
    sid = created["data"]["id"]
    page.click("text=Hide archived")
    page.wait_for_timeout(1500)
    page.locator("aside div.group", has_text="kiki composer shot").first.click()
    page.wait_for_selector("text=A blank page", timeout=15000)
    page.click("button[title^='Plan mode']")  # precise: the composer pill
    page.wait_for_timeout(300)
    page.screenshot(path=str(SHOTS / "06-composer-plan-effort.png"))
    print("[shot] 06 re-taken")
    browser.close()

result = api("POST", f"/sessions/{sid}:archive")
print(f"[cleanup] archived {sid} code={result['code']}")
print("RESHOOT DONE")
