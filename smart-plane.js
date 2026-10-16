import { Vector3 } from "three";

const METHODS = {
  "planar-surface": ["Planar Surface", "surface"],
  "three-points": ["3 Points", "points"],
  "edge-point": ["Edge + Point", "edges"],
  "best-fit": ["Best Fit", "fit"],
  "local-best-fit": ["Local Best Fit", "fit"],
  tangent: ["Tangent", "point"],
  "two-edges": ["2 Edges", "edges"],
  "along-path": ["Along Path", "path"],
  offset: ["Offset", "offset"],
  "offset-point": ["Parallel through Point", "offset"],
  angle: ["At Angle", "angle"],
  midplane: ["Midplane", "midplane"],
  perpendicular: ["Perpendicular", "perpendicular"],
};

function fallbackAxis(normal) {
  const helper = Math.abs(normal.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
  return helper.cross(normal).normalize();
}

function normalizePlane(plane) {
  if (!plane?.origin || !plane?.normal ||
      ![...plane.origin, ...plane.normal].every(Number.isFinite) || plane.normal.lengthSq() === 0) {
    throw new Error("These references do not define a stable plane.");
  }
  const normal = plane.normal.clone().normalize();
  let xAxis = plane.xAxis?.clone() || fallbackAxis(normal);
  xAxis.addScaledVector(normal, -xAxis.dot(normal));
  if (xAxis.lengthSq() < 1e-16) xAxis = fallbackAxis(normal);
  if (![...xAxis].every(Number.isFinite)) throw new Error("The reference plane has an invalid axis.");
  // A new construction must never inherit a saved reference's ID or visibility.
  return {
    method: plane.method, origin: plane.origin.clone(), normal, xAxis: xAxis.normalize(),
    ...(Number.isFinite(plane.angleToReference) ? { angleToReference: plane.angleToReference } : {}),
  };
}

function planeThroughSamples(samples, method) {
  const first = samples[0];
  const scale = Math.max(...samples.map((point) => point.distanceTo(first)));
  const xAxis = samples[1].clone().sub(first);
  if (!scale || xAxis.length() <= scale * 1e-8) throw new Error("Choose distinct points or a nonzero edge.");
  const normal = new Vector3();
  for (const point of samples.slice(2)) {
    const candidate = xAxis.clone().cross(point.clone().sub(first));
    if (candidate.lengthSq() > normal.lengthSq()) normal.copy(candidate);
  }
  if (normal.length() <= xAxis.length() * scale * 1e-8) {
    throw new Error("These references lie on one line. Pick a point or edge off that line.");
  }
  normal.normalize();
  if (samples.some((point) => Math.abs(point.clone().sub(first).dot(normal)) > scale * 1e-6)) {
    throw new Error("These edges are skew and do not share a plane. Choose Best Fit or change the selection.");
  }
  const origin = samples.reduce((sum, point) => sum.add(point), new Vector3()).multiplyScalar(1 / samples.length);
  return { method, origin, normal, xAxis: xAxis.normalize() };
}

function lineFromPoints(first, second) {
  const direction = second.clone().sub(first);
  if (!direction.lengthSq()) throw new Error("Choose two different points for the line.");
  return { first, second, direction: direction.normalize() };
}

function planeAlongPath(line, { pathPosition, reversePath = false }) {
  if (!Number.isFinite(pathPosition) || pathPosition < 0 || pathPosition > 100) {
    throw new Error("Path position must be between 0 and 100 percent.");
  }
  const fraction = reversePath ? 1 - pathPosition / 100 : pathPosition / 100;
  return { method: "Along Path", origin: line.first.clone().lerp(line.second, fraction),
    normal: line.direction.clone().multiplyScalar(reversePath ? -1 : 1) };
}

function planeAtAngle(reference, line, angle) {
  if (!Number.isFinite(angle)) throw new Error("Enter a finite angle in degrees.");
  const radians = angle * Math.PI / 180;
  const normal = reference.normal.clone().applyAxisAngle(line.direction, radians);
  const angleToReference = Math.acos(Math.min(1, Math.abs(normal.dot(reference.normal)))) * 180 / Math.PI;
  return { method: "At Angle", origin: line.first, normal, angleToReference,
    xAxis: reference.xAxis.clone().applyAxisAngle(line.direction, radians) };
}

function perpendicularPlane(reference, line) {
  const normal = line.direction.clone().cross(reference.normal);
  if (normal.lengthSq() <= 1e-12) {
    throw new Error("This line is normal to the reference plane; it does not define a unique perpendicular plane.");
  }
  return { method: "Perpendicular", origin: line.first, normal, xAxis: line.direction };
}

function planeBetweenReferences(first, second) {
  if (Math.abs(first.normal.dot(second.normal)) < 0.9999) {
    throw new Error("Midplane requires two parallel flat surfaces or reference planes.");
  }
  const distance = second.origin.clone().sub(first.origin).dot(first.normal);
  return { ...first, method: "Midplane", origin: first.origin.clone().addScaledVector(first.normal, distance / 2) };
}

function planeThroughTwoEdges(endpoints) {
  if (!endpoints[2].distanceToSquared(endpoints[3])) throw new Error("The second edge needs two different endpoints.");
  return planeThroughSamples(endpoints, "Through 2 Edges");
}

// Match Manual's reference ownership: world planes remain fixed when the
// model changes, while model-space constructions follow the model.
export function getPickedPlaneSpace(method, references) {
  const spaces = references.filter((reference) => ["plane", "surface"].includes(reference.kind))
    .map((reference) => reference.sourceSpace || reference.plane?.space || "model");
  if (["offset", "offset-point", "angle", "perpendicular"].includes(method)) return spaces[0] || "model";
  if (method === "midplane" && spaces.includes("world")) return "world";
  return "model";
}

// Candidates consume the entire typed selection. Unsupported or invalid geometry is
// never silently discarded, projected, or replaced with another construction.
export function getPickedPlaneCandidates(references, { fitSurface, fitLocalPoints, fitPoints } = {}) {
  const candidates = [];
  const points = references.filter((reference) => !reference.kind || reference.kind === "point");
  const edges = references.filter((reference) => reference.kind === "edge");
  const planes = references.filter((reference) => ["surface", "plane"].includes(reference.kind));
  const samples = references.flatMap((reference) => reference.kind === "edge" ? reference.edge : [reference.point]);
  const defaults = { angle: 45, pathPosition: 50 };
  function add(id, construct, parameters = []) {
    const [label, icon] = METHODS[id];
    const build = (parameters = defaults) => normalizePlane(construct({ ...defaults, ...parameters }));
    let error = null;
    try { build(); } catch (failure) { error = failure.message; }
    candidates.push({ id, label, icon: "#choice-" + icon, parameters, error, build });
  }
  function referencePlane(reference) {
    return normalizePlane(reference.kind === "plane" ? reference.plane : fitSurface(reference));
  }
  function selectedLine() {
    if (edges.length === 1 && !points.length) return lineFromPoints(...edges[0].edge);
    return lineFromPoints(points[0].point, points[1].point);
  }

  if (planes.length === 1 && references.length === 1) {
    const reference = planes[0];
    if (reference.kind === "surface") {
      add("planar-surface", () => ({ ...referencePlane(reference), method: "Planar Surface" }));
      if (reference.normal) {
        add("tangent", () => ({ origin: reference.point, normal: reference.normal, method: "Tangent" }));
      }
      add("local-best-fit", () => ({ ...fitLocalPoints(reference), method: "Local Best Fit" }));
    }
    add("offset", () => ({ ...referencePlane(reference), method: "Offset" }), ["offset"]);
  } else if (planes.length === 2 && references.length === 2) {
    add("midplane", () => planeBetweenReferences(...planes.map(referencePlane)));
  } else if (planes.length === 1 && ((edges.length === 1 && !points.length) || (!edges.length && points.length === 2))) {
    add("angle", ({ angle }) => planeAtAngle(referencePlane(planes[0]), selectedLine(), angle), ["angle"]);
    add("perpendicular", () => perpendicularPlane(referencePlane(planes[0]), selectedLine()));
  } else if (planes.length === 1 && points.length === 1 && references.length === 2) {
    add("offset-point", () => ({ ...referencePlane(planes[0]), origin: points[0].point, method: "Parallel through Point" }));
  } else if (!planes.length && points.length + edges.length === references.length) {
    if ((edges.length === 1 && !points.length) || (!edges.length && points.length === 2)) {
      add("along-path", (parameters) => planeAlongPath(selectedLine(), parameters), ["pathPosition"]);
    }
    if (!edges.length && points.length === 3) {
      add("three-points", () => planeThroughSamples(samples, "Through 3 Points"));
    }
    if (edges.length === 1 && points.length === 1) {
      add("edge-point", () => planeThroughSamples([...edges[0].edge, points[0].point], "Through Edge and Point"));
    }
    if (edges.length * 2 + points.length === 4) {
      add("two-edges", () => {
        const endpoints = edges.flatMap((reference) => reference.edge).concat(points.map((reference) => reference.point));
        // Shared endpoints are valid, but duplicate entire edges do not define a plane.
        return planeThroughTwoEdges(endpoints);
      });
    }
    if (samples.length >= 3) {
      add("best-fit", () => ({ ...fitPoints(samples), method: "Best Fit" }));
    }
  }

  let hint = "Pick surfaces, edges, points, or reference planes.";
  if (points.length === 1 && references.length === 1) hint = "Pick a second point for a path, or three points for a plane.";
  else if (references.length && !candidates.length) hint = "This combination is not supported. Undo a pick or clear the selection.";
  return { candidates, hint };
}

// Unlike inferred candidates, workflows remain available before their geometry
// is complete. The caller can expose their reference/parameter fields immediately
// and call build again as the user picks the missing geometry. All inputs and
// explicit reference planes must use the same coordinate space (world in the UI).
export function getPlaneConstructionWorkflows(references = [], { fitSurface, fitLocalPoints, fitPoints } = {}) {
  const workflows = [];
  const edges = references.filter((reference) => reference.kind === "edge");
  const planes = references.filter((reference) => ["surface", "plane"].includes(reference.kind));
  const points = references.filter((reference) => !reference.kind || reference.kind === "point");
  const surfaces = references.filter((reference) => reference.kind === "surface");
  const defaults = { angle: 45, pathPosition: 50, offset: 0 };

  function add(id, construct, parameters = []) {
    const [label, icon] = METHODS[id];
    const build = (parameters = {}) => normalizePlane(construct({ ...defaults, ...parameters }));
    let error = null;
    try { build(); } catch (failure) { error = failure.message; }
    workflows.push({ id, label, icon: "#choice-" + icon, parameters, error, build });
  }

  function fittedReference(reference) {
    if (reference?.origin && reference?.normal) return normalizePlane(reference);
    if (reference?.kind === "plane") return normalizePlane(reference.plane);
    if (reference?.kind === "surface") {
      if (!fitSurface) throw new Error("Surface fitting is unavailable.");
      return normalizePlane(fitSurface(reference));
    }
    throw new Error("Choose a reference plane or pick a flat surface.");
  }

  function referenceFor(parameters, slot) {
    const index = slot === "referenceA" ? 0 : 1;
    const reference = parameters[slot] ?? planes[index];
    if (!reference) throw new Error("Choose reference " + (index ? "B" : "A") + " or pick a flat surface.");
    return fittedReference(reference);
  }

  function selectedPointSamples(includeEdges = false) {
    if (edges.length && !includeEdges) throw new Error("Choose points for this method, or change the selection filter to Points.");
    // Surface hit positions are deliberate point samples when a point method is
    // explicitly chosen. A saved plane's origin is never an implicit point pick.
    return references.flatMap((reference) => reference.kind === "plane" ? []
      : reference.kind === "edge" ? reference.edge : [reference.point]);
  }

  function exactSamples(count, instruction, includeEdges = false) {
    const samples = selectedPointSamples(includeEdges);
    if (samples.length !== count) throw new Error(instruction);
    return samples;
  }

  function selectedLine(parameters = {}) {
    if (edges.length === 1 && !points.length) return lineFromPoints(...edges[0].edge);
    if (edges.length) throw new Error("Pick one edge or two points for the line.");
    // A surface already serving as the fallback plane cannot also silently
    // become an axis endpoint. An explicitly supplied plane leaves surface hit
    // positions available as endpoints, just as Manual accepts face points.
    const fallbackSurface = parameters.referenceA == null && planes[0]?.kind === "surface" ? planes[0] : null;
    const pointReferences = points.length === 2 ? points
      : references.filter((reference) => reference.kind !== "plane" && reference !== fallbackSurface);
    if (pointReferences.length !== 2) throw new Error("Pick one edge or two points for the line.");
    return lineFromPoints(pointReferences[0].point, pointReferences[1].point);
  }

  function surfaceSample() {
    const samples = references.filter((reference) => reference.kind !== "plane");
    if (samples.length !== 1 || samples[0].kind === "edge") {
      throw new Error("Pick one surface location for this method.");
    }
    return samples[0];
  }

  add("planar-surface", () => {
    const reference = surfaceSample();
    if (!fitSurface) throw new Error("Surface fitting is unavailable.");
    return { ...fitSurface(reference), method: "Planar Surface" };
  });
  add("three-points", () => planeThroughSamples(
    exactSamples(3, "Pick three non-collinear points for the plane."), "Through 3 Points",
  ));
  add("best-fit", () => {
    const samples = selectedPointSamples(true);
    if (samples.length < 3) throw new Error("Pick at least three points for Best Fit.");
    if (!fitPoints) throw new Error("Point fitting is unavailable.");
    return { ...fitPoints(samples), method: "Best Fit" };
  });
  add("tangent", () => {
    const reference = surfaceSample();
    if (!reference.normal) throw new Error("Pick a triangle on a surface mesh for its tangent normal.");
    return { origin: reference.point, normal: reference.normal, method: "Tangent" };
  });
  add("two-edges", () => {
    const samples = exactSamples(4, "Pick two edges, one edge and two endpoints, or four ordered endpoints.", true);
    const endpoints = edges.length ? edges.flatMap((reference) => reference.edge)
      .concat(references.filter((reference) => reference.kind !== "plane" && reference.kind !== "edge").map((reference) => reference.point)) : samples;
    return planeThroughTwoEdges(endpoints);
  });
  add("along-path", (parameters) => {
    const samples = exactSamples(2, "Pick one edge or two ordered points for the path.", true);
    return planeAlongPath(lineFromPoints(...samples), parameters);
  }, ["pathPosition"]);
  add("offset", (parameters) => {
    const reference = referenceFor(parameters, "referenceA");
    if (!Number.isFinite(parameters.offset)) throw new Error("Enter a finite offset distance.");
    return { ...reference, origin: reference.origin.clone().addScaledVector(reference.normal, parameters.offset), method: "Offset" };
  }, ["referenceA", "offset"]);
  add("angle", (parameters) => planeAtAngle(
    referenceFor(parameters, "referenceA"), selectedLine(parameters), parameters.angle,
  ), ["referenceA", "angle"]);
  add("midplane", (parameters) => planeBetweenReferences(
    referenceFor(parameters, "referenceA"), referenceFor(parameters, "referenceB"),
  ), ["referenceA", "referenceB"]);
  add("perpendicular", (parameters) => perpendicularPlane(
    referenceFor(parameters, "referenceA"), selectedLine(parameters),
  ), ["referenceA"]);

  if (edges.length === 1 && points.length + surfaces.length === 1) {
    add("edge-point", () => planeThroughSamples(selectedPointSamples(true), "Through Edge and Point"));
  }
  if (references.length === 1 && references[0].kind !== "plane" && references[0].kind !== "edge") {
    add("local-best-fit", () => {
      if (!fitLocalPoints) throw new Error("Local point fitting is unavailable.");
      return { ...fitLocalPoints(references[0]), method: "Local Best Fit" };
    });
  }
  if (planes.length === 1 && points.length === 1 && !edges.length) {
    add("offset-point", (parameters) => ({ ...referenceFor(parameters, "referenceA"),
      origin: points[0].point, method: "Parallel through Point" }), ["referenceA"]);
  }
  return { workflows, hint: "Choose a construction, then pick its geometry and set its references." };
}
