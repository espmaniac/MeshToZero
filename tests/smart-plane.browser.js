// Run with the application's import map: import this module and call runSmartPlaneTests().
import { Vector3 } from "three";
import { inferPickedPlane } from "../smart-plane.js";

export function runSmartPlaneTests() {
  let passed = 0;
  const point = (x, y, z = 0) => ({ kind: "point", point: new Vector3(x, y, z) });
  const edge = (a, b) => ({ kind: "edge", edge: [a.point, b.point] });
  const options = {};
  function assert(condition, message) { if (!condition) throw new Error(message); }
  function rejects(references, message) {
    let rejected = false;
    try { inferPickedPlane(references, options); } catch { rejected = true; }
    assert(rejected, message); passed++;
  }
  function contains(references, samples, method) {
    const plane = inferPickedPlane(references, options);
    assert(plane.method === method, "Unexpected method: " + plane.method);
    assert(Math.abs(plane.normal.length() - 1) < 1e-10, "Normal must be unit length");
    assert(samples.every((p) => Math.abs(p.point.clone().sub(plane.origin).dot(plane.normal)) < 1e-10), "Plane must contain all references");
    passed++;
  }
  const a = point(0, 0), b = point(2, 0), c = point(0, 3), d = point(2, 3);
  contains([a, b, c], [a, b, c], "Through 3 Points");
  contains([point(0, 0), point(1e-7, 0), point(0, 1e-7)], [a], "Through 3 Points");
  contains([edge(a, b), c], [a, b, c], "Through Edge and Point");
  contains([c, edge(a, b)], [a, b, c], "Through Edge and Point");
  contains([edge(a, b), edge(c, d)], [a, b, c, d], "Through 2 Edges");
  contains([edge(a, b), edge(a, c)], [a, b, c], "Through 2 Edges");
  rejects([edge(a, b), edge(point(0, 0, 1), point(0, 1, 1))], "Skew edges must be rejected");
  rejects([a, b, point(3, 0)], "Collinear points must be rejected");
  rejects([edge(a, b)], "One edge is ambiguous");
  rejects([edge(a, a), c], "Zero-length edge must be rejected");
  rejects([edge(a, b), edge(a, point(3, 0))], "Coincident edges are ambiguous");
  rejects([a, b], "Two points are ambiguous");
  rejects([edge(a, b), c, d], "Unsupported mixed references must be rejected");
  const surface = { kind: "surface", point: c.point, normal: new Vector3(0, 0, 1) };
  const tangent = inferPickedPlane([surface], { surfaceMode: "tangent" });
  assert(tangent.normal.equals(surface.normal) && tangent.origin.equals(surface.point), "Tangent must use the picked surface normal and point"); passed++;
  let fallbackUsed = false;
  try { inferPickedPlane([surface], { fitSurface: () => { throw new Error("Not flat"); }, fitPoints: () => { fallbackUsed = true; } }); } catch {}
  assert(!fallbackUsed, "Nonplanar surfaces must not silently switch to best fit"); passed++;
  rejects([surface, a], "Surface and point picks must not be mixed");
  return { passed };
}
