#!/usr/bin/env python3
"""Check complete plane workflows in the contextual viewport toolbar.

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

            def choose_method(method):
                page.locator("#smartPlaneMethod").select_option(method)
                assert page.locator(f'[data-smart-method="{method}"]').get_attribute("aria-pressed") == "true"

            def add_points(points):
                for point in points:
                    page.evaluate("""point => {
                        const viewport = window.__workflowTest.viewport;
                        viewport.addConstructionReference({
                            kind: 'point', point: new viewport.camera.position.constructor(...point),
                            normal: null, source: 'test-point',
                        });
                    }""", point)

            def add_edge():
                page.evaluate("""() => {
                    const viewport = window.__workflowTest.viewport;
                    const Vector = viewport.camera.position.constructor;
                    viewport.addConstructionReference({
                        kind: 'edge', point: new Vector(1, 0, 0),
                        edge: [new Vector(0, 0, 0), new Vector(2, 0, 0)], source: 'test-edge',
                    });
                }""")

            def assert_ready():
                assert state()["preview"] and page.locator("#smartPlaneSave").is_enabled(), status()

            def save(name):
                before = state()
                assert_ready()
                page.locator("#smartPlaneName").fill(name)
                page.locator("#smartPlaneSave").click()
                actual = page.evaluate("""() => {
                    const plane = window.__workflowTest.viewport.constructionPlanes.at(-1);
                    return { origin: plane.origin.toArray(), normal: plane.normal.toArray(),
                        space: plane.space, name: plane.name };
                }""")
                for field in ["origin", "normal"]:
                    assert all(
                        abs(saved - preview) < 1e-9
                        for saved, preview in zip(actual[field], before["preview"][field])
                    ), (before, actual)
                assert actual["space"] == before["preview"]["space"]
                assert actual["name"] == name
                after = state()
                assert after["count"] == before["count"] + 1 and not after["preview"], after
                assert page.locator("#smartPlaneSave").is_disabled()
                return actual

            assert page.locator("[data-smart-method]").count() == 10
            assert page.locator("[data-smart-method]:disabled").count() == 0
            print("PASS all ten methods selectable before geometry", flush=True)

            # Method-first Angle must retain the method and inputs while the axis
            # is incomplete, after Undo, and when changing reference planes.
            choose_method("angle")
            assert page.locator("#smartAngleField").is_visible()
            assert page.locator("#smartMethodReferenceAField").is_visible()
            assert not state()["preview"]
            page.locator("#smartPlaneAngle").fill("37")
            add_points([(0, 0, 0)])
            assert page.locator("#smartPlaneMethod").input_value() == "angle"
            assert not state()["preview"]
            add_points([(2, 0, 0)])
            assert_ready()
            assert page.locator("#smartPlaneAngle").input_value() == "37"
            page.locator("#smartPlaneUndo").click()
            assert not state()["preview"]
            assert page.locator("#smartPlaneMethod").input_value() == "angle"
            add_points([(2, 0, 0)])
            assert_ready()
            page.locator("#smartMethodReferenceA").select_option("saved:world-xz")
            assert_ready()
            page.locator("#smartPlaneAngle").fill("1e309")
            assert not state()["preview"]
            assert page.locator("#smartPlaneSave").is_disabled()
            page.locator("#smartPlaneAngle").fill("45")
            assert_ready()
            save("Angle from toolbar")
            print("PASS method-first Angle, partial picks/Undo, reference edits, invalid angle, name and preview/save parity", flush=True)

            # The same workflow must also work with geometry picked first.
            page.locator("#closePlaneWorkbench").click()
            page.locator("#planeButton").click()
            add_edge()
            choose_method("angle")
            assert_ready()
            assert state()["references"] == ["edge"]
            save("Edge angle")
            print("PASS edge-first Angle without a picked plane", flush=True)

            for method, points in [
                ("three-points", [(0, 0, 0), (2, 0, 0), (0, 3, 0)]),
                ("best-fit", [(0, 0, 0), (2, 0, 0), (0, 3, 0), (1, 1, 0.2)]),
                ("two-edges", [(0, 0, 0), (2, 0, 0), (0, 3, 0), (2, 3, 0)]),
                ("along-path", [(0, 0, 0), (2, 0, 0)]),
                ("perpendicular", [(0, 0, 0), (2, 0, 0)]),
            ]:
                choose_method(method)
                assert not state()["preview"]
                add_points(points)
                assert_ready()
                if method == "along-path":
                    page.locator("#smartPathPosition").fill("25")
                    assert_ready()
                    assert abs(state()["preview"]["origin"][0] - 0.5) < 1e-9
                    page.locator("#smartReversePath").click()
                    assert_ready()
                    assert abs(state()["preview"]["origin"][0] - 1.5) < 1e-9
                save(method)
                print("PASS", method, "method-first and exact preview/save parity", flush=True)

            # Explicit surface methods should select a surface hit even near
            # model vertices, rather than switching to point/edge inference.
            for method in ["planar-surface", "tangent"]:
                choose_method(method)
                page.mouse.click(720, 350)
                assert_ready()
                assert state()["references"] == ["surface"]
                save(method)
                print("PASS", method, "method-first canvas surface selection", flush=True)

            choose_method("offset")
            assert_ready()
            page.locator("#smartMethodReferenceA").select_option("saved:world-xy")
            page.locator("#smartPlaneOffset").fill("5")
            assert_ready()
            assert abs(state()["preview"]["origin"][2] - 5) < 1e-9
            assert save("Offset from world")["space"] == "world"
            plane_id = page.evaluate("window.__workflowTest.viewport.constructionPlanes.at(-1).id")
            choose_method("midplane")
            page.locator("#smartMethodReferenceA").select_option("saved:world-xy")
            page.locator("#smartMethodReferenceB").select_option("saved:" + plane_id)
            assert_ready()
            assert abs(state()["preview"]["origin"][2] - 2.5) < 1e-9
            page.locator("#smartMethodReferenceB").select_option("saved:world-yz")
            assert not state()["preview"]
            assert page.locator("#smartPlaneSave").is_disabled()
            page.locator("#smartMethodReferenceB").select_option("saved:" + plane_id)
            assert_ready()
            assert save("World midpoint")["space"] == "world"
            print("PASS Offset/Midplane toolbar references, nonparallel rejection, world ownership and exact preview/save parity", flush=True)

            # Zero-pick constructions pause after saving. Editing only the name
            # must resume a new preview without needing a geometry selection.
            choose_method("offset")
            page.locator("#smartMethodReferenceA").select_option("saved:world-xy")
            assert state()["references"] == []
            assert_ready()
            save("First zero-pick offset")
            assert not state()["preview"]
            page.locator("#smartPlaneName").fill("Renamed zero-pick offset")
            assert_ready()
            save("Renamed zero-pick offset")
            print("PASS changing only Name resumes zero-pick Offset preview and saving", flush=True)

            # Deleting an active saved reference must remove its stale picked
            # wrapper and require an explicit replacement reference, rather than
            # silently switching to a different plane or throwing from the UI.
            active_id = page.evaluate("window.__workflowTest.viewport.constructionPlanes.at(-1).id")
            page.locator("#smartPickFilter").select_option("plane")
            page.locator("#smartReferencePlane").select_option(active_id)
            page.locator("#smartAddReference").click()
            page.locator("#smartMethodReferenceA").select_option("saved:" + active_id)
            assert state()["references"] == ["plane"]
            assert_ready()
            page.get_by_role("button", name="Delete Renamed zero-pick offset", exact=True).click()
            assert not errors, errors
            assert state()["references"] == []
            assert page.locator("#smartMethodReferenceA").input_value() == ""
            assert not state()["preview"]
            assert page.locator("#smartPlaneSave").is_disabled()
            page.locator("#smartMethodReferenceA").select_option("saved:world-xy")
            assert_ready()
            print("PASS deleting active saved plane prunes picked references and requires an explicit replacement", flush=True)

            # Replacing the model resets the construction session while keeping
            # all ten base methods available. A point cloud has no tangent
            # normal; Local Best Fit remains an explicit alternative.
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
            assert page.locator("[data-smart-method]").count() == 10
            assert page.locator("[data-smart-method]:disabled").count() == 0
            assert page.locator("#smartPlaneMethod").input_value() == ""
            assert state()["references"] == [] and state()["count"] == 0
            assert not state()["preview"]
            assert page.locator("#smartPlaneSave").is_disabled()
            page.locator("#smartPickFilter").select_option("auto")
            choose_method("tangent")
            cloud_click = page.evaluate("""() => {
                const viewport = window.__workflowTest.viewport;
                const center = new viewport.camera.position.constructor(0, 0, 0)
                    .applyMatrix4(viewport.modelRoot.matrixWorld).project(viewport.camera);
                const rect = viewport.canvas.getBoundingClientRect();
                return { x: rect.left + (center.x + 1) * rect.width / 2,
                    y: rect.top + (1 - center.y) * rect.height / 2 };
            }""")
            page.mouse.click(cloud_click["x"], cloud_click["y"])
            assert state()["references"] == ["surface"]
            assert page.locator("#smartPlaneMethod").input_value() == "tangent"
            assert not state()["preview"]
            assert page.locator("#smartPlaneSave").is_disabled()
            assert "tangent normal" in status(), status()
            choose_method("local-best-fit")
            assert_ready()
            save("Point-cloud local fit")
            print("PASS model replacement resets tool state; point-cloud Tangent is rejected and Local Best Fit saves", flush=True)

            # Choosing the empty method option returns to geometry inference.
            choose_method("angle")
            page.locator("#smartPlaneMethod").select_option("")
            add_edge()
            assert page.locator("#smartPlaneMethod").input_value() == "along-path"
            assert page.locator("#smartReversePath").is_visible()
            assert_ready()
            print("PASS clearing the explicit method restores edge-based Along Path inference", flush=True)

            result = page.evaluate("""async () =>
                (await import('./tests/smart-plane.browser.js')).runSmartPlaneTests()
            """)
            assert not errors, errors
            print("PASS geometry checks:", result["passed"], flush=True)
        finally:
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    run(parser.parse_args().base_url)
