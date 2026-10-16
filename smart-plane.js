import { Vector3 } from "three";

// Resolve only unambiguous constructions; ambiguous selections remain editable.
export function inferPickedPlane(references, { fitSurface, fitPoints, surfaceMode = "planar-surface" }) {
  if (!references.length) throw new Error("Pick a surface, an edge, or three points on the model.");
  const surfaces = references.filter((reference) => reference.kind === "surface");
  if (surfaces.length) {
    if (references.length !== 1) throw new Error("Use one surface, or undo it to select edges and points.");
    const reference = surfaces[0];
    if (surfaceMode === "tangent") {
      if (!reference.normal) throw new Error("A tangent plane requires a mesh surface normal.");
      const normal = reference.normal.clone().normalize();
      const helper = Math.abs(normal.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
      return { method: "Tangent", origin: reference.point.clone(), normal, xAxis: helper.cross(normal).normalize() };
    }
    return { ...(surfaceMode === "best-fit" ? fitPoints(reference) : fitSurface(reference)),
      method: surfaceMode === "best-fit" ? "Local Best Fit" : "Planar Surface" };
  }
  const edges = references.filter((reference) => reference.kind === "edge");
  const points = references.filter((reference) => reference.kind !== "edge").map((reference) => reference.point);
  let samples, method;
  if (edges.length === 2 && !points.length) {
    samples = edges.flatMap((reference) => reference.edge);
    method = "Through 2 Edges";
  } else if (edges.length === 1 && points.length === 1) {
    samples = [...edges[0].edge, points[0]];
    method = "Through Edge and Point";
  } else if (!edges.length && points.length === 3) {
    samples = points;
    method = "Through 3 Points";
  } else if ((!edges.length && points.length < 3) || (edges.length === 1 && !points.length)) {
    throw new Error(edges.length ? "Pick a point off the edge or a second coplanar edge." : "Pick " + (3 - points.length) + " more " + (points.length === 2 ? "point." : "points, or an edge."));
  } else {
    throw new Error("Use three points, one edge and a point, or two edges. Undo the last pick.");
  }
  const origin = samples.reduce((sum, point) => sum.add(point), new Vector3()).multiplyScalar(1 / samples.length);
  const xAxis = samples[1].clone().sub(samples[0]);
  const scale = Math.max(...samples.map((point) => point.distanceTo(samples[0])));
  if (scale === 0 || xAxis.length() <= scale * 1e-8) throw new Error("Choose distinct points or a nonzero edge.");
  const normal = new Vector3();
  for (const point of samples.slice(2)) {
    const candidate = xAxis.clone().cross(point.clone().sub(samples[0]));
    if (candidate.lengthSq() > normal.lengthSq()) normal.copy(candidate);
  }
  if (normal.length() <= xAxis.length() * scale * 1e-8) throw new Error("These references lie on one line. Pick a point or edge off that line.");
  normal.normalize();
  if (samples.some((point) => Math.abs(point.clone().sub(samples[0]).dot(normal)) > scale * 1e-6)) {
    throw new Error("These edges are skew and do not share a plane. Undo one edge and pick another.");
  }
  return { method, origin, normal, xAxis: xAxis.normalize() };
}
