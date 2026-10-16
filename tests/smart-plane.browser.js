// Run with the application's import map: import this module and call runSmartPlaneTests().
import { Vector3 } from "three";
import { getPickedPlaneCandidates } from "../smart-plane.js";

export function runSmartPlaneTests() {
  let passed = 0;
  const point = (x, y, z = 0) => ({ kind: "point", point: new Vector3(x, y, z) });
  const edge = (a, b) => ({ kind: "edge", edge: [a.point, b.point] });
  const surface = (z = 0, normal = new Vector3(0, 0, 1)) => ({ kind: "surface", point: new Vector3(0, 0, z), normal });
  const reference = (z = 0, normal = new Vector3(0, 0, 1)) => ({ kind: "plane", point: new Vector3(0, 0, z),
    plane: { origin: new Vector3(0, 0, z), normal, xAxis: new Vector3(1, 0, 0) } });
  const fitCalls = [];
  // Fitting is injected. Check routing and complete sample sets here; the app's
  // fitting implementation is also exercised by the interactive browser checks.
  const options = {
    fitSurface: (reference) => {
      if (reference.curved) throw new Error("Not a flat surface.");
      return { origin: reference.point, normal: reference.normal || new Vector3(0, 0, 1) };
    },
    fitLocalPoints: (reference) => ({ origin: reference.point, normal: new Vector3(0, 0, 1) }),
    fitPoints: (samples) => {
      fitCalls.push(samples);
      return { origin: samples.reduce((sum, sample) => sum.add(sample), new Vector3()).multiplyScalar(1 / samples.length), normal: new Vector3(0, 0, 1) };
    },
  };
  function assert(condition, message) { if (!condition) throw new Error(message); }
  function near(actual, expected, message) { assert(Math.abs(actual - expected) < 1e-10, message); }
  function candidate(references, id, configuration = options) {
    const found = getPickedPlaneCandidates(references, configuration).candidates.find((candidate) => candidate.id === id);
    assert(found, "Missing candidate: " + id);
    return found;
  }
  function valid(references, id, parameters) {
    const result = candidate(references, id);
    assert(!result.error, id + ": " + result.error);
    const plane = result.build(parameters);
    near(plane.normal.length(), 1, "Normal must be normalized");
    near(plane.xAxis.dot(plane.normal), 0, "Axes must be perpendicular");
    passed++;
    return plane;
  }
  function invalid(references, id) {
    assert(candidate(references, id).error, "Invalid geometry must disable " + id);
    passed++;
  }
  function rejects(build, message) {
    let rejected = false;
    try { build(); } catch { rejected = true; }
    assert(rejected, message); passed++;
  }
  const a = point(0, 0), b = point(2, 0), c = point(0, 3), d = point(2, 3);
  for (const references of [[a, b, c], [point(0, 0), point(1e-7, 0), point(0, 1e-7)]]) {
    const plane = valid(references, "three-points");
    assert(references.every((sample) => Math.abs(sample.point.clone().sub(plane.origin).dot(plane.normal)) < 1e-12), "Exact plane must contain every point");
  }
  valid([edge(a, b), c], "edge-point");
  valid([c, edge(a, b)], "edge-point");
  valid([edge(a, b), edge(c, d)], "two-edges");
  valid([edge(a, b), edge(a, c)], "two-edges");
  valid([a, b, c, d], "two-edges");
  invalid([edge(a, b), edge(point(0, 0, 1), point(0, 1, 1))], "two-edges");
  invalid([a, b, point(3, 0)], "three-points");
  invalid([edge(a, a), c], "edge-point");
  invalid([edge(a, b), edge(a, point(3, 0))], "two-edges");
  invalid([edge(a, b), edge(c, c)], "two-edges");

  valid([a, b, c], "best-fit");
  const many = Array.from({ length: 12 }, (_, index) => point(index, index % 3, index % 2));
  valid(many, "best-fit");
  assert(fitCalls.at(-1).length === 12, "Best Fit must receive every selected point"); passed++;
  valid([edge(a, b), edge(c, d)], "best-fit");
  assert(fitCalls.at(-1).length === 4, "Best Fit must include both endpoints of every edge"); passed++;

  const path = valid([a, b], "along-path", { pathPosition: 25 });
  near(path.origin.x, 0.5, "Path position must interpolate the endpoints");
  near(Math.abs(path.normal.x), 1, "Path plane must be normal to the line");
  near(valid([edge(a, b)], "along-path", { pathPosition: 100 }).origin.x, 2, "Edge path endpoint");
  near(valid([b, a], "along-path", { pathPosition: 25 }).origin.x, 1.5, "Path direction follows pick order");
  invalid([edge(a, a)], "along-path");
  for (const value of [-1, 101, NaN, Infinity]) {
    rejects(() => candidate([a, b], "along-path").build({ pathPosition: value }), "Invalid path position must be rejected");
  }

  valid([surface()], "planar-surface");
  valid([surface()], "tangent");
  valid([surface()], "local-best-fit");
  valid([surface()], "offset");
  valid([reference()], "offset");
  const savedReference = reference();
  savedReference.plane.id = "plane-7";
  savedReference.plane.visible = false;
  const independent = valid([savedReference], "offset");
  assert(!("id" in independent) && !("visible" in independent), "New planes must not inherit a reference's identity or visibility"); passed++;
  const cloud = { ...surface(), normal: null };
  assert(!getPickedPlaneCandidates([cloud], options).candidates.some((candidate) => candidate.id === "tangent"), "Point clouds have no tangent normal"); passed++;
  const curved = { ...surface(), curved: true };
  invalid([curved], "planar-surface");
  invalid([curved], "offset");
  valid([curved], "tangent");
  valid([curved], "local-best-fit");

  for (const references of [[surface(0), surface(8)], [surface(0), surface(8, new Vector3(0, 0, -1))], [reference(0), reference(8)], [surface(0), reference(8)]]) {
    const plane = valid(references, "midplane");
    near(plane.origin.z, 4, "Midplane must bisect the signed separation, including opposite normals");
  }
  invalid([reference(0), reference(3, new Vector3(1, 0, 0))], "midplane");
  invalid([surface(0), surface(0)], "midplane");
  invalid([curved, surface(8)], "midplane");
  const reversed = valid([reference(8, new Vector3(0, 0, -1)), reference(0)], "midplane");
  near(reversed.origin.z, 4, "Midplane must not depend on reference order");

  for (const references of [[surface(), edge(a, b)], [edge(a, b), surface()], [reference(), a, b], [a, reference(), b]]) {
    const angled = valid(references, "angle", { angle: 90 });
    near(angled.normal.dot(new Vector3(0, 0, 1)), 0, "90 degree plane must be perpendicular to reference");
    const perpendicular = valid(references, "perpendicular");
    near(perpendicular.normal.dot(new Vector3(0, 0, 1)), 0, "Perpendicular plane must be normal to reference");
    near(perpendicular.normal.dot(b.point.clone().sub(a.point)), 0, "Perpendicular plane must contain line");
  }
  const rotation = valid([reference(), a, b], "angle", { angle: -45 });
  near(rotation.normal.z, Math.SQRT1_2, "Signed angle must rotate the reference normal");
  rejects(() => candidate([reference(), a, b], "angle").build({ angle: NaN }), "Nonfinite angle must be rejected");
  const normalEdge = edge(a, point(0, 0, 2));
  invalid([reference(), normalEdge], "angle");
  invalid([reference(), normalEdge], "perpendicular");
  invalid([reference(), edge(a, a)], "angle");
  invalid([reference(), edge(a, a)], "perpendicular");

  for (const references of [[], [a], [reference(), a], [surface(), surface(2), edge(a, b)]]) {
    assert(!getPickedPlaneCandidates(references, options).candidates.length, "Incomplete or unsupported references must not be ignored"); passed++;
  }
  const ids = new Set([
    [surface()], [a, b, c], [a, b, c, d], [a, b], [reference()], [reference(), edge(a, b)], [reference(), reference(8)],
  ].flatMap((references) => getPickedPlaneCandidates(references, options).candidates.map((candidate) => candidate.id)));
  for (const id of ["planar-surface", "three-points", "best-fit", "tangent", "two-edges", "along-path", "offset", "angle", "midplane", "perpendicular"]) {
    assert(ids.has(id), "Missing Manual method: " + id); passed++;
  }
  return { passed };
}
