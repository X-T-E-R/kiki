"""
kiki-gui visual proof — drives the real GUI (vite dev on localhost:5177)
against the live kap-server with headless Chromium and captures screenshots
into apps/kiki-gui/screenshots/.

Flow: connect screen → deep-link connect → session sidebar → create session
via the UI → send one tiny prompt (echo kiki-gui, permission mode manual) →
approval card → approve via the `y` shortcut → streamed reply + tool card.

Sends exactly ONE tiny prompt (user quota). Archives the throwaway session
afterwards. Token is read from ~/.kimi-code/server.token at runtime.
"""

import json
import os
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://localhost:5177"
SERVER = os.environ.get("KIMI_SERVER_URL", "http://127.0.0.1:58627")
TOKEN = Path.home().joinpath(".kimi-code", "server.token").read_text(encoding="utf8").strip()
SHOTS = Path(__file__).resolve().parent.parent / "screenshots"
SHOTS.mkdir(exist_ok=True)


def api(method: str, path: str, body=None) -> dict:
    headers = {"Authorization": f"Bearer {TOKEN}"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        f"{SERVER}/api/v1{path}",
        method=method,
        headers=headers,
        data=json.dumps(body).encode() if body is not None else None,
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def shot(page, name: str):
    path = SHOTS / name
    page.screenshot(path=str(path))
    print(f"[shot] {name}")


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("console", lambda msg: print(f"[console:{msg.type}] {msg.text}") if msg.type == "error" else None)
        page.on("pageerror", lambda err: print(f"[pageerror] {err}"))

        # 1. connect screen
        page.goto(BASE + "/", wait_until="networkidle")
        page.wait_for_timeout(600)
        shot(page, "01-connect.png")

        # 2. deep-link connect (url empty = same-origin dev proxy; `server` is
        # the Vite-dev-safe query key — `?url=` gets 403'd by Vite itself)
        page.goto(f"{BASE}/?server=&token={TOKEN}", wait_until="networkidle")
        page.wait_for_selector("text=New session", timeout=15000)
        page.wait_for_timeout(1200)  # let the sessions poll + ws settle
        shot(page, "02-sessions.png")

        # 3. create a session through the UI form
        page.click("text=New session")
        page.wait_for_selector("text=Create", timeout=5000)
        page.fill("input[placeholder='Title (optional)']", "kiki gui demo (throwaway)")
        page.click("text=Create")
        page.wait_for_selector("text=A blank page", timeout=15000)
        page.wait_for_timeout(500)
        shot(page, "03-new-session.png")

        # 4. send one tiny prompt (manual mode is the default)
        prompt = (
            "Use the Bash tool to run exactly this shell command and nothing else: "
            "echo kiki-gui. Then reply with the single word: done"
        )
        page.fill("textarea", prompt)
        page.press("textarea", "Enter")
        print("[flow] prompt sent")

        # 5. approval card
        page.wait_for_selector("text=Approval needed", timeout=90000)
        page.wait_for_timeout(400)
        shot(page, "04-approval.png")

        # 6. approve with the `y` keyboard shortcut (focus out of the textarea)
        page.mouse.click(720, 120)
        page.keyboard.press("y")
        print("[flow] approved via keyboard")

        # 7. wait for the streamed reply to settle (busy indicator disappears)
        page.wait_for_selector("text=working", state="detached", timeout=120000)
        page.wait_for_timeout(800)
        shot(page, "05-transcript.png")

        # 8. expand the tool card for the detail view
        try:
            page.click("text=Bash", timeout=5000)
            page.wait_for_timeout(400)
            shot(page, "06-tool-expanded.png")
        except Exception as exc:  # noqa: BLE001
            print(f"[warn] tool card expand skipped: {exc}")

        browser.close()

    # cleanup: archive every throwaway demo session
    sessions = api("GET", "/sessions?page_size=100")
    for item in sessions["data"]["items"]:
        if item.get("title") == "kiki gui demo (throwaway)" and not item.get("archived"):
            result = api("POST", f"/sessions/{item['id']}:archive")
            print(f"[cleanup] archived {item['id']} code={result['code']}")

    print("VISUAL PROOF DONE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
