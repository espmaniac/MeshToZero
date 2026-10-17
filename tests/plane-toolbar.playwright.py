#!/usr/bin/env python3
"""Check progressive plane workflows in the contextual viewport toolbar.

Install the Python dependency with ``python -m pip install playwright``. Serve
the repository with ``python -m http.server 8000``, then run:

    python tests/plane-toolbar.playwright.py --base-url http://127.0.0.1:8000

CHROMIUM_EXECUTABLE overrides the browser path (default: /usr/bin/chromium).
The test injects access to the viewport into its intercepted app module; no
production debug API is required. Geometry injection covers deterministic axis
and endpoint selections, while surface methods use actual canvas clicks.
"""

import argparse
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


def run(base_url):
    app_path = Path(__file__).resolve().parents[1] / "app.js"
    app_source = app_path.read_text(encoding="utf-8") + "\nwindow.__workflowTest = { viewport };\n"
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=os.environ.get("CHROMIUM_EXECUTABLE", "/usr/bin/chromium"),
            headless=True,
            args=[
                "--no-sandbox",
                "--ignore-certificate-errors",
                "--use-angle=swiftshader",
                "--enable-unsafe-swiftshader",
            ],
        )
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.route(
                "**/app.js",
                lambda route: route.fulfill(
                    status=200, content_type="text/javascript", body=app_source
                ),
            )
            page.goto(base_url.rstrip("/") + "/", wait_until="networkidle")
            page.locator("#planeButton").click()

            def status():
                return page.locator("#smartToolbarStatus").text_content()

            def state():
                return page.evaluate("""() => {
                    const viewport = window.__workflowTest.viewport;
                    const preview = viewport.planePreview;
                    return {
                        references: viewport.selectionReferences.map(reference => reference.kind),
                        count: viewport.constructionPlanes.length,
                        preview: preview ? {
                            origin: preview.position.toArray(),
                            normal: new preview.position.constructor(0, 0, 1)
                                .applyQuaternion(preview.quaternion).toArray(),
                            space: preview.parent === viewport.constructionWorldGroup ? 'world' : 'model',
                        } : null,
                    };
                }""")

            def method_ids():
                return page.locator("#smartPlaneMethods [data-smart-method]").evaluate_all(
                    "buttons => buttons.map(button => button.dataset.smartMethod)"
                )

            def assert_methods(expected, excluded=()):
                actual = method_ids()
                assert set(expected).issubset(actual), (expected, actual, status())
                assert not set(excluded).intersection(actual), (excluded, actual, status())
                assert page.locator("#smartPlaneMethodRow").is_visible()

            def assert_empty():
                actual = state()
                assert actual["references"] == [] and not actual["preview"], actual
                assert page.locator("#smartPlaneMethodRow").is_hidden()
                assert page.locator("#smartPlaneParameters").is_hidden()
                assert page.locator("[data-smart-method]:visible").count() == 0
                assert page.locator("#smartPlaneToolbar").get_attribute("data-method") == ""
                assert page.locator("#smartPlaneChangeMethod").is_hidden()
                assert page.locator("#smartPlaneAdvancedToggle").is_hidden()
                assert method_ids() == []
                assert page.locator("#smartPlaneSave").is_disabled()
                assert page.evaluate("window.__workflowTest.viewport.smartPickIntent") is None

            def choose_method(method):
                assert method in method_ids(), (method, method_ids(), status())
                if page.locator("#smartPlaneMethodRow").is_hidden():
                    page.locator("#smartPlaneChangeMethod").click()
                page.locator(f'[data-smart-method="{method}"]').click()
                assert page.locator("#smartPlaneToolbar").get_attribute("data-method") == method
                assert page.locator("#smartPlaneMethodRow").is_hidden()
                assert page.locator("[data-smart-method]:visible").count() == 0
                assert page.locator("#smartPlaneAdvanced").is_hidden()
                assert page.locator("#smartPlaneChangeMethod").is_visible() == (len(method_ids()) > 1)

            def pick_filter(value):
                if page.locator("#smartPickOptions").is_hidden():
                    page.locator("#smartPickOptionsToggle").click()
                page.locator("#smartPickFilter").select_option(value)

            def set_offset(value):
                if page.locator("#smartPlaneOffset").is_hidden():
                    page.locator("#smartPlaneAdvancedToggle").click()
                page.locator("#smartPlaneOffset").fill(value)

            def add_points(points):
                for point in points:
                    page.evaluate("""point => {
                        const viewport = window.__workflowTest.viewport;
                        viewport.addConstructionReference({
                            kind: 'point', point: new viewport.camera.position.constructor(...point),
                            normal: null, source: 'test-point',
                        });
                    }""", point)

            def add_edge(first=(0, 0, 0), second=(2, 0, 0)):
                page.evaluate("""endpoints => {
                    const viewport = window.__workflowTest.viewport;
                    const Vector = viewport.camera.position.constructor;
                    const edge = endpoints.map(point => new Vector(...point));
                    viewport.addConstructionReference({
                        kind: 'edge', point: edge[0].clone().add(edge[1]).multiplyScalar(0.5),
                        edge, source: 'test-edge',
                    });
                }""", [first, second])

            def add_plane(plane_id):
                pick_filter("plane")
                page.locator("#smartReferencePlane").select_option(plane_id)
                page.locator("#smartAddReference").click()

            def assert_ready():
                assert state()["preview"] and page.locator("#smartPlaneSave").is_enabled(), status()

            def save(name):
                before = state()
                assert_ready()
                if page.locator("#smartPlaneName").is_hidden():
                    page.locator("#smartPlaneAdvancedToggle").click()
                page.locator("#smartPlaneName").fill(name)
                page.locator("#smartPlaneSave").click()
                actual = page.evaluate("""() => {
                    const plane = window.__workflowTest.viewport.constructionPlanes.at(-1);
                    return { id: plane.id, origin: plane.origin.toArray(), normal: plane.normal.toArray(),
                        space: plane.space, name: plane.name };
                }""")
                for field in ["origin", "normal"]:
                    assert all(
                        abs(saved - preview) < 1e-9
                        for saved, preview in zip(actual[field], before["preview"][field])
                    ), (before, actual)
                assert actual["space"] == before["preview"]["space"]
                assert actual["name"] == name
                assert state()["count"] == before["count"] + 1
                assert_empty()
                return actual

            assert_empty()
            assert not page.locator(".view-navigation").is_visible()
            page.locator('[data-plane-mode="manual"]').click()
            assert page.locator('[data-plane-mode-panel="manual"] [data-plane-method]:visible').count() == 10
            page.locator('[data-plane-mode="pick"]').click()
            assert_empty()
            print("PASS empty Pick mode hides methods and parameters; Manual keeps all ten methods", flush=True)

            # A lone point does not expose unrelated construction choices. The
            # second point makes path and reference-plane constructions relevant.
            page.locator("#smartPickOptionsToggle").click()
            page.locator("#smartModelCenter").click()
            assert method_ids() == ["local-best-fit"], method_ids()
            page.locator("#smartPlaneClear").click()
            assert_empty()
            add_points([(0, 0, 0)])
            assert "angle" not in method_ids()
            add_points([(2, 0, 0)])
            assert_methods(["along-path", "angle", "perpendicular"], ["three-points", "two-edges"])
            assert page.locator("#smartPlaneToolbar").get_attribute("data-method") == ""
            assert not state()["preview"]
            choose_method("angle")
            assert page.locator("#smartAngleField").is_visible()
            assert page.locator("#smartMethodReferenceAField").is_visible()
            page.locator("#smartMethodReferenceA").select_option("saved:world-xy")
            page.locator("#smartPlaneAngle").fill("37")
            assert_ready()
            page.locator("#smartPlaneUndo").click()
            assert not state()["preview"]
            assert page.locator("#smartPlaneToolbar").get_attribute("data-method") == "angle"
            assert page.locator("#smartPlaneAngle").input_value() == "37"
            add_points([(2, 0, 0)])
            assert_ready()
            before_reference = state()["preview"]
            page.locator("#smartMethodReferenceA").select_option("saved:world-xz")
            assert_ready()
            assert state()["preview"] != before_reference
            for invalid in ["", "1e309"]:
                page.locator("#smartPlaneAngle").fill(invalid)
                assert not state()["preview"]
                assert page.locator("#smartPlaneSave").is_disabled()
            page.locator("#smartPlaneAngle").fill("45")
            save("Angle from toolbar")
            print("PASS two-point Angle suggestions, partial Undo, reference edits, invalid angle and preview/save parity", flush=True)

            add_edge()
            assert_methods(["along-path", "angle", "perpendicular"], ["three-points", "two-edges"])
            assert not state()["preview"]
            choose_method("angle")
            assert_ready()
            assert state()["references"] == ["edge"]
            page.locator("#smartPlaneUndo").click()
            assert_empty()
            add_edge()
            assert page.locator("#smartPlaneToolbar").get_attribute("data-method") == ""
            choose_method("angle")
            save("Edge angle")
            print("PASS edge-first Angle and Undo-to-zero clears explicit method intent", flush=True)

            add_points([(0, 0, 0), (2, 0, 0), (0, 3, 0)])
            assert_methods(["three-points", "best-fit"], ["angle", "along-path", "two-edges"])
            choose_method("three-points")
            save("Three picked points")
            add_points([(0, 0, 0), (2, 0, 0), (0, 3, 0)])
            choose_method("best-fit")
            add_points([(1, 1, 0.2)])
            assert page.locator("#smartPlaneToolbar").get_attribute("data-method") == "best-fit"
            save("Best fit samples")
            add_edge()
            add_edge((0, 3, 0), (2, 3, 0))
            assert_methods(["two-edges", "best-fit"], ["angle", "along-path", "three-points"])
            choose_method("two-edges")
            save("Two picked edges")
            add_points([(0, 0, 0), (2, 0, 0), (0, 3, 0), (2, 3, 0)])
            choose_method("two-edges")
            save("Four edge endpoints")
            print("PASS progressive 3 Points, accumulating Best Fit, two real edges and four endpoints", flush=True)

            for geometry in ["points", "edge"]:
                if geometry == "points":
                    add_points([(0, 0, 0), (2, 0, 0)])
                else:
                    add_edge()
                choose_method("along-path")
                set_offset("0")
                for invalid in ["-1", "101", "1e309"]:
                    page.locator("#smartPathPosition").fill(invalid)
                    assert not state()["preview"]
                    assert page.locator("#smartPlaneSave").is_disabled()
                page.locator("#smartPathPosition").fill("25")
                if page.locator("#smartReversePath").get_attribute("aria-pressed") == "true":
                    page.locator("#smartReversePath").click()
                assert_ready()
                assert abs(state()["preview"]["origin"][0] - 0.5) < 1e-9
                page.locator("#smartReversePath").click()
                assert_ready()
                assert abs(state()["preview"]["origin"][0] - 1.5) < 1e-9
                save("Path from " + geometry)
            add_points([(0, 0, 0), (2, 0, 0)])
            choose_method("perpendicular")
            page.locator("#smartMethodReferenceA").select_option("saved:world-xy")
            save("Perpendicular from picked line")
            print("PASS path parameters/reversal/validation for points and edge; Perpendicular reference", flush=True)

            # Picking a surface offers only relevant constructions, including a
            # Midplane workflow whose second reference is chosen in the toolbar.
            pick_filter("surface")
            for method in ["planar-surface", "tangent"]:
                page.mouse.click(720, 350)
                assert_methods(["planar-surface", "tangent", "offset", "midplane"], ["angle", "three-points", "two-edges"])
                assert state()["references"] == ["surface"]
                assert not state()["preview"]
                choose_method(method)
                save(method)
            print("PASS surface-first contextual Planar Surface/Tangent/Offset/Midplane choices", flush=True)

            add_plane("world-xy")
            assert_methods(["offset", "midplane"], ["angle", "tangent", "along-path"])
            assert not state()["preview"]
            choose_method("offset")
            page.locator("#smartMethodReferenceA").select_option("saved:world-xy")
            set_offset("5")
            assert_ready()
            assert abs(state()["preview"]["origin"][2] - 5) < 1e-9
            offset_plane = save("Offset from world")
            assert offset_plane["space"] == "world"
            # Saving hides all method fields, including Name, until another pick.
            assert page.locator("#smartPlaneName").is_hidden()
            add_plane("world-xy")
            choose_method("midplane")
            page.locator("#smartMethodReferenceA").select_option("saved:world-xy")
            page.locator("#smartMethodReferenceB").select_option("saved:" + offset_plane["id"])
            set_offset("0")
            assert_ready()
            assert abs(state()["preview"]["origin"][2] - 2.5) < 1e-9
            page.locator("#smartMethodReferenceB").select_option("saved:world-yz")
            assert not state()["preview"]
            assert page.locator("#smartPlaneSave").is_disabled()
            page.locator("#smartMethodReferenceB").select_option("saved:" + offset_plane["id"])
            midpoint = save("World midpoint")
            assert midpoint["space"] == "world"
            print("PASS picked-plane Offset/Midplane with editable references, nonparallel rejection and world ownership", flush=True)

            # Missing picked references return the tool to its empty state. A
            # missing chosen reference with other picks retained blocks saving
            # and requires an explicit replacement instead of silently changing.
            add_plane(offset_plane["id"])
            choose_method("offset")
            assert_ready()
            page.get_by_role("button", name="Delete Offset from world", exact=True).click()
            assert_empty()
            assert not errors, errors
            add_plane("world-xy")
            choose_method("offset")
            page.locator("#smartMethodReferenceA").select_option("saved:" + midpoint["id"])
            assert_ready()
            page.get_by_role("button", name="Delete World midpoint", exact=True).click()
            assert state()["references"] == ["plane"]
            assert page.locator("#smartMethodReferenceA").input_value() == ""
            assert not state()["preview"]
            assert page.locator("#smartPlaneSave").is_disabled()
            page.locator("#smartMethodReferenceA").select_option("saved:world-xy")
            assert_ready()
            print("PASS deleting picked/chosen references clears stale preview and requires valid replacement", flush=True)

            cloud_points = [f"{x} {y} 0" for x in range(-3, 4) for y in range(-3, 4)]
            ply = (
                "ply\nformat ascii 1.0\nelement vertex 49\n"
                "property float x\nproperty float y\nproperty float z\nend_header\n"
                + "\n".join(cloud_points) + "\n"
            )
            page.locator("#fileInput").set_input_files({
                "name": "workflow-grid.ply", "mimeType": "application/octet-stream", "buffer": ply.encode(),
            })
            page.wait_for_function('document.querySelector("#modelName").textContent === "workflow-grid.ply"')
            assert_empty()
            assert state()["count"] == 0
            cloud_click = page.evaluate("""() => {
                const viewport = window.__workflowTest.viewport;
                const center = new viewport.camera.position.constructor(0, 0, 0)
                    .applyMatrix4(viewport.modelRoot.matrixWorld).project(viewport.camera);
                const rect = viewport.canvas.getBoundingClientRect();
                return { x: rect.left + (center.x + 1) * rect.width / 2,
                    y: rect.top + (1 - center.y) * rect.height / 2 };
            }""")
            pick_filter("surface")
            page.mouse.click(cloud_click["x"], cloud_click["y"])
            assert state()["references"] == ["surface"]
            assert_methods(["planar-surface", "local-best-fit", "offset", "midplane"], ["tangent", "angle"])
            choose_method("local-best-fit")
            save("Point-cloud local fit")
            print("PASS model replacement empties contextual state; cloud offers fitting and hides unsupported Tangent", flush=True)

            # The only chooser is the visible card group. Changing a method
            # retains its values until another card is selected, and Escape
            # returns to the editor instead of closing the entire tool.
            add_edge()
            choose_method("angle")
            assert page.locator("#smartPlaneMethod").count() == 0
            assert page.locator("#smartMethodReferenceA").evaluate("e => e === document.activeElement")
            page.locator("#smartPlaneAngle").fill("31")
            page.locator("#smartPlaneChangeMethod").click()
            assert_methods(["along-path", "angle", "perpendicular"])
            assert page.locator("#smartPlaneParameters").is_hidden()
            assert page.locator("#smartPlaneSave").is_hidden()
            assert page.locator("#createPlaneButton").is_disabled()
            assert page.locator('[data-smart-method="angle"]').evaluate("e => e === document.activeElement")
            page.keyboard.press("Escape")
            assert page.locator("#planeWorkbench").is_visible()
            assert page.locator("#smartPlaneMethodRow").is_hidden()
            assert page.locator("#smartPlaneAngle").input_value() == "31"
            assert_ready()
            page.locator("#smartPlaneAdvancedToggle").click()
            assert page.locator("#smartPlaneName").is_visible()
            page.keyboard.press("Escape")
            assert page.locator("#smartPlaneAdvanced").is_hidden()
            assert page.locator("#planeWorkbench").is_visible()
            choose_method("along-path")
            assert page.locator("#smartAngleField").is_hidden()
            assert page.locator("#smartMethodReferenceAField").is_hidden()
            assert page.locator("#smartPathField").is_visible()
            page.locator("#smartPlaneClear").click()
            assert_empty()
            assert page.locator("#smartPickOptionsToggle").evaluate("e => e === document.activeElement")
            page.keyboard.press("Escape")
            assert page.locator(".view-navigation").is_visible()
            assert not state()["preview"]
            print("PASS focused method editor, Change/Back/Escape, optional settings, keyboard focus and Clear", flush=True)

            result = page.evaluate("""async () =>
                (await import('./tests/smart-plane.browser.js')).runSmartPlaneTests()
            """)
            assert not errors, errors
            print("PASS geometry checks:", result["passed"], flush=True)

            # Exercise real touch picks and visible controls at narrow widths,
            # including a tablet whose inspector reduces toolbar space.
            page.close()
            for width, height in [(390, 844), (844, 390), (768, 1024)]:
                touch_page = browser.new_page(viewport={"width": width, "height": height}, has_touch=True)
                touch_page.on("pageerror", lambda error: errors.append(str(error)))
                touch_page.route("**/app.js", lambda route: route.fulfill(
                    status=200, content_type="text/javascript", body=app_source,
                ))
                touch_page.goto(base_url.rstrip("/") + "/", wait_until="networkidle")
                touch_page.locator("#planeButton").tap()
                if touch_page.locator("#mobilePanelToggle").is_visible():
                    touch_page.locator("#mobilePanelToggle").tap()
                touch_page.locator("#smartPickOptionsToggle").tap()
                touch_page.locator("#smartPickFilter").select_option("point")
                assert touch_page.locator("#smartPickOptions").is_hidden()
                if width == 768:
                    taps = touch_page.evaluate("""() => {
                        const viewport = window.__workflowTest.viewport;
                        const bounds = viewport.getLocalBoundsInfo();
                        const rect = viewport.canvas.getBoundingClientRect();
                        return [-0.2, 0.2].map(fraction => {
                            const point = bounds.center.clone();
                            point.x += bounds.size.x * fraction;
                            point.z = bounds.max.z;
                            point.applyMatrix4(viewport.modelRoot.matrixWorld).project(viewport.camera);
                            return [rect.left + (point.x + 1) * rect.width / 2,
                                rect.top + (1 - point.y) * rect.height / 2];
                        });
                    }""")
                else:
                    taps = [(170, 280), (230, 300)] if width == 390 else [(390, 145), (470, 170)]
                for x, y in taps:
                    touch_page.touchscreen.tap(x, y)
                touch_page.locator('[data-smart-method="angle"]').tap()
                assert touch_page.locator("[data-smart-method]:visible").count() == 0
                touch_page.locator("#smartMethodReferenceA").select_option("saved:world-xy")
                touch_page.locator("#smartPlaneAngle").fill("33")
                for selector in ["#smartPlaneAngle", "#smartMethodReferenceA", "#smartPlaneSave", "#smartPlaneChangeMethod"]:
                    rect = touch_page.locator(selector).bounding_box()
                    assert rect["x"] >= 0 and rect["x"] + rect["width"] <= width + 1, (width, selector, rect)
                assert touch_page.locator(".view-toolbar").evaluate("e => e.scrollWidth <= e.clientWidth + 1")
                touch_page.locator("#smartPlaneAdvancedToggle").tap()
                touch_page.locator("#smartPlaneName").fill("Touch plane")
                touch_page.locator("#smartPlaneSave").tap()
                assert touch_page.evaluate("window.__workflowTest.viewport.constructionPlanes.at(-1).name") == "Touch plane"
                assert touch_page.locator("#smartPlaneMethodRow").is_hidden()
                assert touch_page.locator("#smartPlaneParameters").is_hidden()
                assert touch_page.evaluate("window.__workflowTest.viewport.planePreview") is None
                assert not errors, errors
                print("PASS responsive touch controls and save:", width, height, flush=True)
                touch_page.close()
        finally:
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    run(parser.parse_args().base_url)
