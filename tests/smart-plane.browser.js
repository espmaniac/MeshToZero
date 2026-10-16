// Run with the application's import map: import this module and call runSmartPlaneTests().
import { Vector3 } from "three";
import { getPickedPlaneCandidates, getPickedPlaneSpace, getPlaneConstructionWorkflows } from "../smart-plane.js";

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
  valid([edge(a, b), c, d], "two-edges");
  valid([c, edge(a, b), d], "two-edges");
  invalid([edge(a, b), point(0, 0, 1), point(0, 1, 1)], "two-edges");
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
  const reverse = valid([edge(a, b)], "along-path", { pathPosition: 25, reversePath: true });
  near(reverse.origin.x, 1.5, "Reversing a feature edge must swap the start and end");
  near(reverse.normal.x, -1, "Reversing a path must reverse its directed normal");
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
  near(valid([surface(0), surface(0)], "midplane").origin.z, 0, "Coincident distinct references share their midplane, as in Manual");
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
  const axialRotation = valid([reference(), normalEdge], "angle", { angle: 45 });
  near(axialRotation.normal.z, 1, "Rotating about the plane normal must preserve the plane normal, as in Manual");
  near(axialRotation.angleToReference, 0, "Report actual inclination separately from axis rotation");
  const oblique = valid([reference(), edge(a, point(2, 2, 2))], "angle", { angle: 45 });
  near(oblique.angleToReference, Math.acos((1 + 2 * Math.SQRT1_2) / 3) * 180 / Math.PI, "Oblique rotation must preserve Manual's arbitrary-axis behavior");
  invalid([reference(), normalEdge], "perpendicular");
  invalid([reference(), edge(a, a)], "angle");
  invalid([reference(), edge(a, a)], "perpendicular");

  const through = point(4, 5, 7);
  for (const references of [[reference(), through], [through, surface()]]) {
    const plane = valid(references, "offset-point");
    near(through.point.clone().sub(plane.origin).dot(plane.normal), 0, "Parallel through Point must contain the selected point");
    near(Math.abs(plane.normal.z), 1, "Parallel through Point must retain the reference orientation");
  }
  for (const references of [[], [a], [surface(), surface(2), edge(a, b)]]) {
    assert(!getPickedPlaneCandidates(references, options).candidates.length, "Incomplete or unsupported references must not be ignored"); passed++;
  }
  const ids = new Set([
    [surface()], [a, b, c], [a, b, c, d], [a, b], [reference()], [reference(), edge(a, b)], [reference(), reference(8)],
  ].flatMap((references) => getPickedPlaneCandidates(references, options).candidates.map((candidate) => candidate.id)));
  for (const id of ["planar-surface", "three-points", "best-fit", "tangent", "two-edges", "along-path", "offset", "angle", "midplane", "perpendicular"]) {
    assert(ids.has(id), "Missing Manual method: " + id); passed++;
  }
  const world = { ...reference(), sourceSpace: "world" };
  const model = { ...reference(), sourceSpace: "model" };
  for (const method of ["offset", "offset-point", "angle", "perpendicular"]) {
    assert(getPickedPlaneSpace(method, [world]) === "world", method + " must retain world reference ownership and distance units"); passed++;
    assert(getPickedPlaneSpace(method, [model]) === "model", method + " must retain model reference ownership and distance units"); passed++;
  }
  for (const [references, expected] of [[[world, world], "world"], [[world, model], "world"], [[model, world], "world"], [[model, model], "model"], [[surface(), surface()], "model"]]) {
    assert(getPickedPlaneSpace("midplane", references) === expected, "Midplane must preserve shared space or use world space for mixed references"); passed++;
  }
  for (const method of ["three-points", "two-edges", "along-path", "tangent", "best-fit"]) {
    assert(getPickedPlaneSpace(method, [a, b, c]) === "model", method + " must follow the model"); passed++;
  }

  // A workflow can be selected while references are still missing. It exposes
  // the same editable fields as Manual rather than waiting for an inferred,
  // already complete reference combination.
  function workflow(references, id) {
    const found = getPlaneConstructionWorkflows(references, options).workflows.find((workflow) => workflow.id === id);
    assert(found, "Missing construction workflow: " + id);
    return found;
  }
  function workflowValid(references, id, parameters = {}) {
    const plane = workflow(references, id).build(parameters);
    near(plane.normal.length(), 1, "Workflow normal must be normalized");
    near(plane.xAxis.dot(plane.normal), 0, "Workflow axes must be perpendicular");
    passed++;
    return plane;
  }
  for (const id of ["planar-surface", "three-points", "best-fit", "tangent", "two-edges", "along-path", "offset", "angle", "midplane", "perpendicular"]) {
    assert(workflow([], id).error, "Incomplete " + id + " must remain available with a helpful build error"); passed++;
  }
  for (const [id, parameters] of [["offset", ["referenceA", "offset"]], ["angle", ["referenceA", "angle"]], ["midplane", ["referenceA", "referenceB"]], ["perpendicular", ["referenceA"]], ["along-path", ["pathPosition"]]]) {
    assert(parameters.every((parameter) => workflow([], id).parameters.includes(parameter)), "Expose all Manual parameters for " + id); passed++;
  }

  const referenceA = reference(2).plane, referenceB = reference(8).plane;
  near(workflowValid([], "offset", { referenceA, offset: 3 }).origin.z, 5, "Offset can start without model picks");
  near(referenceA.origin.z, 2, "Offset must not mutate its chosen reference"); passed++;
  near(workflowValid([], "midplane", { referenceA, referenceB }).origin.z, 5, "Midplane can start with two toolbar reference planes");
  near(workflowValid([surface(2)], "midplane", { referenceB }).origin.z, 5, "One picked surface can pair with toolbar reference B");
  near(workflowValid([reference(2), surface(8)], "midplane").origin.z, 5, "Midplane can still use two picked references");
  near(workflowValid([surface(0)], "offset", { referenceA, offset: -1 }).origin.z, 1, "Explicit toolbar reference overrides picked fallback");
  for (const offset of [NaN, Infinity, -Infinity]) {
    rejects(() => workflow([], "offset").build({ referenceA, offset }), "Nonfinite workflow offset must be rejected");
  }
  rejects(() => workflow([], "midplane").build({ referenceA }), "Midplane cannot silently duplicate missing reference B");
  rejects(() => workflow([], "midplane").build({ referenceA, referenceB: reference(0, new Vector3(1, 0, 0)).plane }), "Nonparallel toolbar references cannot form a midplane");

  for (const references of [[edge(a, b)], [a, b]]) {
    const angled = workflowValid(references, "angle", { referenceA, angle: 90 });
    near(Math.abs(angled.normal.y), 1, "Axis-only At Angle uses its selected toolbar reference");
    near(angled.origin.z, 0, "At Angle origin lies on the selected model axis");
    const perpendicular = workflowValid(references, "perpendicular", { referenceA });
    near(Math.abs(perpendicular.normal.y), 1, "Axis-only Perpendicular uses its selected toolbar reference");
  }
  workflowValid([surface(), edge(a, b)], "angle", { angle: 30 });
  workflowValid([reference(), a, b], "angle", { angle: 30 });
  workflowValid([surface(), edge(a, b)], "perpendicular");
  const explicitSurfaceAxis = workflowValid([surface(0), surface(2)], "angle", { referenceA, angle: 45 });
  near(explicitSurfaceAxis.angleToReference, 0, "Explicit reference permits deliberate surface points as an axis");
  const axisRotation = workflowValid([edge(a, point(2, 2, 2))], "angle", { referenceA, angle: 45 });
  near(axisRotation.angleToReference, oblique.angleToReference, "Workflow keeps arbitrary-axis rotation and actual inclination");
  rejects(() => workflow([edge(a, b)], "angle").build({ referenceA, angle: NaN }), "Workflow validates angle input");
  rejects(() => workflow([normalEdge], "perpendicular").build({ referenceA }), "Normal axis cannot define a unique perpendicular workflow plane");
  rejects(() => workflow([surface(), a], "angle").build(), "Fallback surface cannot silently serve as its own axis endpoint");

  for (const references of [[a, b, c], [surface(), b, c], [reference(7), a, b, c]]) {
    const plane = workflowValid(references, "three-points");
    near(plane.origin.z, 0, "Saved plane origins never become point-method samples");
  }
  rejects(() => workflow([a, b, c, d], "three-points").build(), "3 Points cannot silently discard a fourth point");
  rejects(() => workflow([a, b, point(3, 0)], "three-points").build(), "Workflow rejects collinear point geometry");
  for (const references of [[edge(a, b), edge(c, d)], [c, edge(a, b), d], [a, b, c, d], [surface(), b, c, d]]) {
    const plane = workflowValid(references, "two-edges");
    near(plane.origin.y, 1.5, "2 Edges includes all ordered endpoints");
  }
  near(workflowValid([c, edge(a, b), d], "two-edges").xAxis.x, 1, "A feature edge retains its axis when its other endpoints are interleaved");
  rejects(() => workflow([edge(a, b), edge(point(0, 0, 1), point(0, 1, 1))], "two-edges").build(), "Workflow rejects skew edges");
  rejects(() => workflow([edge(a, b), edge(c, c)], "two-edges").build(), "Workflow rejects zero-length second edge");
  workflowValid([edge(a, b), c], "edge-point");
  workflowValid([edge(a, b), surface(2)], "edge-point");

  const workflowPath = workflowValid([edge(a, b)], "along-path", { pathPosition: 25, reversePath: true });
  near(workflowPath.origin.x, 1.5, "Workflow reverses directed feature-edge path");
  near(workflowPath.normal.x, -1, "Workflow reverses path normal");
  near(workflowValid([a, b], "along-path", { pathPosition: 75 }).origin.x, 1.5, "Workflow accepts ordered point paths");
  for (const pathPosition of [-1, 101, NaN]) {
    rejects(() => workflow([a, b], "along-path").build({ pathPosition }), "Workflow validates path position");
  }
  workflowValid([surface()], "planar-surface");
  workflowValid([surface()], "tangent");
  workflowValid([{ ...a, normal: new Vector3(0, 0, 1) }], "tangent");
  rejects(() => workflow([cloud], "tangent").build(), "Point clouds cannot invent a tangent normal");
  rejects(() => workflow([curved], "planar-surface").build(), "Flat workflow must preserve surface fitting errors");
  workflowValid([curved], "local-best-fit");
  workflowValid([surface(), b, c, d], "best-fit");
  assert(fitCalls.at(-1).length === 4, "Workflow Best Fit includes deliberately chosen surface hit points"); passed++;
  workflowValid([reference(7), ...many], "best-fit");
  assert(fitCalls.at(-1).length === many.length, "Best Fit excludes saved plane origins"); passed++;
  workflowValid([reference(), through], "offset-point");
  return { passed };
}
