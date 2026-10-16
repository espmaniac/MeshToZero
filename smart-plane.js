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
  return { method: plane.method, origin: plane.origin.clone(), normal, xAxis: xAxis.normalize() };
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
    add("midplane", () => {
      const [first, second] = planes.map(referencePlane);
      if (Math.abs(first.normal.dot(second.normal)) < 0.9999) {
        throw new Error("Midplane requires two parallel flat surfaces or reference planes.");
      }
      const distance = second.origin.clone().sub(first.origin).dot(first.normal);
      const scale = Math.max(first.origin.distanceTo(second.origin), 1e-12);
      if (Math.abs(distance) <= scale * 1e-8) throw new Error("These planes coincide. Pick two separated parallel planes.");
      return { ...first, method: "Midplane", origin: first.origin.clone().addScaledVector(first.normal, distance / 2) };
    });
  } else if (planes.length === 1 && ((edges.length === 1 && !points.length) || (!edges.length && points.length === 2))) {
    add("angle", ({ angle }) => {
      if (!Number.isFinite(angle)) throw new Error("Enter a finite angle in degrees.");
      const reference = referencePlane(planes[0]);
      const line = selectedLine();
      // The axis direction must be parallel to the reference plane so the
      // entered rotation is also the resulting angle between the planes.
      if (Math.abs(line.direction.dot(reference.normal)) > 1e-6) {
        throw new Error("At Angle needs an axis parallel to the reference plane.");
      }
      const radians = angle * Math.PI / 180;
      return { method: "At Angle", origin: line.first,
        normal: reference.normal.clone().applyAxisAngle(line.direction, radians),
        xAxis: reference.xAxis.clone().applyAxisAngle(line.direction, radians) };
    }, ["angle"]);
    add("perpendicular", () => {
      const reference = referencePlane(planes[0]);
      const line = selectedLine();
      const normal = line.direction.clone().cross(reference.normal);
      if (normal.lengthSq() <= 1e-12) {
        throw new Error("This line is normal to the reference plane; it does not define a unique perpendicular plane.");
      }
      return { method: "Perpendicular", origin: line.first, normal, xAxis: line.direction };
    });
  } else if (!planes.length && points.length + edges.length === references.length) {
    if ((edges.length === 1 && !points.length) || (!edges.length && points.length === 2)) {
      add("along-path", ({ pathPosition }) => {
        if (!Number.isFinite(pathPosition) || pathPosition < 0 || pathPosition > 100) {
          throw new Error("Path position must be between 0 and 100 percent.");
        }
        const line = selectedLine();
        return { method: "Along Path", origin: line.first.clone().lerp(line.second, pathPosition / 100), normal: line.direction };
      }, ["pathPosition"]);
    }
    if (!edges.length && points.length === 3) {
      add("three-points", () => planeThroughSamples(samples, "Through 3 Points"));
    }
    if (edges.length === 1 && points.length === 1) {
      add("edge-point", () => planeThroughSamples([...edges[0].edge, points[0].point], "Through Edge and Point"));
    }
    if ((edges.length === 2 && !points.length) || (!edges.length && points.length === 4)) {
      add("two-edges", () => {
        const endpoints = edges.length ? edges.flatMap((reference) => reference.edge) : points.map((reference) => reference.point);
        if (!endpoints[2].distanceToSquared(endpoints[3])) throw new Error("The second edge needs two different endpoints.");
        // Shared endpoints are valid, but duplicate entire edges do not define a plane.
        return planeThroughSamples(endpoints, "Through 2 Edges");
      });
    }
    if (samples.length >= 3) {
      add("best-fit", () => ({ ...fitPoints(samples), method: "Best Fit" }));
    }
  }

  let hint = "Pick surfaces, edges, points, or reference planes.";
  if (points.length === 1 && references.length === 1) hint = "Pick a second point for a path, or three points for a plane.";
  else if (planes.length === 1 && references.length === 2 && points.length === 1) hint = "Pick another point to define an axis for At Angle or Perpendicular.";
  else if (references.length && !candidates.length) hint = "This combination is not supported. Undo a pick or clear the selection.";
  return { candidates, hint };
}
