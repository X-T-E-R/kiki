"""
kiki-gui batch-2 visual proof + live smoke — drives the real GUI (vite dev on
localhost:5177) against the live kap-server and captures screenshots into
apps/kiki-gui/screenshots/batch2/.

Three tiny prompts against a throwaway session rooted at %TEMP%/kiki-gui-b2:
  1. markdown reply (2x2 table + fenced bash block) — no tools
  2. Write %TEMP%/kiki-gui-b2/notes.txt      (approval → new-file diff card)
  3. Edit append a third line                 (approval → context diff card)

Then: jump-to-bottom pill, session context menu, composer plan/effort UI.
Archives the throwaway session and removes the temp dir at the end.
"""

import json
import os
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://localhost:5177"
SERVER = os.environ.get("KIMI_SERVER_URL", "http://127.0.0.1:58627")
TOKEN = Path.home().joinpath(".kimi-code", "server.token").read_text(encoding="utf8").strip()
SHOTS = Path(__file__).resolve().parent.parent / "screenshots" / "batch2"
SHOTS.mkdir(parents=True, exist_ok=True)
WORKDIR = Path(tempfile.gettempdir()) / "kiki-gui-b2"
WORKDIR.mkdir(parents=True, exist_ok=True)
WORKDIR_POSIX = str(WORKDIR).replace("\\", "/")


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


def shot(page, name: str):
    page.screenshot(path=str(SHOTS / name))
    print(f"[shot] {name}")


def send(page, text: str):
    page.fill("textarea", text)
    page.press("textarea", "Enter")
    print(f"[flow] sent: {text[:70]}…")


def wait_idle(page, timeout=120000):
    page.wait_for_selector("text=working", state="detached", timeout=timeout)
    page.wait_for_timeout(600)


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("console", lambda m: print(f"[console:{m.type}] {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: print(f"[pageerror] {e}"))

        page.goto(f"{BASE}/?server=&token={TOKEN}", wait_until="networkidle")
        page.wait_for_selector("text=New session", timeout=15000)
        page.wait_for_timeout(1000)

        # create a session rooted at the throwaway dir via the cwd field
        page.click("text=New session")
        page.wait_for_selector("input[placeholder='C:/path/to/project']", timeout=5000)
        page.fill("input[placeholder='C:/path/to/project']", WORKDIR_POSIX)
        page.fill("input[placeholder='Title (optional)']", "kiki gui batch2 (throwaway)")
        page.click("text=Create")
        page.wait_for_selector("text=A blank page", timeout=15000)
        print("[flow] session created at", WORKDIR_POSIX)

        # --- prompt 1: markdown table + code fence (no tools) ----------------
        send(
            page,
            "Reply with ONLY this markdown, no tools, no preamble: a 2x2 table with headers "
            "`Name` and `Value` and rows `alpha`/`1` and `beta`/`2`, then a fenced bash code "
            "block containing `echo hello-kiki`.",
        )
        page.wait_for_selector("table", timeout=120000)
        wait_idle(page)
        # give the lazy shiki engine a beat to upgrade the fence
        page.wait_for_timeout(2500)
        shot(page, "01-markdown-table-code.png")

        # --- prompt 2: Write (approval + new-file diff card) -----------------
        send(
            page,
            f"Use the Write tool to create the file {WORKDIR_POSIX}/notes.txt with exactly "
            "these two lines:\nalpha\nbeta\nThen reply with the single word: created",
        )
        page.wait_for_selector("text=Approval needed", timeout=120000)
        page.wait_for_timeout(400)
        shot(page, "02-approval.png")
        page.mouse.click(720, 120)  # focus out of the textarea
        page.keyboard.press("y")
        print("[flow] approved Write")
        wait_idle(page)

        # --- prompt 3: Edit append (approval + context diff card) ------------
        send(
            page,
            f"Use the Edit tool on {WORKDIR_POSIX}/notes.txt to change the line `beta` into "
            "`beta` followed by a new line `gamma` (i.e. append a third line gamma). "
            "Then reply with the single word: updated",
        )
        page.wait_for_selector("text=Approval needed", timeout=120000)
        page.mouse.click(720, 130)
        page.keyboard.press("y")
        print("[flow] approved Edit")
        wait_idle(page)

        # expand the Edit card (the one whose summary mentions notes.txt)
        edit_card = page.locator("button", has_text="Edit").last
        edit_card.click()
        page.wait_for_timeout(500)
        shot(page, "03-diff-card.png")

        # --- jump-to-bottom pill ----------------------------------------------
        page.mouse.move(720, 450)
        page.mouse.wheel(0, -3000)
        page.wait_for_timeout(700)
        shot(page, "04-jump-pill.png")
        pill = page.locator("text=Jump to latest")
        print("[check] jump pill visible:", pill.count() > 0)
        if pill.count() > 0:
            pill.click()
            page.wait_for_timeout(600)

        # --- session context menu ---------------------------------------------
        row = page.locator("aside div.group", has_text="kiki gui batch2").first
        row.hover()
        page.wait_for_timeout(300)
        row.locator("button[aria-label^='Session actions']").click()
        page.wait_for_timeout(400)
        shot(page, "05-context-menu.png")
        page.keyboard.press("Escape")

        # --- composer with plan/effort UI --------------------------------------
        page.click("button:has-text('plan')")
        page.wait_for_timeout(300)
        shot(page, "06-composer-plan-effort.png")
        effort_select = page.locator("select[title='Thinking effort']")
        print("[check] effort select visible (k3):", effort_select.count() > 0)

        browser.close()

    # ---- CLI assertions + cleanup ------------------------------------------
    notes = WORKDIR / "notes.txt"
    content = notes.read_text(encoding="utf8") if notes.exists() else ""
    print("[check] notes.txt exists:", notes.exists(), "| content:", repr(content))
    print("[check] edit landed (gamma present):", "gamma" in content)

    sessions = api("GET", "/sessions?page_size=100&include_archive=true")
    for item in sessions["data"]["items"]:
        if "batch2 (throwaway)" in (item.get("title") or "") and not item.get("archived"):
            result = api("POST", f"/sessions/{item['id']}:archive")
            print(f"[cleanup] archived {item['id']} code={result['code']}")
    shutil.rmtree(WORKDIR, ignore_errors=True)
    print("[cleanup] removed", WORKDIR)
    print("BATCH2 PROOF DONE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
