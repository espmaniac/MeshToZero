"""Browser regressions for workspace navigation and model editing.

Run with: python3 -m unittest discover -s tests -v
Requires Playwright and Chromium; no application server is needed.
"""

import functools
import os
from pathlib import Path
import shutil
import threading
import unittest
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
TRIANGLE = b"v 1 2 3\nv 5 2 3\nv 1 6 3\nf 1 2 3\n"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class WorkspaceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        handler = functools.partial(QuietHandler, directory=str(ROOT))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.playwright = sync_playwright().start()
        executable = os.environ.get("CHROMIUM_EXECUTABLE") or shutil.which("chromium")
        cls.browser = cls.playwright.chromium.launch(
            executable_path=executable,
            headless=True,
            args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
        )

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.context = self.browser.new_context(
            viewport={"width": 1440, "height": 960}, reduced_motion="reduce"
        )
        self.page = self.context.new_page()
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.goto(self.url, wait_until="networkidle")
        expect(self.page.locator('[data-gizmo-mode="translate"]')).to_be_visible()

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def import_triangle(self):
        self.page.locator("#fileInput").set_input_files(
            {"name": "triangle.obj", "mimeType": "text/plain", "buffer": TRIANGLE}
        )
        expect(self.page.locator("#modelName")).to_have_text("triangle.obj")
        expect(self.page.locator("#exportButton")).to_be_enabled()

    def test_settings_keep_state_and_isolate_keyboard_shortcuts(self):
        page = self.page
        page.locator("#layFlatButton").click()
        expect(page.locator("#layFlatWorkbench")).to_be_visible()
        page.locator("#settingsButton").click()
        dialog = page.locator("#settingsDialog")
        expect(dialog).to_be_visible()
        expect(dialog.locator("[autofocus]")).to_be_focused()
        for _ in range(18):
            page.keyboard.press("Tab")
            self.assertTrue(dialog.evaluate("d => d.contains(document.activeElement)"))
        page.locator("#gridSnapEnabled").check()
        page.locator("#gridSnapStep").fill("2.5")
        page.locator("#angleSnapEnabled").check()
        page.locator("#angleSnapStep").fill("30")
        page.locator('[data-snap-mode="vertex"]').click()
        page.locator('[data-gizmo-space="local"]').click()
        expect(page.locator("#snapSummary")).to_have_text("Snapping on · 3")
        page.locator("#themeToggle").click()
        expect(page.locator("html")).to_have_attribute("data-theme", "dark")
        page.keyboard.press("1")
        page.keyboard.press("Escape")
        expect(dialog).not_to_be_visible()
        expect(page.locator("#settingsButton")).to_be_focused()
        expect(page.locator("#layFlatWorkbench")).to_be_visible()
        page.locator("#settingsButton").click()
        expect(page.locator("#gridSnapStep")).to_have_value("2.5")
        expect(page.locator("#angleSnapStep")).to_have_value("30")
        expect(page.locator('[data-gizmo-space="local"]')).to_have_attribute("aria-pressed", "true")
        page.locator('#settingsDialog [data-close-dialog]').last.click()
        page.reload(wait_until="networkidle")
        expect(page.locator("html")).to_have_attribute("data-theme", "dark")

    def test_tools_precision_history_and_export(self):
        page = self.page
        self.import_triangle()
        expect(page.locator("#planeButton")).not_to_be_visible()
        page.locator("#moreTools > summary").click()
        page.locator("#planeButton").click()
        expect(page.locator("#planeWorkbench")).to_be_visible()
        page.locator('[data-gizmo-mode="translate"]').click()
        expect(page.locator("#planeWorkbench")).not_to_be_visible()
        expect(page.locator("#precisionControls")).not_to_have_attribute("open", "")
        page.locator("#precisionControls > summary").click()
        x = page.locator('[data-transform="position"][data-axis="x"]')
        x.fill("10")
        x.press("Tab")
        expect(page.locator("#statusPosition")).to_contain_text("X 10.000")
        page.locator("#undoButton").click()
        expect(x).to_have_value("0.000")
        page.locator("#redoButton").click()
        expect(x).to_have_value("10.000")
        page.locator('[data-open-dialog="modelDialog"]').click()
        expect(page.locator("#browserModelName")).to_contain_text("triangle")
        entries = page.locator("#historyList .history-entry")
        self.assertGreater(entries.count(), 1)
        entries.first.click()
        page.keyboard.press("Escape")
        expect(x).to_have_value("0.000")
        page.locator("#dropToBedButton").click()
        with page.expect_download() as download_info:
            page.locator("#exportButton").click()
        output = Path(download_info.value.path()).read_text()
        vertices = [line.split()[1:] for line in output.splitlines() if line.startswith("v ")]
        self.assertEqual(len(vertices), 3)
        self.assertTrue(all(abs(float(v[2])) < 1e-6 for v in vertices))

    def test_alignment_and_construction_tools(self):
        page = self.page
        page.locator('[data-section="rotation"]').click()
        expect(page.locator("#applyOrientation")).to_be_enabled(timeout=15000)
        page.locator("#applyOrientation").click()
        page.locator('[data-gizmo-mode="translate"]').click()
        page.locator("#moreTools > summary").click()
        page.locator("#planeButton").click()
        page.locator("#createPlaneButton").click()
        page.locator('[data-open-dialog="modelDialog"]').click()
        self.assertGreater(page.locator("#createdPlaneList .created-plane-row").count(), 0)
        page.keyboard.press("Escape")
        page.locator('[data-section="level"]').click()
        expect(page.locator("#levelWorkbench")).to_be_visible()
        page.locator('[data-gizmo-mode="rotate"]').click()
        expect(page.locator("#levelWorkbench")).not_to_be_visible()
        expect(page.locator('[data-gizmo-mode="rotate"]')).to_have_attribute("aria-pressed", "true")

    def test_responsive_dialogs_and_disclosures(self):
        page = self.page
        for width, height in [(1440, 960), (820, 900), (390, 844), (320, 740), (667, 375)]:
            for theme in ("light", "dark"):
                with self.subTest(width=width, theme=theme):
                    page.set_viewport_size({"width": width, "height": height})
                    page.emulate_media(color_scheme=theme)
                    self.assertGreater(page.locator("#viewportCanvas").bounding_box()["height"], 100)
                    page.locator("#settingsButton").click()
                    dialog = page.locator("#settingsDialog")
                    expect(dialog).to_be_visible()
                    bounds = dialog.bounding_box()
                    self.assertGreaterEqual(bounds["x"], 0)
                    self.assertLessEqual(bounds["x"] + bounds["width"], width)
                    self.assertLessEqual(bounds["y"] + bounds["height"], height)
                    expect(page.locator("#themeToggle")).to_be_visible()
                    # Native dialogs close from the backdrop without activating the scene.
                    page.mouse.click(2, 2)
                    expect(dialog).not_to_be_visible()
                    if not page.locator("#moreTools").evaluate("e => e.open"):
                        page.locator("#moreTools > summary").click()
                    page.locator("#inspectButton").click()
                    expect(page.locator("#inspectWorkbench")).to_be_visible()
                    page.locator('[data-gizmo-mode="translate"]').click()
                    expect(page.locator("#inspectWorkbench")).not_to_be_visible()
                    page.locator("#moreTools > summary").click()
                    self.assertEqual(page.evaluate("document.documentElement.scrollWidth"), width)


if __name__ == "__main__":
    unittest.main()
