import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { ConvexHull } from "three/addons/math/ConvexHull.js";
import { OBJExporter } from "three/addons/exporters/OBJExporter.js";
import { PLYExporter } from "three/addons/exporters/PLYExporter.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";

const MODEL_SIZE = 2.7;
const MODEL_HALF_SIZE = MODEL_SIZE / 2;
const GRID_LIMIT = 12;
const MIN_MODEL_RADIUS = 0.35;
const GEOMETRY_EPSILON = 1e-8;
const MAX_OBB_CANDIDATE_FRAMES = 6000;
const PRINCIPAL_AXIS_SEPARATION_RATIO = 1.05;
const LOCAL_PLANE_MAX_NEIGHBORS = 320;
const LOCAL_PLANE_FIT_NEIGHBORS = 128;
const LOCAL_PLANE_RANSAC_NEIGHBORS = 28;
const SUPPORTED_EXTENSIONS = new Set(["obj", "ply", "stl"]);
const DEFAULT_VIEW_DIRECTION = new THREE.Vector3(0.55, 0.62, 0.56).normalize();
const PLANE_COLORS = [0x5a5a5a, 0x168aad, 0xe07a2f, 0x2f9d62, 0xd94f70, 0x4f83a8];

const ALIGNMENT_TARGETS = {
  z: {
    name: "Top (XY)",
    origin: new THREE.Vector3(0, 0, 0),
    normal: new THREE.Vector3(0, 0, 1),
    xAxis: new THREE.Vector3(1, 0, 0),
  },
  y: {
    name: "Front (XZ)",
    origin: new THREE.Vector3(0, 0, 0),
    normal: new THREE.Vector3(0, 1, 0),
    xAxis: new THREE.Vector3(1, 0, 0),
  },
  x: {
    name: "Right (YZ)",
    origin: new THREE.Vector3(0, 0, 0),
    normal: new THREE.Vector3(1, 0, 0),
    xAxis: new THREE.Vector3(0, 1, 0),
  },
};

const WORLD_REFERENCE_PLANES = [
  {
    id: "world-xy",
    name: "Top (XY)",
    method: "Origin plane",
    origin: new THREE.Vector3(0, 0, 0),
    normal: new THREE.Vector3(0, 0, 1),
    xAxis: new THREE.Vector3(1, 0, 0),
    space: "world",
    builtIn: true,
  },
  {
    id: "world-yz",
    name: "Right (YZ)",
    method: "Origin plane",
    origin: new THREE.Vector3(0, 0, 0),
    normal: new THREE.Vector3(1, 0, 0),
    xAxis: new THREE.Vector3(0, 1, 0),
    space: "world",
    builtIn: true,
  },
  {
    id: "world-xz",
    name: "Front (XZ)",
    method: "Origin plane",
    origin: new THREE.Vector3(0, 0, 0),
    normal: new THREE.Vector3(0, 1, 0),
    xAxis: new THREE.Vector3(1, 0, 0),
    space: "world",
    builtIn: true,
  },
];

const state = {
  displayMode: "mesh",
  modelCenterVisible: true,
  originPlanes: {
    top: true,
    front: true,
    right: true,
  },
  scaleLinked: true,
  transformGizmo: {
    mode: "translate",
    space: "world",
    gridSnap: false,
    gridStep: 1,
    angleSnap: false,
    angleStep: 15,
  },
  model: {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  },
};

const canvas = document.querySelector("#viewportCanvas");
const workspace = document.querySelector(".workspace");
const dropOverlay = document.querySelector("#dropOverlay");
const toast = document.querySelector("#toast");
let toastTimer = 0;

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function setPressedState(buttons, activeButton) {
  for (const button of buttons) {
    const isActive = button === activeButton;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }
}

function getFileExtension(fileName) {
  const separatorIndex = fileName.lastIndexOf(".");
  return separatorIndex >= 0 ? fileName.slice(separatorIndex + 1).toLowerCase() : "";
}

function getDisplayName(fileName) {
  const separatorIndex = fileName.lastIndexOf(".");
  return separatorIndex > 0 ? fileName.slice(0, separatorIndex) : fileName;
}

function getPlyFileInfo(data) {
  const headerByteLength = Math.min(data.byteLength, 1024 * 1024);
  const header = new TextDecoder("ascii").decode(
    new Uint8Array(data, 0, headerByteLength),
  );
  const headerEnd = header.indexOf("end_header");
  if (headerEnd < 0) {
    throw new Error("The selected PLY file has an invalid or oversized header.");
  }

  const faceElement = header.slice(0, headerEnd).match(/^element\s+face\s+(\d+)\s*$/im);
  const format = header
    .slice(0, headerEnd)
    .match(/^format\s+(ascii|binary_little_endian|binary_big_endian)\s+1\.0\s*$/im);
  if (!format) throw new Error("The selected PLY file uses an unsupported encoding.");

  return {
    encoding: format[1].toLowerCase(),
    hasFaces: faceElement !== null && Number.parseInt(faceElement[1], 10) > 0,
  };
}

function getStlEncoding(data) {
  const bytes = new Uint8Array(data);
  if (data.byteLength >= 84) {
    const triangleCount = new DataView(data).getUint32(80, true);
    if (84 + triangleCount * 50 === data.byteLength) return "binary";
  }

  const solid = [115, 111, 108, 105, 100];
  for (let offset = 0; offset < 5 && offset + solid.length <= bytes.length; offset += 1) {
    if (solid.every((value, index) => bytes[offset + index] === value)) return "ascii";
  }
  return "binary";
}

function getSafeExportName(fileName) {
  return (
    getDisplayName(fileName)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .trim() || "model"
  );
}

function createModelExportObject(geometries, modelMatrix, fileName) {
  const exportRoot = new THREE.Group();
  exportRoot.name = getSafeExportName(fileName);
  exportRoot.matrixAutoUpdate = false;
  exportRoot.matrix.copy(modelMatrix);

  geometries.forEach((geometry, index) => {
    const isPointCloud = geometry.userData.primitiveType === "points";
    const object = isPointCloud
      ? new THREE.Points(geometry, null)
      : new THREE.Mesh(geometry, null);
    object.name = exportRoot.name + (geometries.length > 1 ? "_part_" + (index + 1) : "");
    exportRoot.add(object);
  });

  exportRoot.updateMatrixWorld(true);
  return exportRoot;
}

function serializeModelExport(exportObject, sourceFile) {
  let data;
  let mimeType = "application/octet-stream";

  if (sourceFile.extension === "obj") {
    data = new OBJExporter().parse(exportObject);
    mimeType = "text/plain;charset=utf-8";
  } else if (sourceFile.extension === "ply") {
    const binary = sourceFile.encoding !== "ascii";
    data = new PLYExporter().parse(exportObject, null, {
      binary,
      littleEndian: sourceFile.encoding === "binary_little_endian",
    });
    if (!binary) mimeType = "text/plain;charset=utf-8";
  } else if (sourceFile.extension === "stl") {
    const binary = sourceFile.encoding === "binary";
    data = new STLExporter().parse(exportObject, { binary });
    if (!binary) mimeType = "text/plain;charset=utf-8";
  } else {
    throw new Error("The imported model format cannot be exported.");
  }

  if (data === null || data === undefined) {
    throw new Error("The model could not be encoded in its original format.");
  }

  const baseName = getSafeExportName(sourceFile.name);
  return {
    data,
    mimeType,
    fileName: baseName + "-meshtozero." + sourceFile.extension,
  };
}

function getNiceScale(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = 10 ** Math.floor(Math.log10(value));
  const fraction = value / exponent;
  if (fraction <= 1) return exponent;
  if (fraction <= 2) return 2 * exponent;
  if (fraction <= 5) return 5 * exponent;
  return 10 * exponent;
}

function createFallbackAxis(normal) {
  const candidates = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1),
  ];
  candidates.sort((left, right) => Math.abs(left.dot(normal)) - Math.abs(right.dot(normal)));
  return candidates[0].addScaledVector(normal, -candidates[0].dot(normal)).normalize();
}

function normalizePlaneBasis(normal, preferredXAxis) {
  const normalizedNormal = normal.clone();
  if (normalizedNormal.lengthSq() <= GEOMETRY_EPSILON ** 2) {
    throw new Error("The selected references do not define a stable plane.");
  }
  normalizedNormal.normalize();

  const xAxis = preferredXAxis?.clone() || createFallbackAxis(normalizedNormal);
  xAxis.addScaledVector(normalizedNormal, -xAxis.dot(normalizedNormal));
  if (xAxis.lengthSq() <= GEOMETRY_EPSILON ** 2) {
    xAxis.copy(createFallbackAxis(normalizedNormal));
  } else {
    xAxis.normalize();
  }

  const yAxis = normalizedNormal.clone().cross(xAxis).normalize();
  return { normal: normalizedNormal, xAxis, yAxis };
}

function createNormalAlignmentDelta(sourceNormal, targetNormal, preferredAxis) {
  const source = sourceNormal.clone().normalize();
  const target = targetNormal.clone().normalize();
  const dot = THREE.MathUtils.clamp(source.dot(target), -1, 1);

  if (dot >= 1 - GEOMETRY_EPSILON) {
    return new THREE.Quaternion();
  }

  if (dot <= -1 + GEOMETRY_EPSILON) {
    const axis = preferredAxis?.clone() || createFallbackAxis(source);
    axis.addScaledVector(source, -axis.dot(source));
    if (axis.lengthSq() <= GEOMETRY_EPSILON ** 2) {
      axis.copy(createFallbackAxis(source));
    } else {
      axis.normalize();
    }
    return new THREE.Quaternion().setFromAxisAngle(axis, Math.PI);
  }

  return new THREE.Quaternion().setFromUnitVectors(source, target).normalize();
}

function jacobiEigenDecomposition(matrix) {
  const values = matrix.map((row) => row.slice());
  const vectors = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (let iteration = 0; iteration < 32; iteration += 1) {
    let p = 0;
    let q = 1;
    let largest = Math.abs(values[0][1]);
    for (const [row, column] of [
      [0, 2],
      [1, 2],
    ]) {
      const candidate = Math.abs(values[row][column]);
      if (candidate > largest) {
        largest = candidate;
        p = row;
        q = column;
      }
    }

    if (largest <= 1e-14) break;

    const app = values[p][p];
    const aqq = values[q][q];
    const apq = values[p][q];
    const angle = 0.5 * Math.atan2(2 * apq, aqq - app);
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);

    for (let index = 0; index < 3; index += 1) {
      if (index === p || index === q) continue;
      const aip = values[index][p];
      const aiq = values[index][q];
      values[index][p] = cosine * aip - sine * aiq;
      values[p][index] = values[index][p];
      values[index][q] = sine * aip + cosine * aiq;
      values[q][index] = values[index][q];
    }

    values[p][p] =
      cosine * cosine * app - 2 * sine * cosine * apq + sine * sine * aqq;
    values[q][q] =
      sine * sine * app + 2 * sine * cosine * apq + cosine * cosine * aqq;
    values[p][q] = 0;
    values[q][p] = 0;

    for (let index = 0; index < 3; index += 1) {
      const vip = vectors[index][p];
      const viq = vectors[index][q];
      vectors[index][p] = cosine * vip - sine * viq;
      vectors[index][q] = sine * vip + cosine * viq;
    }
  }

  return [0, 1, 2]
    .map((index) => ({
      value: Math.max(0, values[index][index]),
      vector: new THREE.Vector3(
        vectors[0][index],
        vectors[1][index],
        vectors[2][index],
      ).normalize(),
    }))
    .sort((left, right) => left.value - right.value);
}

function fitPlaneToPoints(points) {
  const origin = points.reduce(
    (sum, point) => sum.add(point),
    new THREE.Vector3(),
  ).multiplyScalar(1 / points.length);
  const covariance = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];

  for (const point of points) {
    const delta = point.clone().sub(origin);
    covariance[0][0] += delta.x * delta.x;
    covariance[0][1] += delta.x * delta.y;
    covariance[0][2] += delta.x * delta.z;
    covariance[1][1] += delta.y * delta.y;
    covariance[1][2] += delta.y * delta.z;
    covariance[2][2] += delta.z * delta.z;
  }
  covariance[1][0] = covariance[0][1];
  covariance[2][0] = covariance[0][2];
  covariance[2][1] = covariance[1][2];

  const eigen = jacobiEigenDecomposition(covariance);
  const largestVariance = eigen[2].value;
  if (largestVariance <= GEOMETRY_EPSILON || eigen[1].value <= largestVariance * 1e-10) {
    throw new Error("Choose points that are not all on one line.");
  }

  const basis = normalizePlaneBasis(eigen[0].vector, eigen[2].vector);
  return { origin, ...basis };
}

function fitPlanarSurfaceAtPoint(
  points,
  seed,
  {
    preferredNormal = null,
    orientationHint = null,
    xAxisHint = null,
    absoluteTolerance = GEOMETRY_EPSILON,
  } = {},
) {
  if (points.length < 3) {
    throw new Error("The selected area needs at least three nearby points.");
  }

  const safeAbsoluteTolerance = Math.max(absoluteTolerance, GEOMETRY_EPSILON);
  const samples = points
    .map((point) => ({
      point,
      distanceSq: point.distanceToSquared(seed),
    }))
    .sort((left, right) => left.distanceSq - right.distanceSq)
    .slice(0, LOCAL_PLANE_FIT_NEIGHBORS);
  const neighborhood = samples.map((sample) => sample.point);
  const nonzeroSamples = samples.filter(
    (sample) => sample.distanceSq > safeAbsoluteTolerance ** 2,
  );
  if (nonzeroSamples.length < 2) {
    throw new Error("The selected area needs three distinct non-collinear points.");
  }

  const radius = Math.sqrt(samples.at(-1).distanceSq);
  const densityCount = Math.min(nonzeroSamples.length, 16);
  const densityRadius = Math.sqrt(nonzeroSamples[densityCount - 1].distanceSq);
  const spacing = densityRadius / Math.sqrt(densityCount);
  const distanceTolerance = Math.max(
    safeAbsoluteTolerance,
    spacing * 0.45,
    radius * 0.006,
  );
  const getInliers = (origin, normal, multiplier = 1) =>
    neighborhood.filter(
      (point) =>
        Math.abs(point.clone().sub(origin).dot(normal)) <= distanceTolerance * multiplier,
    );

  let inliers = [];
  if (preferredNormal?.lengthSq() > GEOMETRY_EPSILON ** 2) {
    const normal = preferredNormal.clone().normalize();
    inliers = getInliers(seed, normal);
    if (inliers.length < 3) inliers = getInliers(seed, normal, 2);
  } else {
    let bestCandidate = null;
    const considerCandidate = (origin, normal) => {
      const candidateInliers = getInliers(origin, normal);
      if (candidateInliers.length < 3) return;
      const residual = candidateInliers.reduce((sum, point) => {
        const distance = point.clone().sub(origin).dot(normal);
        return sum + distance * distance;
      }, 0);
      if (
        !bestCandidate ||
        candidateInliers.length > bestCandidate.inliers.length ||
        (candidateInliers.length === bestCandidate.inliers.length &&
          residual < bestCandidate.residual)
      ) {
        bestCandidate = { inliers: candidateInliers, residual };
      }
    };

    try {
      const initialFit = fitPlaneToPoints(neighborhood);
      considerCandidate(initialFit.origin, initialFit.normal);
    } catch {
      // Pair candidates below can still recover a plane when the full neighborhood is ambiguous.
    }

    const ransacSamples = nonzeroSamples.slice(0, LOCAL_PLANE_RANSAC_NEIGHBORS);
    for (let firstIndex = 0; firstIndex < ransacSamples.length - 1; firstIndex += 1) {
      const first = ransacSamples[firstIndex].point.clone().sub(seed);
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < ransacSamples.length;
        secondIndex += 1
      ) {
        const second = ransacSamples[secondIndex].point.clone().sub(seed);
        const normal = first.clone().cross(second);
        const maximumArea = Math.sqrt(first.lengthSq() * second.lengthSq());
        if (
          maximumArea <= safeAbsoluteTolerance ** 2 ||
          normal.length() <= maximumArea * 1e-4
        ) {
          continue;
        }
        considerCandidate(seed, normal.normalize());
      }
    }
    inliers = bestCandidate?.inliers || [];
  }

  const minimumInliers =
    neighborhood.length < 8 ? 3 : Math.max(6, Math.ceil(neighborhood.length * 0.4));
  if (inliers.length < (preferredNormal ? 3 : minimumInliers)) {
    throw new Error(
      "No flat surface was found around that point. Click farther from an edge or use Best Fit.",
    );
  }

  let fitted = null;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    fitted = fitPlaneToPoints(inliers);
    const refined = getInliers(fitted.origin, fitted.normal, 1.5);
    if (refined.length < 3 || refined.length === inliers.length) break;
    inliers = refined;
  }
  fitted = fitPlaneToPoints(inliers);

  const orientation = orientationHint || preferredNormal;
  const normal = fitted.normal.clone();
  if (orientation?.lengthSq() > GEOMETRY_EPSILON ** 2 && normal.dot(orientation) < 0) {
    normal.negate();
  }

  let preferredXAxis = fitted.xAxis;
  if (xAxisHint?.lengthSq() > GEOMETRY_EPSILON ** 2) {
    const projectedXAxis = xAxisHint
      .clone()
      .addScaledVector(normal, -xAxisHint.dot(normal));
    if (projectedXAxis.lengthSq() > GEOMETRY_EPSILON ** 2) {
      preferredXAxis = projectedXAxis.normalize();
    }
  }
  const basis = normalizePlaneBasis(normal, preferredXAxis);
  const origin = seed
    .clone()
    .addScaledVector(
      basis.normal,
      -seed.clone().sub(fitted.origin).dot(basis.normal),
    );
  let squaredError = 0;
  let planarExtentSq = 0;
  for (const point of inliers) {
    const delta = point.clone().sub(fitted.origin);
    const signedDistance = delta.dot(basis.normal);
    squaredError += signedDistance * signedDistance;
    planarExtentSq = Math.max(
      planarExtentSq,
      Math.max(0, delta.lengthSq() - signedDistance * signedDistance),
    );
  }
  const rmsError = Math.sqrt(squaredError / inliers.length);
  const planarExtent = Math.sqrt(planarExtentSq);
  if (
    planarExtent <= safeAbsoluteTolerance ||
    (rmsError > safeAbsoluteTolerance * 2 && rmsError / planarExtent > 0.035)
  ) {
    throw new Error(
      "The selected neighborhood is not flat enough. Click a broader planar area.",
    );
  }

  return {
    origin,
    normal: basis.normal,
    xAxis: basis.xAxis,
    pointCount: inliers.length,
    rmsError,
  };
}

function addNearestPointSample(heap, keys, sample, maximum) {
  if (keys.has(sample.key)) return;
  if (heap.length < maximum) {
    heap.push(sample);
    keys.add(sample.key);
    let childIndex = heap.length - 1;
    while (childIndex > 0) {
      const parentIndex = Math.floor((childIndex - 1) / 2);
      if (heap[parentIndex].distanceSq >= heap[childIndex].distanceSq) break;
      [heap[parentIndex], heap[childIndex]] = [heap[childIndex], heap[parentIndex]];
      childIndex = parentIndex;
    }
    return;
  }
  if (sample.distanceSq >= heap[0].distanceSq) return;

  keys.delete(heap[0].key);
  heap[0] = sample;
  keys.add(sample.key);
  let parentIndex = 0;
  while (true) {
    const leftIndex = parentIndex * 2 + 1;
    const rightIndex = leftIndex + 1;
    let largestIndex = parentIndex;
    if (
      leftIndex < heap.length &&
      heap[leftIndex].distanceSq > heap[largestIndex].distanceSq
    ) {
      largestIndex = leftIndex;
    }
    if (
      rightIndex < heap.length &&
      heap[rightIndex].distanceSq > heap[largestIndex].distanceSq
    ) {
      largestIndex = rightIndex;
    }
    if (largestIndex === parentIndex) break;
    [heap[parentIndex], heap[largestIndex]] = [heap[largestIndex], heap[parentIndex]];
    parentIndex = largestIndex;
  }
}

function getPrincipalFrame(points) {
  const center = points
    .reduce((sum, point) => sum.add(point), new THREE.Vector3())
    .multiplyScalar(1 / points.length);
  const covariance = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];

  for (const point of points) {
    const delta = point.clone().sub(center);
    covariance[0][0] += delta.x * delta.x;
    covariance[0][1] += delta.x * delta.y;
    covariance[0][2] += delta.x * delta.z;
    covariance[1][1] += delta.y * delta.y;
    covariance[1][2] += delta.y * delta.z;
    covariance[2][2] += delta.z * delta.z;
  }
  covariance[1][0] = covariance[0][1];
  covariance[2][0] = covariance[0][2];
  covariance[2][1] = covariance[1][2];

  const eigen = jacobiEigenDecomposition(covariance);
  if (eigen[2].value <= GEOMETRY_EPSILON) {
    throw new Error("The model does not contain enough spatial extent to determine an orientation.");
  }

  const xAxis = eigen[2].vector.clone();
  const preferredYAxis =
    eigen[1].value > eigen[2].value * 1e-12
      ? eigen[1].vector.clone()
      : createFallbackAxis(xAxis);
  const zAxis = xAxis.clone().cross(preferredYAxis).normalize();
  const yAxis = zAxis.clone().cross(xAxis).normalize();
  return {
    xAxis,
    yAxis,
    zAxis,
    variances: new THREE.Vector3(eigen[2].value, eigen[1].value, eigen[0].value),
  };
}

function canonicalDirectionKey(direction) {
  const values = [direction.x, direction.y, direction.z];
  let dominantIndex = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (Math.abs(values[index]) > Math.abs(values[dominantIndex])) dominantIndex = index;
  }
  const sign = values[dominantIndex] < 0 ? -1 : 1;
  return values.map((value) => Math.round(value * sign * 1e6)).join(":");
}

function evaluateOrientedFrame(points, frame) {
  const minimum = new THREE.Vector3(Infinity, Infinity, Infinity);
  const maximum = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

  for (const point of points) {
    const x = point.dot(frame.xAxis);
    const y = point.dot(frame.yAxis);
    const z = point.dot(frame.zAxis);
    minimum.x = Math.min(minimum.x, x);
    minimum.y = Math.min(minimum.y, y);
    minimum.z = Math.min(minimum.z, z);
    maximum.x = Math.max(maximum.x, x);
    maximum.y = Math.max(maximum.y, y);
    maximum.z = Math.max(maximum.z, z);
  }

  const size = maximum.clone().sub(minimum);
  const centerCoordinates = minimum.clone().add(maximum).multiplyScalar(0.5);
  const center = new THREE.Vector3()
    .addScaledVector(frame.xAxis, centerCoordinates.x)
    .addScaledVector(frame.yAxis, centerCoordinates.y)
    .addScaledVector(frame.zAxis, centerCoordinates.z);
  const dimensionFloor = Math.max(size.x, size.y, size.z, 1) * 1e-9;
  const score =
    Math.max(size.x, dimensionFloor) *
    Math.max(size.y, dimensionFloor) *
    Math.max(size.z, dimensionFloor);
  return { ...frame, center, size, score };
}

function sampleCandidateFrames(frames, limit) {
  if (frames.length <= limit) return frames;
  const sampled = [frames[0]];
  const remainingLimit = limit - 1;
  for (let index = 0; index < remainingLimit; index += 1) {
    const sourceIndex = 1 + Math.floor((index * (frames.length - 1)) / remainingLimit);
    sampled.push(frames[sourceIndex]);
  }
  return sampled;
}

function findBestOrientedFrame(points) {
  const principal = getPrincipalFrame(points);
  const frames = new Map();
  const addFrame = (normal, preferredXAxis) => {
    try {
      const basis = normalizePlaneBasis(normal, preferredXAxis);
      const key =
        canonicalDirectionKey(basis.normal) + "|" + canonicalDirectionKey(basis.xAxis);
      if (!frames.has(key)) {
        frames.set(key, {
          xAxis: basis.xAxis,
          yAxis: basis.yAxis,
          zAxis: basis.normal,
        });
      }
    } catch {
      // Degenerate hull edges are ignored; the PCA frame remains available as a fallback.
    }
  };

  addFrame(principal.zAxis, principal.xAxis);
  let boundsPoints = points;

  try {
    const hull = new ConvexHull().setFromPoints(points);
    if (hull.faces.length) {
      const hullPointSet = new Set();
      for (const face of hull.faces) {
        let edge = face.edge;
        do {
          const tail = edge.tail()?.point;
          const head = edge.head()?.point;
          if (tail && head) {
            hullPointSet.add(tail);
            hullPointSet.add(head);
            addFrame(face.normal, head.clone().sub(tail));
          }
          edge = edge.next;
        } while (edge && edge !== face.edge);
      }
      if (hullPointSet.size) boundsPoints = [...hullPointSet];
    }
  } catch (error) {
    console.warn("Convex hull orientation analysis fell back to principal axes:", error);
  }

  const candidateFrames = sampleCandidateFrames(
    [...frames.values()],
    MAX_OBB_CANDIDATE_FRAMES,
  );
  let best = null;
  for (const frame of candidateFrames) {
    const evaluated = evaluateOrientedFrame(boundsPoints, frame);
    if (!best || evaluated.score < best.score) best = evaluated;
  }

  return {
    ...best,
    hullVertexCount: boundsPoints.length,
    candidateFrameCount: candidateFrames.length,
  };
}

function orderFrameAxesByExtent(frame) {
  const axes = [
    { direction: frame.xAxis.clone(), size: frame.size.x },
    { direction: frame.yAxis.clone(), size: frame.size.y },
    { direction: frame.zAxis.clone(), size: frame.size.z },
  ].sort((left, right) => right.size - left.size);
  const xAxis = axes[0].direction.normalize();
  let zAxis = axes[2].direction.normalize();
  let yAxis = zAxis.clone().cross(xAxis).normalize();

  if (yAxis.dot(axes[1].direction) < 0) {
    zAxis = zAxis.negate();
    yAxis = zAxis.clone().cross(xAxis).normalize();
  }

  return {
    xAxis,
    yAxis,
    zAxis,
    size: new THREE.Vector3(axes[0].size, axes[1].size, axes[2].size),
  };
}

function findStableModelFrame(points) {
  const principal = getPrincipalFrame(points);
  const hasDistinctLongAxis =
    principal.variances.x > principal.variances.y * PRINCIPAL_AXIS_SEPARATION_RATIO;
  const hasDistinctShortAxis =
    principal.variances.y >
    Math.max(principal.variances.z, GEOMETRY_EPSILON) * PRINCIPAL_AXIS_SEPARATION_RATIO;

  if (hasDistinctLongAxis && hasDistinctShortAxis) {
    return evaluateOrientedFrame(points, principal);
  }

  const oriented = orderFrameAxesByExtent(findBestOrientedFrame(points));
  const zAxis = (hasDistinctShortAxis ? principal.zAxis : oriented.zAxis)
    .clone()
    .normalize();
  const xAxis = (hasDistinctLongAxis ? principal.xAxis : oriented.xAxis).clone();
  xAxis.addScaledVector(zAxis, -xAxis.dot(zAxis));
  if (xAxis.lengthSq() <= GEOMETRY_EPSILON ** 2) {
    xAxis.copy(createFallbackAxis(zAxis));
  } else {
    xAxis.normalize();
  }
  const yAxis = zAxis.clone().cross(xAxis).normalize();

  return evaluateOrientedFrame(points, { xAxis, yAxis, zAxis });
}

function createAutomaticAxisPlaneDefinitions(frame, scale) {
  if ([scale.x, scale.y, scale.z].some((value) => Math.abs(value) <= GEOMETRY_EPSILON)) {
    throw new Error("Automatic model axes require a non-zero scale on every axis.");
  }

  const ordered = orderFrameAxesByExtent(frame);
  const origin = new THREE.Vector3(
    frame.center.x / scale.x,
    frame.center.y / scale.y,
    frame.center.z / scale.z,
  );
  const toModelDirection = (direction) =>
    new THREE.Vector3(
      direction.x / scale.x,
      direction.y / scale.y,
      direction.z / scale.z,
    ).normalize();
  const toModelNormal = (normal) => normal.clone().multiply(scale).normalize();
  const xAxis = toModelDirection(ordered.xAxis);
  const yAxis = toModelDirection(ordered.yAxis);

  return [
    {
      label: "Top",
      origin: origin.clone(),
      normal: toModelNormal(ordered.zAxis),
      xAxis,
    },
    {
      label: "Front",
      origin: origin.clone(),
      normal: toModelNormal(ordered.yAxis),
      xAxis,
    },
    {
      label: "Right",
      origin: origin.clone(),
      normal: toModelNormal(ordered.xAxis),
      xAxis: yAxis,
    },
  ];
}

function createOrientedBoundsPlaneDefinitions(frame, scale) {
  if ([scale.x, scale.y, scale.z].some((value) => Math.abs(value) <= GEOMETRY_EPSILON)) {
    throw new Error("Oriented bounds require a non-zero scale on every axis.");
  }

  const ordered = orderFrameAxesByExtent(frame);
  const halfSize = ordered.size.clone().multiplyScalar(0.5);
  const toModelPoint = (point) =>
    new THREE.Vector3(
      point.x / scale.x,
      point.y / scale.y,
      point.z / scale.z,
    );
  const toModelDirection = (direction) =>
    new THREE.Vector3(
      direction.x / scale.x,
      direction.y / scale.y,
      direction.z / scale.z,
    ).normalize();
  const toModelNormal = (normal) => normal.clone().multiply(scale).normalize();
  const createFace = (label, outwardDirection, distance, tangentDirection) => ({
    label,
    kind: "face",
    origin: toModelPoint(
      frame.center.clone().addScaledVector(outwardDirection, distance),
    ),
    normal: toModelNormal(outwardDirection),
    xAxis: toModelDirection(tangentDirection),
  });
  const createCenter = (label, normal, tangentDirection) => ({
    label,
    kind: "center",
    origin: toModelPoint(frame.center),
    normal: toModelNormal(normal),
    xAxis: toModelDirection(tangentDirection),
  });
  const negativeX = ordered.xAxis.clone().negate();
  const negativeY = ordered.yAxis.clone().negate();
  const negativeZ = ordered.zAxis.clone().negate();
  const faces = [
    createFace("Left", negativeX, halfSize.x, ordered.yAxis),
    createFace("Right", ordered.xAxis, halfSize.x, ordered.yAxis),
    createFace("Back", negativeY, halfSize.y, ordered.xAxis),
    createFace("Front", ordered.yAxis, halfSize.y, ordered.xAxis),
    createFace("Bottom", negativeZ, halfSize.z, ordered.xAxis),
    createFace("Top", ordered.zAxis, halfSize.z, ordered.xAxis),
  ];
  const centers = [
    createCenter("Right Center", ordered.xAxis, ordered.yAxis),
    createCenter("Front Center", ordered.yAxis, ordered.xAxis),
    createCenter("Top Center", ordered.zAxis, ordered.xAxis),
  ];
  const corners = [];

  for (const xSign of [-1, 1]) {
    for (const ySign of [-1, 1]) {
      for (const zSign of [-1, 1]) {
        const corner = frame.center
          .clone()
          .addScaledVector(ordered.xAxis, xSign * halfSize.x)
          .addScaledVector(ordered.yAxis, ySign * halfSize.y)
          .addScaledVector(ordered.zAxis, zSign * halfSize.z);
        corners.push(toModelPoint(corner));
      }
    }
  }

  return {
    faces,
    centers,
    corners,
    center: toModelPoint(frame.center),
    size: ordered.size.clone(),
  };
}

function createRotationFromBasis(xAxis, yAxis, zAxis) {
  const basisMatrix = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
  return new THREE.Quaternion().setFromRotationMatrix(basisMatrix).invert().normalize();
}

// Keep source vertices untouched while rotating and scaling around the model center.
function calculateRootPositionAroundPivot(modelPosition, rotation, scale, pivot) {
  const transformedPivot = pivot.clone().multiply(scale).applyQuaternion(rotation);
  return modelPosition.clone().add(pivot).sub(transformedPivot);
}

function calculateTransformGizmoPosition(modelPosition, pivot) {
  return pivot.clone().add(modelPosition);
}

function calculateModelPositionFromTransformGizmo(gizmoPosition, pivot) {
  return gizmoPosition.clone().sub(pivot);
}

function formatCoordinate(value) {
  if (!Number.isFinite(value)) return "0";
  const absoluteValue = Math.abs(value);
  if (absoluteValue < 1e-9) return "0.000";
  if ((absoluteValue > 0 && absoluteValue < 0.001) || absoluteValue >= 100000) {
    return value.toExponential(3);
  }
  return value.toFixed(3);
}

function chooseAlignmentPlaneHit(sourceHits, targetHits) {
  const sourceId = sourceHits[0]?.object?.userData?.alignmentPlaneId;
  if (sourceId) return { kind: "source", id: sourceId };
  const targetId = targetHits[0]?.object?.userData?.alignmentTargetId;
  if (targetId) return { kind: "target", id: targetId };
  return null;
}

class ThreeViewport {
  constructor(targetCanvas) {
    this.canvas = targetCanvas;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    this.camera.up.set(0, 0, 1);
    this.renderer = new THREE.WebGLRenderer({
      canvas: targetCanvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    this.controls = new OrbitControls(this.camera, targetCanvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.minPolarAngle = 0;
    this.controls.maxPolarAngle = Math.PI;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = false;
    this.controls.mouseButtons.LEFT = null;
    this.controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    this.controls.listenToKeyEvents(window);

    this.loaders = {
      obj: new OBJLoader(),
      ply: new PLYLoader(),
      stl: new STLLoader(),
    };

    this.createLights();
    this.createGrid();
    this.createGroundDetails();
    this.createModel();
    this.createTransformGizmo();

    this.compactLayout = this.canvas.clientWidth <= 700;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);

    this.activePointerButton = null;
    this.selectionPointerStart = null;
    this.canvas.addEventListener(
      "pointerdown",
      (event) => {
        this.activePointerButton = event.button;
        if (event.button === 1) {
          this.syncOrbitTargetToModelCenter();
          this.controls.update();
        }
        if (
          event.button === 0 &&
          (this.selectionConfig.enabled || this.alignmentPlanePicking.enabled) &&
          !this.transformControls.axis &&
          !this.transformControls.dragging
        ) {
          this.selectionPointerStart = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
          };
        }
      },
      { capture: true },
    );
    this.canvas.addEventListener(
      "pointerup",
      (event) => {
        const start = this.selectionPointerStart;
        this.selectionPointerStart = null;
        if (this.transformControls.dragging || this.transformControls.axis) return;
        if (!start || start.pointerId !== event.pointerId || event.button !== 0) return;
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
        if (this.alignmentPlanePicking.enabled) {
          this.pickAlignmentPlane(event);
        } else {
          this.pickConstructionReference(event);
        }
      },
      { capture: true },
    );
    this.canvas.addEventListener("pointermove", (event) => {
      if (!this.alignmentPlanePicking.enabled || event.buttons !== 0) return;
      this.setAlignmentPlaneHover(this.getAlignmentPlaneHit(event));
    });
    this.canvas.addEventListener("pointerleave", () => {
      this.setAlignmentPlaneHover(null);
    });
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    this.controls.addEventListener("start", () => {
      this.canvas.classList.add("is-dragging");
      this.canvas.classList.toggle("is-panning", this.activePointerButton === 2);
    });
    this.controls.addEventListener("end", () => {
      this.activePointerButton = null;
      this.canvas.classList.remove("is-dragging", "is-panning");
    });
    this.canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      showToast("The WebGL context was lost. Waiting for the browser to restore it.");
    });
    this.canvas.addEventListener("webglcontextrestored", () => {
      showToast("The WebGL viewport was restored.");
    });

    this.resize();
    this.fitView();
    this.setDisplayMode(state.displayMode);
    for (const [plane, visible] of Object.entries(state.originPlanes)) {
      this.setOriginPlaneVisible(plane, visible);
    }
    this.applyTransform();
    this.updateTheme();
    this.renderer.setAnimationLoop(() => this.render());
  }

  createLights() {
    this.hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x727272, 2.2);
    this.scene.add(this.hemisphereLight);

    this.keyLight = new THREE.DirectionalLight(0xffffff, 3.1);
    this.keyLight.position.set(-5, -7, 10);
    this.scene.add(this.keyLight);

    this.fillLight = new THREE.DirectionalLight(0xffffff, 0.75);
    this.fillLight.position.set(7, 4, 5);
    this.scene.add(this.fillLight);
  }

  createGridLines(major) {
    const positions = [];
    for (let index = -GRID_LIMIT; index <= GRID_LIMIT; index += 1) {
      if (index === 0 || (index % 5 === 0) !== major) continue;
      positions.push(
        -GRID_LIMIT,
        index,
        0,
        GRID_LIMIT,
        index,
        0,
        index,
        -GRID_LIMIT,
        0,
        index,
        GRID_LIMIT,
        0,
      );
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
      transparent: true,
      depthWrite: false,
    });
    return new THREE.LineSegments(geometry, material);
  }

  createAxis(start, end, color) {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(...start),
      new THREE.Vector3(...end),
    ]);
    const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
    return new THREE.Line(geometry, material);
  }

  createOriginPlaneGrid(name, targetId, rotation, opacityFactor) {
    const group = new THREE.Group();
    const minor = this.createGridLines(false);
    const major = this.createGridLines(true);
    const pickMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const pickSurface = new THREE.Mesh(
      new THREE.PlaneGeometry(GRID_LIMIT * 2, GRID_LIMIT * 2),
      pickMaterial,
    );
    pickSurface.name = name + " alignment hit surface";
    pickSurface.userData.alignmentTargetId = targetId;
    minor.userData.alignmentTargetId = targetId;
    major.userData.alignmentTargetId = targetId;
    pickSurface.renderOrder = -2;
    minor.position.z = -0.004;
    major.position.z = -0.003;
    group.name = name;
    group.rotation.set(rotation.x, rotation.y, rotation.z);
    group.add(pickSurface, minor, major);
    group.userData.alignmentHitObjects = [pickSurface, minor, major];
    this.scene.add(group);
    return { group, minor, major, pickSurface, targetId, opacityFactor };
  }

  createGrid() {
    this.originPlaneGrids = {
      top: this.createOriginPlaneGrid(
        "Top origin plane (XY)",
        "z",
        new THREE.Euler(0, 0, 0),
        1,
      ),
      front: this.createOriginPlaneGrid(
        "Front origin plane (XZ)",
        "y",
        new THREE.Euler(Math.PI / 2, 0, 0),
        0.72,
      ),
      right: this.createOriginPlaneGrid(
        "Right origin plane (YZ)",
        "x",
        new THREE.Euler(0, Math.PI / 2, 0),
        0.72,
      ),
    };
    this.gridGroup = this.originPlaneGrids.top.group;
    this.gridMinor = this.originPlaneGrids.top.minor;
    this.gridMajor = this.originPlaneGrids.top.major;

    this.axisGroup = new THREE.Group();
    this.xAxis = this.createAxis([-GRID_LIMIT, 0, 0], [GRID_LIMIT, 0, 0], 0xef4444);
    this.yAxis = this.createAxis([0, -GRID_LIMIT, 0], [0, GRID_LIMIT, 0], 0x2aad54);
    this.zAxis = this.createAxis([0, 0, 0], [0, 0, 6], 0x2386ff);
    this.axisGroup.add(this.xAxis, this.yAxis, this.zAxis);
    this.scene.add(this.axisGroup);
  }

  createGroundDetails() {
    this.shadowMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.1,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.modelShadow = new THREE.Mesh(new THREE.CircleGeometry(1, 64), this.shadowMaterial);
    this.modelShadow.renderOrder = -1;
    this.scene.add(this.modelShadow);

    this.originMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.originMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.062, 18, 12),
      this.originMaterial,
    );
    this.originMarker.renderOrder = 3;
    this.scene.add(this.originMarker);
  }

  createModelCenterMarker() {
    this.modelCenterMarker = new THREE.Group();
    this.modelCenterMarker.name = "Automatic model center";

    this.modelCenterHaloMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      depthTest: false,
      depthWrite: false,
    });
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(0.03, 20, 14),
      this.modelCenterHaloMaterial,
    );
    halo.renderOrder = 18;

    this.modelCenterCoreMaterial = new THREE.MeshBasicMaterial({
      color: 0x5a5a5a,
      depthTest: false,
      depthWrite: false,
    });
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.021, 20, 14),
      this.modelCenterCoreMaterial,
    );
    core.renderOrder = 19;

    const hitMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    hitMaterial.colorWrite = false;
    this.modelCenterHitTarget = new THREE.Mesh(
      new THREE.SphereGeometry(0.048, 16, 10),
      hitMaterial,
    );
    this.modelCenterHitTarget.name = "Model center hit target";

    this.modelCenterMarker.add(halo, core, this.modelCenterHitTarget);
    this.modelCenterMarker.visible = state.modelCenterVisible;
    this.modelRoot.add(this.modelCenterMarker);
  }

  createModel() {
    this.modelRoot = new THREE.Group();
    this.modelRoot.rotation.order = "XYZ";
    this.scene.add(this.modelRoot);
    this.createModelCenterMarker();

    this.constructionWorldGroup = new THREE.Group();
    this.constructionWorldGroup.name = "World construction planes";
    this.scene.add(this.constructionWorldGroup);

    this.constructionModelGroup = new THREE.Group();
    this.constructionModelGroup.name = "Model construction planes";
    this.modelRoot.add(this.constructionModelGroup);

    this.selectionGroup = new THREE.Group();
    this.selectionGroup.name = "Selected model references";
    this.modelRoot.add(this.selectionGroup);

    this.boundsGroup = new THREE.Group();
    this.boundsGroup.name = "Model bounds";
    this.modelRoot.add(this.boundsGroup);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.selectionConfig = { enabled: false, method: "three-points", max: 3 };
    this.alignmentPlanePicking = {
      enabled: false,
      sourceId: null,
      targetId: null,
      hovered: null,
    };
    this.selectionReferences = [];
    this.constructionPlanes = [];
    this.planeSequence = 0;
    this.onSelectionChange = null;
    this.onPlanesChange = null;
    this.onModelCenterChange = null;
    this.onAlignmentPlanePick = null;
    this.boundsHelper = null;
    this.boundsHelperMode = null;
    this.renderModel = null;
    this.sourceFile = null;
    this.localBounds = new THREE.Box3();
    this.referenceScale = 1;
    this.showDemoModel(false);
  }

  createTransformGizmo() {
    this.transformGizmoAnchor = new THREE.Object3D();
    this.transformGizmoAnchor.name = "Model transform pivot";
    this.scene.add(this.transformGizmoAnchor);

    this.transformControls = new TransformControls(this.camera, this.canvas);
    this.transformControls.attach(this.transformGizmoAnchor);
    this.transformControls.size = 0.9;
    this.transformGizmoHelper = this.transformControls.getHelper();
    this.scene.add(this.transformGizmoHelper);

    this.transformGizmoVisible = true;
    this.transformGizmoInteractionEnabled = true;
    this.onTransformGizmoStart = null;
    this.onTransformGizmoChange = null;
    this.onTransformGizmoEnd = null;
    this.onTransformGridStepChange = null;

    this.transformControls.addEventListener("axis-changed", (event) => {
      this.canvas.classList.toggle("is-gizmo-hover", Boolean(event.value));
    });
    this.transformControls.addEventListener("mouseDown", (event) => {
      this.controls.enabled = false;
      this.selectionPointerStart = null;
      this.canvas.classList.add("is-transforming");
      this.onTransformGizmoStart?.(event.mode);
    });
    this.transformControls.addEventListener("objectChange", () => {
      this.syncModelTransformFromGizmo();
      this.onTransformGizmoChange?.();
    });
    this.transformControls.addEventListener("mouseUp", (event) => {
      this.controls.enabled = true;
      this.canvas.classList.remove("is-transforming");
      this.onTransformGizmoEnd?.(event.mode);
    });

    this.setTransformGizmoSettings(state.transformGizmo);
    this.syncTransformGizmoFromModel();
  }

  setTransformGizmoSettings(settings) {
    if (!this.transformControls) return;
    const gridStep = Math.max(GEOMETRY_EPSILON, Number(settings.gridStep) || 1);
    const angleStep = Math.max(GEOMETRY_EPSILON, Number(settings.angleStep) || 15);
    this.transformControls.setMode(settings.mode === "rotate" ? "rotate" : "translate");
    this.transformControls.setSpace(settings.space === "local" ? "local" : "world");
    this.transformControls.setTranslationSnap(settings.gridSnap ? gridStep : null);
    this.transformControls.setRotationSnap(
      settings.angleSnap ? THREE.MathUtils.degToRad(angleStep) : null,
    );
  }

  updateTransformGizmoAvailability() {
    if (!this.transformControls) return;
    const isAvailable = this.transformGizmoVisible && this.transformGizmoInteractionEnabled;
    this.transformControls.enabled = isAvailable;
    this.transformGizmoHelper.visible = this.transformGizmoVisible;
    if (!isAvailable) {
      this.transformControls.axis = null;
      this.canvas.classList.remove("is-gizmo-hover");
    }
  }

  setTransformGizmoVisible(visible) {
    this.transformGizmoVisible = visible;
    this.updateTransformGizmoAvailability();
  }

  setTransformGizmoEnabled(enabled) {
    this.transformGizmoInteractionEnabled = enabled;
    this.updateTransformGizmoAvailability();
  }

  syncTransformGizmoFromModel() {
    if (!this.transformGizmoAnchor) return;
    const pivot = this.getLocalBoundsInfo()?.center || new THREE.Vector3();
    const { position } = state.model;
    this.transformGizmoAnchor.position.copy(
      calculateTransformGizmoPosition(
        new THREE.Vector3(position.x, position.y, position.z),
        pivot,
      ),
    );
    this.transformGizmoAnchor.quaternion.copy(this.modelRoot.quaternion);
    this.transformGizmoAnchor.scale.set(1, 1, 1);
    this.transformGizmoAnchor.updateMatrixWorld(true);
  }

  syncModelTransformFromGizmo() {
    const pivot = this.getLocalBoundsInfo()?.center || new THREE.Vector3();
    const position = calculateModelPositionFromTransformGizmo(
      this.transformGizmoAnchor.position,
      pivot,
    );
    const rotation = new THREE.Euler().setFromQuaternion(
      this.transformGizmoAnchor.quaternion,
      "XYZ",
    );
    state.model.position = {
      x: Math.abs(position.x) <= 1e-12 ? 0 : position.x,
      y: Math.abs(position.y) <= 1e-12 ? 0 : position.y,
      z: Math.abs(position.z) <= 1e-12 ? 0 : position.z,
    };
    state.model.rotation = {
      x: Math.abs(rotation.x) <= 1e-12 ? 0 : rotation.x,
      y: Math.abs(rotation.y) <= 1e-12 ? 0 : rotation.y,
      z: Math.abs(rotation.z) <= 1e-12 ? 0 : rotation.z,
    };
    this.applyTransform(false, false);
  }

  showDemoModel(fit = true) {
    const geometry = new THREE.BoxGeometry(MODEL_SIZE, MODEL_SIZE, MODEL_SIZE);
    geometry.translate(0, 0, MODEL_HALF_SIZE);
    geometry.userData.flatShading = true;
    geometry.userData.primitiveType = "surface";
    this.installRenderModel([geometry]);
    this.sourceFile = null;
    if (fit) this.fitView();
  }

  prepareGeometry(geometry, primitiveType) {
    const position = geometry.getAttribute("position");
    const minimumVertexCount = primitiveType === "points" ? 1 : 3;
    if (!position || position.count < minimumVertexCount) {
      throw new Error("The selected file does not contain usable vertices.");
    }

    for (let index = 0; index < position.count; index += 1) {
      if (
        !Number.isFinite(position.getX(index)) ||
        !Number.isFinite(position.getY(index)) ||
        !Number.isFinite(position.getZ(index))
      ) {
        throw new Error("The selected file contains invalid vertex coordinates.");
      }
    }

    if (primitiveType === "surface" && !geometry.getAttribute("normal")) {
      geometry.computeVertexNormals();
    }
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const box = geometry.boundingBox;
    const sphere = geometry.boundingSphere;
    if (
      !box ||
      box.isEmpty() ||
      !sphere ||
      !Number.isFinite(sphere.radius) ||
      !Number.isFinite(box.min.x) ||
      !Number.isFinite(box.min.y) ||
      !Number.isFinite(box.min.z) ||
      !Number.isFinite(box.max.x) ||
      !Number.isFinite(box.max.y) ||
      !Number.isFinite(box.max.z)
    ) {
      throw new Error("The selected file has invalid geometry bounds.");
    }
  }

  buildRenderModel(geometries) {
    if (!geometries.length) {
      throw new Error("The selected file does not contain renderable geometry.");
    }

    const renderModel = {
      surfaceGroup: new THREE.Group(),
      edgeGroup: new THREE.Group(),
      vertexGroup: new THREE.Group(),
      pointCloudGroup: new THREE.Group(),
      modelGeometries: [],
      edgeGeometries: [],
      surfaceMaterials: [],
      edgeMaterials: [],
      pointMaterials: [],
      localBounds: new THREE.Box3(),
      vertexCount: 0,
      hasSurfaceGeometry: false,
      hasPointCloud: false,
    };

    try {
      for (const geometry of geometries) {
        const primitiveType = geometry.userData.primitiveType || "surface";
        const isPointCloud = primitiveType === "points";
        renderModel.modelGeometries.push(geometry);
        this.prepareGeometry(geometry, primitiveType);

        const usesVertexColors = geometry.hasAttribute("color");
        const pointMaterial = new THREE.PointsMaterial({
          color: usesVertexColors ? 0xffffff : 0x5a5a5a,
          vertexColors: usesVertexColors,
          size: 6,
          sizeAttenuation: false,
        });
        pointMaterial.userData.usesVertexColors = usesVertexColors;

        if (isPointCloud) {
          renderModel.pointCloudGroup.add(new THREE.Points(geometry, pointMaterial));
          renderModel.hasPointCloud = true;
        } else {
          const surfaceMaterial = new THREE.MeshStandardMaterial({
            color: usesVertexColors ? 0xffffff : 0xb4b4b4,
            vertexColors: usesVertexColors,
            roughness: 0.86,
            metalness: 0,
            flatShading: Boolean(geometry.userData.flatShading),
            side: THREE.DoubleSide,
          });
          surfaceMaterial.userData.usesVertexColors = usesVertexColors;

          const edgeGeometry = new THREE.EdgesGeometry(geometry, 20);
          const edgeMaterial = new THREE.LineBasicMaterial({
            color: 0x555555,
            transparent: true,
            opacity: 0.4,
          });

          renderModel.surfaceGroup.add(new THREE.Mesh(geometry, surfaceMaterial));
          renderModel.edgeGroup.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));
          renderModel.vertexGroup.add(new THREE.Points(geometry, pointMaterial));
          renderModel.edgeGeometries.push(edgeGeometry);
          renderModel.surfaceMaterials.push(surfaceMaterial);
          renderModel.edgeMaterials.push(edgeMaterial);
          renderModel.hasSurfaceGeometry = true;
        }

        renderModel.pointMaterials.push(pointMaterial);
        renderModel.localBounds.union(geometry.boundingBox);
        renderModel.vertexCount += geometry.getAttribute("position").count;
      }
    } catch (error) {
      this.disposeRenderModel(renderModel);
      throw error;
    }

    return renderModel;
  }

  installRenderModel(geometries) {
    const nextRenderModel = this.buildRenderModel(geometries);
    const previousRenderModel = this.renderModel;

    if (previousRenderModel) {
      this.clearConstructionData();
      this.modelRoot.remove(
        previousRenderModel.surfaceGroup,
        previousRenderModel.edgeGroup,
        previousRenderModel.vertexGroup,
        previousRenderModel.pointCloudGroup,
      );
    }

    this.renderModel = nextRenderModel;
    this.localBounds.copy(nextRenderModel.localBounds);
    this.modelRoot.add(
      nextRenderModel.surfaceGroup,
      nextRenderModel.edgeGroup,
      nextRenderModel.vertexGroup,
      nextRenderModel.pointCloudGroup,
    );

    if (previousRenderModel) this.disposeRenderModel(previousRenderModel);

    this.updateReferenceScale();
    this.applyTransform();
    this.setDisplayMode(state.displayMode);
    this.updateTheme();

    return {
      partCount: geometries.length,
      vertexCount: nextRenderModel.vertexCount,
      hasSurfaceGeometry: nextRenderModel.hasSurfaceGeometry,
      hasPointCloud: nextRenderModel.hasPointCloud,
    };
  }

  disposeRenderModel(renderModel) {
    for (const geometry of renderModel.modelGeometries) geometry.dispose();
    for (const geometry of renderModel.edgeGeometries) geometry.dispose();
    for (const material of renderModel.surfaceMaterials) material.dispose();
    for (const material of renderModel.edgeMaterials) material.dispose();
    for (const material of renderModel.pointMaterials) material.dispose();
    renderModel.surfaceGroup.clear();
    renderModel.edgeGroup.clear();
    renderModel.vertexGroup.clear();
    renderModel.pointCloudGroup.clear();
  }

  disposeParsedObject(object) {
    object.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (Array.isArray(child.material)) {
        for (const material of child.material) material.dispose();
      } else if (child.material) {
        child.material.dispose();
      }
    });
  }

  extractObjectGeometries(object) {
    object.updateMatrixWorld(true);
    const rootInverse = object.matrixWorld.clone().invert();
    const geometries = [];

    object.traverse((child) => {
      if ((!child.isMesh && !child.isPoints) || !child.geometry?.getAttribute("position")) return;
      const geometry = child.geometry.clone();
      const relativeMatrix = new THREE.Matrix4().multiplyMatrices(rootInverse, child.matrixWorld);
      geometry.applyMatrix4(relativeMatrix);
      geometry.userData.flatShading = false;
      geometry.userData.primitiveType = child.isPoints ? "points" : "surface";
      geometries.push(geometry);
    });

    return geometries;
  }

  async loadFile(file) {
    const extension = getFileExtension(file.name);
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      throw new Error("Choose a PLY, OBJ, or STL file.");
    }

    let geometries = [];
    let encoding = "text";
    if (extension === "obj") {
      const sourceObject = this.loaders.obj.parse(await file.text());
      try {
        geometries = this.extractObjectGeometries(sourceObject);
      } finally {
        this.disposeParsedObject(sourceObject);
      }
    } else {
      const data = await file.arrayBuffer();
      let primitiveType = "surface";
      if (extension === "ply") {
        const fileInfo = getPlyFileInfo(data);
        encoding = fileInfo.encoding;
        primitiveType = fileInfo.hasFaces ? "surface" : "points";
      } else {
        encoding = getStlEncoding(data);
      }

      const geometry = this.loaders[extension].parse(data);
      geometry.userData.flatShading = extension === "stl";
      geometry.userData.primitiveType = primitiveType;
      geometries = [geometry];
    }

    const result = this.installRenderModel(geometries);
    this.sourceFile = { name: file.name, extension, encoding };
    return result;
  }

  canExportModel() {
    return Boolean(this.renderModel && this.sourceFile);
  }

  exportModel() {
    if (!this.canExportModel()) {
      throw new Error("Import a model before exporting it.");
    }

    this.modelRoot.updateMatrixWorld(true);
    const exportObject = createModelExportObject(
      this.renderModel.modelGeometries,
      this.modelRoot.matrixWorld,
      this.sourceFile.name,
    );

    try {
      return serializeModelExport(exportObject, this.sourceFile);
    } finally {
      exportObject.clear();
    }
  }

  getConstructionVisualScale() {
    const size = this.localBounds.getSize(new THREE.Vector3());
    return Math.max(size.x, size.y, size.z, 0.1);
  }

  configureConstructionSelection(enabled, method, maximumReferences) {
    this.selectionConfig = {
      enabled: Boolean(enabled && maximumReferences > 0),
      method,
      max: maximumReferences,
    };
    this.selectionPointerStart = null;
    this.canvas.classList.toggle("is-selecting", this.selectionConfig.enabled);
  }

  configureAlignmentPlanePicking(enabled, sourceId = null, targetId = null) {
    const isEnabled = Boolean(enabled);
    this.alignmentPlanePicking.enabled = isEnabled;
    this.alignmentPlanePicking.sourceId = isEnabled ? sourceId : null;
    this.alignmentPlanePicking.targetId = isEnabled ? targetId : null;
    this.alignmentPlanePicking.hovered = null;
    this.selectionPointerStart = null;
    this.canvas.classList.toggle("is-plane-picking", isEnabled);
    this.canvas.classList.remove("is-plane-pick-hover");
    this.updateAlignmentPlaneVisuals();
  }

  setAlignmentPlaneSelection(sourceId, targetId) {
    this.alignmentPlanePicking.sourceId = sourceId || null;
    this.alignmentPlanePicking.targetId = targetId || null;
    this.updateAlignmentPlaneVisuals();
  }

  setAlignmentPlaneHover(hit) {
    const current = this.alignmentPlanePicking.hovered;
    if (
      (current?.kind || null) === (hit?.kind || null) &&
      (current?.id || null) === (hit?.id || null)
    ) {
      return;
    }
    this.alignmentPlanePicking.hovered = hit;
    this.canvas.classList.toggle(
      "is-plane-pick-hover",
      Boolean(this.alignmentPlanePicking.enabled && hit),
    );
    this.updateAlignmentPlaneVisuals();
  }

  setRaycasterFromPointerEvent(event) {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return true;
  }

  getAlignmentPlaneHit(event) {
    if (!this.alignmentPlanePicking.enabled || !this.setRaycasterFromPointerEvent(event)) {
      return null;
    }

    this.scene.updateMatrixWorld(true);
    const worldScale = this.modelRoot.getWorldScale(new THREE.Vector3());
    this.raycaster.params.Line.threshold = Math.max(
      this.getConstructionVisualScale() *
        Math.max(worldScale.x, worldScale.y, worldScale.z) *
        0.012,
      this.referenceScale * 0.02,
    );
    const sourceObjects = this.getModelAlignmentPlanes()
      .filter((plane) => plane.visible && plane.object.visible)
      .flatMap(
        (plane) =>
          plane.object.userData.alignmentHitObjects || [
            plane.object.userData.alignmentHitSurface,
          ],
      )
      .filter((object) => object?.visible);
    const targetObjects = Object.values(this.originPlaneGrids)
      .filter((grid) => grid.group.visible && grid.pickSurface.visible)
      .flatMap(
        (grid) => grid.group.userData.alignmentHitObjects || [grid.pickSurface],
      )
      .filter((object) => object?.visible);
    return chooseAlignmentPlaneHit(
      this.raycaster.intersectObjects(sourceObjects, false),
      this.raycaster.intersectObjects(targetObjects, false),
    );
  }

  pickAlignmentPlane(event) {
    const hit = this.getAlignmentPlaneHit(event);
    if (!hit) {
      showToast("Click a visible model plane or a Top, Front, or Right origin grid.");
      return;
    }
    this.setAlignmentPlaneHover(hit);
    this.onAlignmentPlanePick?.(hit);
  }

  updateAlignmentPlaneVisuals() {
    if (!this.originPlaneGrids || !this.alignmentPlanePicking) return;
    const rootStyle = getComputedStyle(document.documentElement);
    const value = (name) => rootStyle.getPropertyValue(name).trim();
    const darkTheme = document.documentElement.dataset.theme === "dark";
    const pickingEnabled = this.alignmentPlanePicking.enabled;
    const hovered = pickingEnabled ? this.alignmentPlanePicking.hovered : null;

    for (const plane of this.constructionPlanes) {
      const materials = plane.object.userData.planeMaterials;
      if (!materials) continue;
      const isSelected =
        pickingEnabled &&
        plane.space === "model" &&
        plane.id === this.alignmentPlanePicking.sourceId;
      const isHovered =
        hovered?.kind === "source" &&
        hovered.id === plane.id;
      materials.fillMaterial.opacity = isSelected
        ? darkTheme
          ? 0.34
          : 0.28
        : isHovered
          ? darkTheme
            ? 0.27
            : 0.22
          : darkTheme
            ? 0.17
            : 0.12;
      materials.gridMaterial.opacity = isSelected
        ? 1
        : isHovered
          ? 0.94
          : darkTheme
            ? 0.82
            : 0.72;
      materials.normalMaterial.opacity = isSelected || isHovered ? 1 : 0.95;
    }

    for (const grid of Object.values(this.originPlaneGrids)) {
      const isSelected =
        pickingEnabled && grid.targetId === this.alignmentPlanePicking.targetId;
      const isHovered =
        hovered?.kind === "target" &&
        hovered.id === grid.targetId;
      const emphasis = isSelected ? 1.46 : isHovered ? 1.25 : 1;
      grid.minor.material.color.setStyle(
        isSelected || isHovered
          ? value("--accent")
          : darkTheme
            ? "#686868"
            : "#8f8e8a",
      );
      grid.major.material.color.setStyle(
        isSelected || isHovered
          ? value("--accent")
          : darkTheme
            ? "#858585"
            : "#72716d",
      );
      grid.minor.material.opacity = Math.min(
        1,
        (darkTheme ? 0.42 : 0.5) * grid.opacityFactor * emphasis,
      );
      grid.major.material.opacity = Math.min(
        1,
        (darkTheme ? 0.58 : 0.68) * grid.opacityFactor * emphasis,
      );
      grid.pickSurface.material.color.setStyle(value("--accent"));
      grid.pickSurface.material.opacity = 0;
    }
  }

  notifySelectionChange() {
    this.onSelectionChange?.(this.selectionReferences.map((reference) => ({ ...reference })));
  }

  notifyModelCenterChange() {
    this.onModelCenterChange?.(this.getModelCenterInfo());
  }

  notifyPlanesChange() {
    this.onPlanesChange?.(this.constructionPlanes.slice());
  }

  disposeObject3D(object) {
    object.removeFromParent();
    object.traverse((child) => {
      child.geometry?.dispose();
      if (Array.isArray(child.material)) {
        for (const material of child.material) material.dispose();
      } else {
        child.material?.dispose();
      }
    });
  }

  clearConstructionSelection() {
    while (this.selectionGroup.children.length) {
      this.disposeObject3D(this.selectionGroup.children[0]);
    }
    this.selectionReferences = [];
    this.notifySelectionChange();
  }

  addSelectionMarker(point) {
    const markerRadius = this.getConstructionVisualScale() * 0.014;
    const geometry = new THREE.SphereGeometry(markerRadius, 18, 12);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffcc33,
      depthTest: false,
      depthWrite: false,
    });
    const marker = new THREE.Mesh(geometry, material);
    marker.position.copy(point);
    marker.renderOrder = 20;
    marker.userData.isSelectionMarker = true;
    this.selectionGroup.add(marker);
  }

  addConstructionReference(reference) {
    if (!reference || !this.selectionConfig.enabled) return false;
    if (this.selectionReferences.length >= this.selectionConfig.max) {
      showToast("Reference limit reached. Clear the selection to choose again.");
      return false;
    }

    const duplicateTolerance = this.getConstructionVisualScale() * 1e-7;
    if (
      this.selectionReferences.some(
        (selected) => selected.point.distanceTo(reference.point) <= duplicateTolerance,
      )
    ) {
      showToast("That reference is already selected.");
      return false;
    }

    const storedReference = {
      ...reference,
      point: reference.point.clone(),
      normal: reference.normal?.clone() || null,
      orientationHint: reference.orientationHint?.clone() || null,
      xAxisHint: reference.xAxisHint?.clone() || null,
    };
    this.selectionReferences.push(storedReference);
    this.addSelectionMarker(storedReference.point);
    this.notifySelectionChange();
    return true;
  }

  selectModelCenterReference() {
    if (!this.renderModel || !this.selectionConfig.enabled) {
      showToast("Choose a plane method that uses model points.");
      return false;
    }
    if (["tangent", "planar-surface"].includes(this.selectionConfig.method)) {
      showToast("Pick this reference directly on the model surface.");
      return false;
    }
    return this.addConstructionReference(this.getModelCenterReference());
  }

  getObjectToModelMatrix(object) {
    this.modelRoot.updateMatrixWorld(true);
    object.updateMatrixWorld(true);
    return this.modelRoot.matrixWorld.clone().invert().multiply(object.matrixWorld);
  }

  getSurfaceSelection(intersection, useFacePoint) {
    const object = intersection.object;
    const geometry = object.geometry;
    const objectToModel = this.getObjectToModelMatrix(object);
    const hitPoint = intersection.point.clone().applyMatrix4(this.modelRoot.matrixWorld.clone().invert());
    let point = hitPoint;

    if (!useFacePoint && intersection.face) {
      const position = geometry.getAttribute("position");
      const candidates = [intersection.face.a, intersection.face.b, intersection.face.c]
        .map((index) => new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(objectToModel));
      candidates.sort(
        (left, right) => left.distanceToSquared(hitPoint) - right.distanceToSquared(hitPoint),
      );
      point = candidates[0];
    }

    let normal = null;
    if (intersection.face) {
      normal = intersection.face.normal
        .clone()
        .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(objectToModel))
        .normalize();
    }

    return { point, normal, source: "surface" };
  }

  getPointCloudSelection(intersection) {
    const position = intersection.object.geometry.getAttribute("position");
    if (!Number.isInteger(intersection.index) || intersection.index >= position.count) return null;
    const objectToModel = this.getObjectToModelMatrix(intersection.object);
    return {
      point: new THREE.Vector3()
        .fromBufferAttribute(position, intersection.index)
        .applyMatrix4(objectToModel),
      normal: null,
      source: "point-cloud",
    };
  }

  getPlanarSurfaceViewHints() {
    const worldToModel = this.modelRoot.matrixWorld.clone().invert();
    return {
      orientationHint: this.raycaster.ray.direction
        .clone()
        .negate()
        .transformDirection(worldToModel),
      xAxisHint: new THREE.Vector3(1, 0, 0)
        .applyQuaternion(this.camera.quaternion)
        .transformDirection(worldToModel),
    };
  }

  getNearestModelVertices(seed, maximum = LOCAL_PLANE_MAX_NEIGHBORS) {
    if (!this.renderModel) return [];
    const heap = [];
    const keys = new Set();
    for (const geometry of this.renderModel.modelGeometries) {
      const position = geometry.getAttribute("position");
      for (let index = 0; index < position.count; index += 1) {
        const x = position.getX(index);
        const y = position.getY(index);
        const z = position.getZ(index);
        const dx = x - seed.x;
        const dy = y - seed.y;
        const dz = z - seed.z;
        addNearestPointSample(
          heap,
          keys,
          {
            x,
            y,
            z,
            key: x + "|" + y + "|" + z,
            distanceSq: dx * dx + dy * dy + dz * dz,
          },
          maximum,
        );
      }
    }

    const points = [seed.clone()];
    const seedToleranceSq = (this.getConstructionVisualScale() * 1e-9) ** 2;
    for (const sample of heap.sort((left, right) => left.distanceSq - right.distanceSq)) {
      const point = new THREE.Vector3(sample.x, sample.y, sample.z);
      if (point.distanceToSquared(seed) <= seedToleranceSq) continue;
      points.push(point);
    }
    return points;
  }

  fitPlanarSurfaceReference(reference) {
    if (!reference?.point) {
      throw new Error("Choose a point on a flat model surface.");
    }
    return fitPlanarSurfaceAtPoint(
      this.getNearestModelVertices(reference.point),
      reference.point,
      {
        preferredNormal: reference.normal,
        orientationHint: reference.orientationHint,
        xAxisHint: reference.xAxisHint,
        absoluteTolerance: this.getConstructionVisualScale() * 1e-6,
      },
    );
  }

  pickConstructionReference(event) {
    if (!this.renderModel || !this.selectionConfig.enabled) return;
    if (this.selectionReferences.length >= this.selectionConfig.max) {
      showToast("Reference limit reached. Clear the selection to choose again.");
      return;
    }

    if (!this.setRaycasterFromPointerEvent(event)) return;
    this.modelRoot.updateMatrixWorld(true);
    const worldScale = this.modelRoot.getWorldScale(new THREE.Vector3());
    this.raycaster.params.Points.threshold =
      this.getConstructionVisualScale() * Math.max(worldScale.x, worldScale.y, worldScale.z) * 0.025;

    const surfaceHits = this.raycaster.intersectObjects(
      this.renderModel.surfaceGroup.children,
      false,
    );
    const pointHits = this.raycaster.intersectObjects(
      this.renderModel.pointCloudGroup.children,
      false,
    );
    const centerHits = this.modelCenterMarker.visible
      ? this.raycaster.intersectObject(this.modelCenterHitTarget, false)
      : [];
    const nearestSurface = surfaceHits[0];
    const nearestPoint = pointHits[0];
    const nearestCenter = centerHits[0];
    const useSurface =
      nearestSurface && (!nearestPoint || nearestSurface.distance <= nearestPoint.distance);

    if (this.selectionConfig.method === "tangent" && !nearestSurface) {
      showToast("Tangent Plane requires a mesh surface. Use Planar Surface for point clouds.");
      return;
    }

    const requiresDirectModelPick = ["tangent", "planar-surface"].includes(
      this.selectionConfig.method,
    );
    let reference = null;
    if (nearestCenter && !requiresDirectModelPick) {
      reference = this.getModelCenterReference();
    } else if (useSurface || this.selectionConfig.method === "tangent") {
      reference = this.getSurfaceSelection(
        nearestSurface,
        requiresDirectModelPick,
      );
    } else if (nearestPoint) {
      reference = this.getPointCloudSelection(nearestPoint);
    }

    if (!reference) {
      showToast(
        this.selectionConfig.method === "planar-surface"
          ? "No model surface or point was found under the pointer."
          : "No model vertex was found under the pointer.",
      );
      return;
    }
    if (this.selectionConfig.method === "planar-surface") {
      Object.assign(reference, this.getPlanarSurfaceViewHints());
    }

    this.addConstructionReference(reference);
  }

  getReferencePlanes() {
    return [...WORLD_REFERENCE_PLANES, ...this.constructionPlanes];
  }

  getReferencePlane(id) {
    const plane = this.getReferencePlanes().find((candidate) => candidate.id === id);
    if (!plane) throw new Error("Choose a valid reference plane.");
    return plane;
  }

  getSpaceTransform(fromSpace, toSpace) {
    if (fromSpace === toSpace) return new THREE.Matrix4();
    this.modelRoot.updateMatrixWorld(true);
    if (fromSpace === "model" && toSpace === "world") {
      return this.modelRoot.matrixWorld.clone();
    }
    if (fromSpace === "world" && toSpace === "model") {
      return this.modelRoot.matrixWorld.clone().invert();
    }
    throw new Error("Unsupported construction plane coordinate space.");
  }

  transformPointBetweenSpaces(point, fromSpace, toSpace) {
    if (fromSpace === toSpace) return point.clone();
    return point.clone().applyMatrix4(this.getSpaceTransform(fromSpace, toSpace));
  }

  transformNormalBetweenSpaces(normal, fromSpace, toSpace) {
    if (fromSpace === toSpace) return normal.clone();
    const transform = this.getSpaceTransform(fromSpace, toSpace);
    return normal
      .clone()
      .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(transform))
      .normalize();
  }

  getPlaneInSpace(plane, targetSpace) {
    if (plane.space === targetSpace) {
      return {
        ...plane,
        origin: plane.origin.clone(),
        normal: plane.normal.clone(),
        xAxis: plane.xAxis.clone(),
      };
    }

    const transform = this.getSpaceTransform(plane.space, targetSpace);
    const origin = plane.origin.clone().applyMatrix4(transform);
    const normal = plane.normal
      .clone()
      .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(transform))
      .normalize();
    const xAxis = plane.xAxis.clone().transformDirection(transform);
    const basis = normalizePlaneBasis(normal, xAxis);
    return { ...plane, origin, ...basis, space: targetSpace };
  }

  getSelectedPointsInSpace(targetSpace) {
    return this.selectionReferences.map((reference) =>
      this.transformPointBetweenSpaces(reference.point, "model", targetSpace),
    );
  }

  createPlaneVisual(plane, color) {
    const group = new THREE.Group();
    const size = this.getConstructionVisualScale() * 1.1;
    const halfSize = size / 2;
    const fillMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.12,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(size, size), fillMaterial);
    fill.userData.alignmentPlaneId = plane.id;
    fill.renderOrder = 4;
    group.add(fill);

    const gridPositions = [];
    for (let index = -4; index <= 4; index += 1) {
      const coordinate = (index / 4) * halfSize;
      gridPositions.push(
        -halfSize,
        coordinate,
        0.001,
        halfSize,
        coordinate,
        0.001,
        coordinate,
        -halfSize,
        0.001,
        coordinate,
        halfSize,
        0.001,
      );
    }
    const gridGeometry = new THREE.BufferGeometry();
    gridGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(gridPositions, 3),
    );
    const gridMaterial = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.72,
      depthTest: false,
      depthWrite: false,
    });
    const grid = new THREE.LineSegments(gridGeometry, gridMaterial);
    grid.userData.alignmentPlaneId = plane.id;
    grid.renderOrder = 6;
    group.add(grid);

    const normalGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, size * 0.34),
    ]);
    const normalMaterial = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    });
    const normalLine = new THREE.Line(normalGeometry, normalMaterial);
    normalLine.userData.alignmentPlaneId = plane.id;
    normalLine.renderOrder = 7;
    group.add(normalLine);

    const centerMaterial = new THREE.MeshBasicMaterial({ color, depthTest: false });
    const center = new THREE.Mesh(
      new THREE.SphereGeometry(size * 0.018, 14, 10),
      centerMaterial,
    );
    center.userData.alignmentPlaneId = plane.id;
    center.renderOrder = 8;
    group.add(center);

    const basis = normalizePlaneBasis(plane.normal, plane.xAxis);
    const rotationMatrix = new THREE.Matrix4().makeBasis(
      basis.xAxis,
      basis.yAxis,
      basis.normal,
    );
    group.position.copy(plane.origin);
    group.quaternion.setFromRotationMatrix(rotationMatrix);
    group.userData.alignmentHitSurface = fill;
    group.userData.alignmentHitObjects = [fill, grid, normalLine, center];
    group.userData.planeMaterials = { fillMaterial, gridMaterial, normalMaterial };
    return group;
  }

  createConstructionPlane(
    { id, name, method, origin, normal, xAxis, space, color, visible = true },
    notify = true,
  ) {
    const basis = normalizePlaneBasis(normal, xAxis);
    let planeId = id;
    if (planeId) {
      const restoredSequence = Number.parseInt(planeId.match(/^plane-(\d+)$/)?.[1], 10);
      if (Number.isFinite(restoredSequence)) {
        this.planeSequence = Math.max(this.planeSequence, restoredSequence);
      } else {
        this.planeSequence += 1;
        planeId = "plane-" + this.planeSequence;
      }
    } else {
      this.planeSequence += 1;
      planeId = "plane-" + this.planeSequence;
    }
    const fallbackColor = PLANE_COLORS[(this.planeSequence - 1) % PLANE_COLORS.length];
    const parsedColor =
      typeof color === "string" ? Number.parseInt(color.replace(/^#/, ""), 16) : color;
    const planeColor = Number.isFinite(parsedColor) ? parsedColor : fallbackColor;
    const cleanName = name?.trim().replace(/\s+/g, " ") || method + " " + this.planeSequence;
    const plane = {
      id: planeId,
      name: cleanName,
      method,
      origin: origin.clone(),
      normal: basis.normal,
      xAxis: basis.xAxis,
      space,
      color: "#" + planeColor.toString(16).padStart(6, "0"),
      visible: Boolean(visible),
      builtIn: false,
      object: null,
    };
    plane.object = this.createPlaneVisual(plane, planeColor);
    plane.object.visible = plane.visible;
    const parent = space === "model" ? this.constructionModelGroup : this.constructionWorldGroup;
    parent.add(plane.object);
    this.constructionPlanes.push(plane);
    this.updateAlignmentPlaneVisuals();
    if (notify) this.notifyPlanesChange();
    return plane;
  }

  setConstructionPlaneVisible(id, visible) {
    const plane = this.constructionPlanes.find((candidate) => candidate.id === id);
    if (!plane) return;
    plane.visible = visible;
    plane.object.visible = visible;
    if (
      !visible &&
      this.alignmentPlanePicking.hovered?.kind === "source" &&
      this.alignmentPlanePicking.hovered.id === id
    ) {
      this.setAlignmentPlaneHover(null);
    } else {
      this.updateAlignmentPlaneVisuals();
    }
    this.notifyPlanesChange();
  }

  deleteConstructionPlane(id, notify = true) {
    const index = this.constructionPlanes.findIndex((candidate) => candidate.id === id);
    if (index < 0) return;
    const [plane] = this.constructionPlanes.splice(index, 1);
    this.disposeObject3D(plane.object);
    if (
      this.alignmentPlanePicking.hovered?.kind === "source" &&
      this.alignmentPlanePicking.hovered.id === id
    ) {
      this.setAlignmentPlaneHover(null);
    } else {
      this.updateAlignmentPlaneVisuals();
    }
    if (notify) this.notifyPlanesChange();
  }

  clearConstructionPlanes() {
    for (const plane of this.constructionPlanes) this.disposeObject3D(plane.object);
    this.constructionPlanes = [];
    this.clearBoundsHelper();
    this.setAlignmentPlaneHover(null);
    this.updateAlignmentPlaneVisuals();
    this.notifyPlanesChange();
  }

  restoreConstructionPlanes(definitions, boundsHelperMode) {
    for (const plane of this.constructionPlanes) this.disposeObject3D(plane.object);
    this.constructionPlanes = [];
    this.clearBoundsHelper();
    this.setAlignmentPlaneHover(null);

    for (const definition of definitions) {
      this.createConstructionPlane(
        {
          ...definition,
          origin: new THREE.Vector3(
            definition.origin.x,
            definition.origin.y,
            definition.origin.z,
          ),
          normal: new THREE.Vector3(
            definition.normal.x,
            definition.normal.y,
            definition.normal.z,
          ),
          xAxis: new THREE.Vector3(
            definition.xAxis.x,
            definition.xAxis.y,
            definition.xAxis.z,
          ),
        },
        false,
      );
    }

    try {
      if (boundsHelperMode === "source") {
        this.createBoundsHelper();
      } else if (boundsHelperMode === "model") {
        const frame = findStableModelFrame(this.getScaledModelVertices());
        const scale = new THREE.Vector3(
          state.model.scale.x,
          state.model.scale.y,
          state.model.scale.z,
        );
        const orientedBounds = createOrientedBoundsPlaneDefinitions(frame, scale);
        this.createOrientedBoundsHelper(orientedBounds.corners);
      }
    } catch (error) {
      console.warn("Could not restore the boundary-box helper:", error);
      this.clearBoundsHelper();
    }

    this.notifyPlanesChange();
  }

  clearBoundsHelper() {
    while (this.boundsGroup.children.length) {
      this.disposeObject3D(this.boundsGroup.children[0]);
    }
    this.boundsHelper = null;
    this.boundsHelperMode = null;
  }

  clearConstructionData() {
    this.clearConstructionSelection();
    this.clearConstructionPlanes();
  }

  getLocalBoundsInfo() {
    if (this.localBounds.isEmpty()) return null;
    return {
      min: this.localBounds.min.clone(),
      max: this.localBounds.max.clone(),
      center: this.localBounds.getCenter(new THREE.Vector3()),
      size: this.localBounds.getSize(new THREE.Vector3()),
    };
  }

  getScaledModelVertices() {
    if (!this.renderModel) throw new Error("Load a model before analyzing its orientation.");
    const points = [];
    const seen = new Set();
    const { scale } = state.model;

    for (const geometry of this.renderModel.modelGeometries) {
      const position = geometry.getAttribute("position");
      for (let index = 0; index < position.count; index += 1) {
        const point = new THREE.Vector3(
          position.getX(index) * scale.x,
          position.getY(index) * scale.y,
          position.getZ(index) * scale.z,
        );
        const key = point.x + "|" + point.y + "|" + point.z;
        if (seen.has(key)) continue;
        seen.add(key);
        points.push(point);
      }
    }

    if (points.length < 3) {
      throw new Error("The model needs at least three unique points for orientation analysis.");
    }
    return points;
  }

  createAxisAlignmentCandidates() {
    const frame = findBestOrientedFrame(this.getScaledModelVertices());
    const axes = [
      { direction: frame.xAxis.clone(), size: frame.size.x },
      { direction: frame.yAxis.clone(), size: frame.size.y },
      { direction: frame.zAxis.clone(), size: frame.size.z },
    ];
    const upAxes = axes.slice().sort((left, right) => left.size - right.size);
    const groupNames = ["Broad side", "Side", "End"];
    const candidates = [];

    upAxes.forEach((upAxis, groupIndex) => {
      const horizontalAxes = axes
        .filter((axis) => axis !== upAxis)
        .sort((left, right) => right.size - left.size);

      for (const [sideIndex, sign] of [1, -1].entries()) {
        const zAxis = upAxis.direction.clone().multiplyScalar(sign);
        const xAxis = horizontalAxes[0].direction.clone();
        const yAxis = zAxis.clone().cross(xAxis).normalize();
        candidates.push({
          id: "orientation-" + groupIndex + "-" + sideIndex,
          name: groupNames[groupIndex] + " " + (sideIndex === 0 ? "A" : "B"),
          quaternion: createRotationFromBasis(xAxis, yAxis, zAxis),
          size: new THREE.Vector3(
            horizontalAxes[0].size,
            horizontalAxes[1].size,
            upAxis.size,
          ),
        });
      }
    });

    return {
      candidates,
      hullVertexCount: frame.hullVertexCount,
      candidateFrameCount: frame.candidateFrameCount,
    };
  }

  getModelAlignmentPlanes() {
    return this.constructionPlanes.filter((plane) => plane.space === "model");
  }

  createPlaneAlignmentTransform(
    planeId,
    targetId,
    flipNormal,
    quarterTurns,
    baseTransform = state.model,
  ) {
    const plane = this.getModelAlignmentPlanes().find((candidate) => candidate.id === planeId);
    if (!plane) throw new Error("Create or choose a model-space construction plane first.");
    return this.createPlaneDefinitionAlignmentTransform(
      plane,
      targetId,
      flipNormal,
      quarterTurns,
      baseTransform,
    );
  }

  createPlaneDefinitionAlignmentTransform(
    plane,
    targetId,
    flipNormal,
    quarterTurns,
    baseTransform = state.model,
  ) {
    const target = ALIGNMENT_TARGETS[targetId];
    if (!target) throw new Error("Choose a valid world target plane.");

    const { position, rotation: eulerRotation, scale } = baseTransform;
    const currentPosition = new THREE.Vector3(position.x, position.y, position.z);
    const currentRotation = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(eulerRotation.x, eulerRotation.y, eulerRotation.z, "XYZ"),
    );
    const scaleVector = new THREE.Vector3(scale.x, scale.y, scale.z);
    const scaleMatrix = new THREE.Matrix4().makeScale(scale.x, scale.y, scale.z);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(scaleMatrix);
    const sourceNormal = plane.normal
      .clone()
      .applyNormalMatrix(normalMatrix)
      .applyQuaternion(currentRotation)
      .normalize();
    if (flipNormal) sourceNormal.negate();
    const sourceXAxis = plane.xAxis
      .clone()
      .transformDirection(scaleMatrix)
      .applyQuaternion(currentRotation)
      .normalize();
    const targetNormal = target.normal.clone().normalize();
    // Compose a world-space delta with the transform the user has already applied.
    const alignmentDelta = createNormalAlignmentDelta(
      sourceNormal,
      targetNormal,
      sourceXAxis,
    );
    const directionTurn = new THREE.Quaternion().setFromAxisAngle(
      targetNormal,
      quarterTurns * Math.PI * 0.5,
    );
    const rotation = directionTurn
      .multiply(alignmentDelta)
      .multiply(currentRotation)
      .normalize();
    const pivot = this.getLocalBoundsInfo()?.center;
    if (!pivot) throw new Error("The model center is not available.");
    const rootPosition = calculateRootPositionAroundPivot(
      currentPosition,
      rotation,
      scaleVector,
      pivot,
    );
    const planeWorldOrigin = plane.origin
      .clone()
      .multiply(scaleVector)
      .applyQuaternion(rotation)
      .add(rootPosition);
    const signedDistance = planeWorldOrigin
      .clone()
      .sub(target.origin)
      .dot(targetNormal);
    // Remove only the target-normal offset so earlier orthogonal placement stays intact.
    const alignedPosition = currentPosition
      .clone()
      .addScaledVector(targetNormal, -signedDistance);
    return { rotation, position: alignedPosition };
  }

  createLayFlatTransform(reference, baseTransform = state.model) {
    const plane = this.fitPlanarSurfaceReference(reference);
    const candidates = [false, true].map((flipNormal) => {
      const transform = this.createPlaneDefinitionAlignmentTransform(
        plane,
        "z",
        flipNormal,
        0,
        baseTransform,
      );
      const minimumZ = this.getExactWorldMinimumZ({
        position: transform.position,
        rotation: transform.rotation,
        scale: baseTransform.scale,
      });
      return { ...transform, minimumZ, flipNormal };
    });
    const validCandidates = candidates.filter((candidate) =>
      Number.isFinite(candidate.minimumZ),
    );
    if (!validCandidates.length) {
      throw new Error("The model does not contain usable vertices.");
    }

    // The correct side keeps the rest of the model above the selected surface.
    validCandidates.sort((left, right) => right.minimumZ - left.minimumZ);
    return { ...validCandidates[0], plane };
  }

  getModelCenterInfo() {
    const bounds = this.getLocalBoundsInfo();
    if (!bounds) return null;
    this.modelRoot.updateMatrixWorld(true);
    return {
      local: bounds.center.clone(),
      world: bounds.center.clone().applyMatrix4(this.modelRoot.matrixWorld),
    };
  }

  getModelCenterReference() {
    const info = this.getModelCenterInfo();
    if (!info) return null;
    return {
      point: info.local,
      normal: null,
      source: "model-center",
      label: "Model center",
    };
  }

  updateModelCenterMarker() {
    const info = this.getModelCenterInfo();
    if (!info) {
      this.modelCenterMarker.visible = false;
      return;
    }

    this.modelCenterMarker.position.copy(info.local);
    const worldSize = this.getWorldBounds().getSize(new THREE.Vector3());
    const visualScale = Math.max(worldSize.x, worldSize.y, worldSize.z, 0.1);
    const rootScale = this.modelRoot.getWorldScale(new THREE.Vector3());
    this.modelCenterMarker.scale.set(
      visualScale / Math.max(Math.abs(rootScale.x), GEOMETRY_EPSILON),
      visualScale / Math.max(Math.abs(rootScale.y), GEOMETRY_EPSILON),
      visualScale / Math.max(Math.abs(rootScale.z), GEOMETRY_EPSILON),
    );
    this.modelCenterMarker.visible = state.modelCenterVisible;
  }

  setModelCenterVisible(visible) {
    state.modelCenterVisible = Boolean(visible);
    this.modelCenterMarker.visible = state.modelCenterVisible;
  }

  createBoundsHelper() {
    this.clearBoundsHelper();
    const info = this.getLocalBoundsInfo();
    if (!info) return;
    const visualFloor = this.getConstructionVisualScale() * 1e-5;
    const geometry = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(
        Math.max(info.size.x, visualFloor),
        Math.max(info.size.y, visualFloor),
        Math.max(info.size.z, visualFloor),
      ),
    );
    const material = new THREE.LineBasicMaterial({
      color: 0x5a5a5a,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    });
    this.boundsHelper = new THREE.LineSegments(geometry, material);
    this.boundsHelper.position.copy(info.center);
    this.boundsHelper.renderOrder = 9;
    this.boundsGroup.add(this.boundsHelper);
    this.boundsHelperMode = "source";
  }

  createOrientedBoundsHelper(corners) {
    this.clearBoundsHelper();
    const edgeIndices = [
      [0, 1],
      [0, 2],
      [0, 4],
      [1, 3],
      [1, 5],
      [2, 3],
      [2, 6],
      [3, 7],
      [4, 5],
      [4, 6],
      [5, 7],
      [6, 7],
    ];
    const edgePoints = edgeIndices.flatMap(([start, end]) => [
      corners[start],
      corners[end],
    ]);
    const geometry = new THREE.BufferGeometry().setFromPoints(edgePoints);
    const material = new THREE.LineBasicMaterial({
      color: 0x5a5a5a,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    });
    this.boundsHelper = new THREE.LineSegments(geometry, material);
    this.boundsHelper.renderOrder = 9;
    this.boundsGroup.add(this.boundsHelper);
    this.boundsHelperMode = "model";
  }

  createBoundsPlanes(set, namePrefix, orientation = "model") {
    const info = this.getLocalBoundsInfo();
    if (!info) throw new Error("Load a model before creating bounds planes.");
    const useModelAxes = orientation !== "source";
    let faces;
    let centers;

    if (useModelAxes) {
      const frame = findStableModelFrame(this.getScaledModelVertices());
      const scale = new THREE.Vector3(
        state.model.scale.x,
        state.model.scale.y,
        state.model.scale.z,
      );
      const orientedBounds = createOrientedBoundsPlaneDefinitions(frame, scale);
      faces = orientedBounds.faces;
      centers = orientedBounds.centers;
      this.createOrientedBoundsHelper(orientedBounds.corners);
    } else {
      this.createBoundsHelper();
      faces = [
        {
          label: "Left",
          kind: "face",
          origin: new THREE.Vector3(info.min.x, info.center.y, info.center.z),
          normal: new THREE.Vector3(-1, 0, 0),
          xAxis: new THREE.Vector3(0, 1, 0),
        },
        {
          label: "Right",
          kind: "face",
          origin: new THREE.Vector3(info.max.x, info.center.y, info.center.z),
          normal: new THREE.Vector3(1, 0, 0),
          xAxis: new THREE.Vector3(0, 1, 0),
        },
        {
          label: "Back",
          kind: "face",
          origin: new THREE.Vector3(info.center.x, info.min.y, info.center.z),
          normal: new THREE.Vector3(0, -1, 0),
          xAxis: new THREE.Vector3(1, 0, 0),
        },
        {
          label: "Front",
          kind: "face",
          origin: new THREE.Vector3(info.center.x, info.max.y, info.center.z),
          normal: new THREE.Vector3(0, 1, 0),
          xAxis: new THREE.Vector3(1, 0, 0),
        },
        {
          label: "Bottom",
          kind: "face",
          origin: new THREE.Vector3(info.center.x, info.center.y, info.min.z),
          normal: new THREE.Vector3(0, 0, -1),
          xAxis: new THREE.Vector3(1, 0, 0),
        },
        {
          label: "Top",
          kind: "face",
          origin: new THREE.Vector3(info.center.x, info.center.y, info.max.z),
          normal: new THREE.Vector3(0, 0, 1),
          xAxis: new THREE.Vector3(1, 0, 0),
        },
      ];
      centers = [
        {
          label: "Right Center",
          kind: "center",
          origin: info.center.clone(),
          normal: new THREE.Vector3(1, 0, 0),
          xAxis: new THREE.Vector3(0, 1, 0),
        },
        {
          label: "Front Center",
          kind: "center",
          origin: info.center.clone(),
          normal: new THREE.Vector3(0, 1, 0),
          xAxis: new THREE.Vector3(1, 0, 0),
        },
        {
          label: "Top Center",
          kind: "center",
          origin: info.center.clone(),
          normal: new THREE.Vector3(0, 0, 1),
          xAxis: new THREE.Vector3(1, 0, 0),
        },
      ];
    }

    const definitions = set === "centers" ? centers : faces;
    const cleanPrefix = namePrefix?.trim().replace(/\s+/g, " ");
    const defaultPrefix = useModelAxes ? "Boundary" : "AABB";

    for (const definition of definitions) {
      this.createConstructionPlane(
        {
          name: (cleanPrefix || defaultPrefix) + " " + definition.label,
          method:
            definition.kind === "center"
              ? useModelAxes
                ? "Oriented bounds center"
                : "Source-axis bounds center"
              : useModelAxes
                ? "Oriented boundary face"
                : "Source-axis boundary face",
          origin: definition.origin,
          normal: definition.normal,
          xAxis: definition.xAxis,
          space: "model",
        },
        false,
      );
    }
    this.notifyPlanesChange();
    return definitions.length;
  }

  createAutomaticCenterPlanes(namePrefix) {
    const frame = findStableModelFrame(this.getScaledModelVertices());
    const scale = new THREE.Vector3(
      state.model.scale.x,
      state.model.scale.y,
      state.model.scale.z,
    );
    const definitions = createAutomaticAxisPlaneDefinitions(frame, scale);
    const cleanPrefix = namePrefix?.trim().replace(/\s+/g, " ");

    for (const definition of definitions) {
      this.createConstructionPlane(
        {
          name: cleanPrefix
            ? cleanPrefix + " " + definition.label
            : "Model " + definition.label,
          method: "Automatic principal axes",
          origin: definition.origin,
          normal: definition.normal,
          xAxis: definition.xAxis,
          space: "model",
        },
        false,
      );
    }
    this.notifyPlanesChange();
    return definitions.length;
  }

  createPlaneFromMethod(method, options) {
    const selected = this.selectionReferences;
    const create = (definition) =>
      this.createConstructionPlane({
        name: options.name,
        space: "model",
        ...definition,
      });

    if (method === "bounds") {
      return this.createBoundsPlanes(
        options.boundsSet,
        options.name,
        options.boundsOrientation,
      );
    }
    if (method === "auto-axes") {
      return this.createAutomaticCenterPlanes(options.name);
    }

    if (method === "three-points") {
      const [first, second, third] = selected.map((reference) => reference.point);
      const xAxis = second.clone().sub(first);
      const normal = xAxis.clone().cross(third.clone().sub(first));
      const origin = first.clone().add(second).add(third).multiplyScalar(1 / 3);
      create({ method: "Through 3 Points", origin, normal, xAxis });
    } else if (method === "best-fit") {
      const fitted = fitPlaneToPoints(selected.map((reference) => reference.point));
      create({ method: "Best Fit", ...fitted });
    } else if (method === "planar-surface") {
      const [reference] = selected;
      const fitted = this.fitPlanarSurfaceReference(reference);
      create({ method: "Planar Surface", ...fitted });
    } else if (method === "tangent") {
      const [reference] = selected;
      if (!reference?.normal) {
        throw new Error("Choose a triangle on a mesh surface.");
      }
      create({
        method: "Tangent",
        origin: reference.point,
        normal: reference.normal,
        xAxis: createFallbackAxis(reference.normal),
      });
    } else if (method === "two-edges") {
      const [first, second, third, fourth] = selected.map((reference) => reference.point);
      const firstDirection = second.clone().sub(first);
      const secondDirection = fourth.clone().sub(third);
      const scale = Math.max(firstDirection.length(), secondDirection.length());
      if (scale <= GEOMETRY_EPSILON) throw new Error("Each edge needs two different points.");
      let normal = firstDirection.clone().cross(secondDirection);
      if (normal.length() <= scale * 1e-8) {
        normal = firstDirection.clone().cross(third.clone().sub(first));
      } else {
        const distance = Math.abs(third.clone().sub(first).dot(normal.clone().normalize()));
        if (distance > scale * 1e-4) {
          throw new Error("The selected edges are skew and do not share one plane.");
        }
      }
      const origin = first.clone().add(second).add(third).add(fourth).multiplyScalar(0.25);
      create({ method: "Through 2 Edges", origin, normal, xAxis: firstDirection });
    } else if (method === "along-path") {
      const [first, second] = selected.map((reference) => reference.point);
      const direction = second.clone().sub(first);
      const fraction = THREE.MathUtils.clamp(options.pathPosition / 100, 0, 1);
      const origin = first.clone().lerp(second, fraction);
      create({
        method: "Along Path",
        origin,
        normal: direction,
        xAxis: createFallbackAxis(direction.clone().normalize()),
      });
    } else if (method === "offset") {
      const reference = this.getReferencePlane(options.referenceA);
      create({
        method: "Offset",
        origin: reference.origin.clone().addScaledVector(reference.normal, options.distance),
        normal: reference.normal,
        xAxis: reference.xAxis,
        space: reference.space,
      });
    } else if (method === "midplane") {
      const firstReference = this.getReferencePlane(options.referenceA);
      const secondReference = this.getReferencePlane(options.referenceB);
      const targetSpace =
        firstReference.space === secondReference.space ? firstReference.space : "world";
      const first = this.getPlaneInSpace(firstReference, targetSpace);
      const second = this.getPlaneInSpace(secondReference, targetSpace);
      const alignment = first.normal.dot(second.normal);
      if (Math.abs(alignment) < 0.9999) {
        throw new Error("Midplane requires two parallel reference planes.");
      }
      const signedDistance = second.origin.clone().sub(first.origin).dot(first.normal);
      create({
        method: "Midplane",
        origin: first.origin.clone().addScaledVector(first.normal, signedDistance / 2),
        normal: first.normal,
        xAxis: first.xAxis,
        space: targetSpace,
      });
    } else if (method === "angle") {
      const reference = this.getReferencePlane(options.referenceA);
      const points = this.getSelectedPointsInSpace(reference.space);
      const axis = points[1].clone().sub(points[0]);
      if (axis.lengthSq() <= GEOMETRY_EPSILON ** 2) {
        throw new Error("Choose two different points for the rotation axis.");
      }
      axis.normalize();
      const angle = THREE.MathUtils.degToRad(options.angle);
      create({
        method: "At Angle",
        origin: points[0],
        normal: reference.normal.clone().applyAxisAngle(axis, angle),
        xAxis: reference.xAxis.clone().applyAxisAngle(axis, angle),
        space: reference.space,
      });
    } else if (method === "perpendicular") {
      const reference = this.getReferencePlane(options.referenceA);
      const points = this.getSelectedPointsInSpace(reference.space);
      const line = points[1].clone().sub(points[0]);
      const normal = line.clone().cross(reference.normal);
      create({
        method: "Perpendicular",
        origin: points[0],
        normal,
        xAxis: line,
        space: reference.space,
      });
    } else {
      throw new Error("Choose a construction plane method.");
    }

    this.clearConstructionSelection();
    return 1;
  }

  updateReferenceScale() {
    const bounds = this.localBounds;
    const size = bounds.getSize(new THREE.Vector3());
    const maximumDimension = Math.max(size.x, size.y, size.z, 1);
    this.referenceScale = Math.max(1, getNiceScale(maximumDimension / 8));
    for (const grid of Object.values(this.originPlaneGrids)) {
      grid.group.scale.setScalar(this.referenceScale);
    }
    this.axisGroup.scale.setScalar(this.referenceScale);
    this.originMarker.scale.setScalar(this.referenceScale);
    this.originMarker.position.z = 0.035 * this.referenceScale;
    this.modelShadow.position.z = 0.006 * this.referenceScale;
    if (!state.transformGizmo.gridSnap) {
      state.transformGizmo.gridStep = this.referenceScale;
      this.setTransformGizmoSettings(state.transformGizmo);
      this.onTransformGridStepChange?.(this.referenceScale);
    }
  }

  resize() {
    const width = Math.max(1, Math.round(this.canvas.clientWidth));
    const height = Math.max(1, Math.round(this.canvas.clientHeight));
    const nextCompactLayout = width <= 700;

    this.camera.aspect = width / height;
    if (nextCompactLayout) {
      this.camera.setViewOffset(width, height, 0, Math.round(height * 0.14), width, height);
    } else {
      this.camera.clearViewOffset();
    }
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    if (this.transformControls) {
      this.transformControls.size = nextCompactLayout ? 0.72 : 0.9;
    }

    if (nextCompactLayout !== this.compactLayout) {
      this.compactLayout = nextCompactLayout;
      this.fitView();
    }
  }

  getWorldBounds() {
    this.modelRoot.updateMatrixWorld(true);
    return this.localBounds.clone().applyMatrix4(this.modelRoot.matrixWorld);
  }

  getExactWorldMinimumZ(transform = state.model) {
    if (!this.renderModel) return null;
    const { position, rotation, scale } = transform;
    const modelPosition = new THREE.Vector3(position.x, position.y, position.z);
    const modelRotation = rotation?.isQuaternion
      ? rotation.clone()
      : new THREE.Quaternion().setFromEuler(
          new THREE.Euler(rotation.x, rotation.y, rotation.z, "XYZ"),
        );
    const modelScale = new THREE.Vector3(scale.x, scale.y, scale.z);
    const pivot = this.getLocalBoundsInfo()?.center;
    if (!pivot) return null;
    const rootPosition = calculateRootPositionAroundPivot(
      modelPosition,
      modelRotation,
      modelScale,
      pivot,
    );
    const matrixElements = new THREE.Matrix4()
      .compose(rootPosition, modelRotation, modelScale)
      .elements;
    let minimumZ = Infinity;

    for (const geometry of this.renderModel.modelGeometries) {
      const vertices = geometry.getAttribute("position");
      for (let index = 0; index < vertices.count; index += 1) {
        const worldZ =
          matrixElements[2] * vertices.getX(index) +
          matrixElements[6] * vertices.getY(index) +
          matrixElements[10] * vertices.getZ(index) +
          matrixElements[14];
        minimumZ = Math.min(minimumZ, worldZ);
      }
    }
    return Number.isFinite(minimumZ) ? minimumZ : null;
  }

  syncOrbitTargetToModelCenter() {
    const centerInfo = this.getModelCenterInfo();
    if (!centerInfo) return false;
    this.controls.target.copy(centerInfo.world);
    return true;
  }

  fitView() {
    const bounds = this.getWorldBounds();
    if (bounds.isEmpty()) return;

    const boundsSphere = bounds.getBoundingSphere(new THREE.Sphere());
    const center = this.getModelCenterInfo()?.world || boundsSphere.center;
    const radius = Math.max(
      boundsSphere.radius + boundsSphere.center.distanceTo(center),
      MIN_MODEL_RADIUS,
    );
    const verticalFov = THREE.MathUtils.degToRad(this.camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * this.camera.aspect);
    const limitingHalfFov = Math.min(verticalFov, horizontalFov) / 2;
    const fillFraction = this.compactLayout ? 0.74 : 0.42;
    const distance = radius / Math.sin(limitingHalfFov * fillFraction);

    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(DEFAULT_VIEW_DIRECTION, distance);
    this.camera.near = Math.max(distance / 10000, 0.001);
    this.camera.far = Math.max(distance * 100, 100);
    this.camera.updateProjectionMatrix();

    this.controls.minDistance = Math.max(radius * 0.12, 0.01);
    this.controls.maxDistance = Math.max(distance * 12, 40);
    this.controls.update();
  }

  zoom(direction) {
    if (direction === "in") {
      this.controls.dollyIn(1.22);
    } else {
      this.controls.dollyOut(1.22);
    }
    this.controls.update();
  }

  setOriginPlaneVisible(plane, visible) {
    const grid = this.originPlaneGrids[plane];
    if (!grid) return;
    grid.group.visible = visible;
    if (plane === "top") this.modelShadow.visible = visible;
    if (
      !visible &&
      this.alignmentPlanePicking.hovered?.kind === "target" &&
      this.alignmentPlanePicking.hovered.id === grid.targetId
    ) {
      this.setAlignmentPlaneHover(null);
    } else {
      this.updateAlignmentPlaneVisuals();
    }
  }

  setDisplayMode(mode) {
    if (!this.renderModel) return;

    this.renderModel.surfaceGroup.visible = mode !== "edges";
    this.renderModel.vertexGroup.visible = mode === "vertices";
    this.renderModel.pointCloudGroup.visible = true;
    this.renderModel.edgeGroup.visible = true;

    for (const material of this.renderModel.surfaceMaterials) {
      material.transparent = mode === "vertices";
      material.opacity = mode === "vertices" ? 0.14 : 1;
      material.depthWrite = mode !== "vertices";
      material.needsUpdate = true;
    }

    const edgeOpacity = mode === "mesh" ? 0.4 : mode === "vertices" ? 0.58 : 0.9;
    for (const material of this.renderModel.edgeMaterials) {
      material.opacity = edgeOpacity;
    }
  }

  updateShadow() {
    const bounds = this.getWorldBounds();
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    for (const grid of Object.values(this.originPlaneGrids)) {
      grid.group.position.set(0, 0, 0);
    }
    this.modelShadow.position.x = center.x;
    this.modelShadow.position.y = center.y;
    this.modelShadow.scale.set(
      Math.max(size.x * 0.78, this.referenceScale * 0.22),
      Math.max(size.y * 0.78, this.referenceScale * 0.22),
      1,
    );
  }

  applyTransform(syncTransformGizmo = true, syncOrbitTarget = true) {
    const { position, rotation, scale } = state.model;
    this.modelRoot.rotation.set(rotation.x, rotation.y, rotation.z, "XYZ");
    this.modelRoot.scale.set(scale.x, scale.y, scale.z);
    const pivot = this.getLocalBoundsInfo()?.center || new THREE.Vector3();
    const modelPosition = new THREE.Vector3(position.x, position.y, position.z);
    this.modelRoot.position.copy(
      calculateRootPositionAroundPivot(
        modelPosition,
        this.modelRoot.quaternion,
        this.modelRoot.scale,
        pivot,
      ),
    );
    if (syncTransformGizmo) this.syncTransformGizmoFromModel();
    if (syncOrbitTarget) this.syncOrbitTargetToModelCenter();
    this.updateModelCenterMarker();
    this.updateShadow();
    this.notifyModelCenterChange();
  }

  updateTheme() {
    const rootStyle = getComputedStyle(document.documentElement);
    const value = (name) => rootStyle.getPropertyValue(name).trim();
    const darkTheme = document.documentElement.dataset.theme === "dark";
    const background = value("--canvas-background");

    this.scene.background = new THREE.Color().setStyle(background);
    this.renderer.setClearColor(background, 1);

    if (this.renderModel) {
      for (const material of this.renderModel.surfaceMaterials) {
        material.color.setStyle(material.userData.usesVertexColors ? "#ffffff" : value("--cube-mid"));
      }
      for (const material of this.renderModel.pointMaterials) {
        material.color.setStyle(material.userData.usesVertexColors ? "#ffffff" : value("--accent"));
      }
      for (const material of this.renderModel.edgeMaterials) {
        material.color.set(darkTheme ? 0xe4e4e4 : 0x555555);
      }
    }

    this.shadowMaterial.opacity = darkTheme ? 0.24 : 0.1;
    this.hemisphereLight.groundColor.set(darkTheme ? 0x5f5f5f : 0x858585);
    this.originMaterial.color.set(0xffffff);
    this.modelCenterCoreMaterial.color.setStyle(value("--accent"));
    this.modelCenterHaloMaterial.color.set(darkTheme ? 0xf5f5f5 : 0x252525);

    if (this.boundsHelper) this.boundsHelper.material.color.setStyle(value("--accent"));
    this.updateAlignmentPlaneVisuals();
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

let viewport = null;
try {
  viewport = new ThreeViewport(canvas);
} catch (error) {
  console.error(error);
  canvas.setAttribute("aria-label", "WebGL is unavailable in this browser");
  showToast("WebGL 2 is required to display the 3D viewport.");
}

const HISTORY_LIMIT = 100;
const undoButton = document.querySelector("#undoButton");
const redoButton = document.querySelector("#redoButton");
const historyPanelToggle = document.querySelector("#historyPanelToggle");
const historyPanelBody = document.querySelector("#historyPanelBody");
const historyPosition = document.querySelector("#historyPosition");
const historyList = document.querySelector("#historyList");
let historyLocked = false;
let pendingTransformEdit = null;
let pendingTransformGizmoEdit = null;
let transformGizmoDragging = false;

class EditHistory {
  constructor(capture, restore, onChange, initialLabel = "Initial state") {
    this.capture = capture;
    this.restore = restore;
    this.onChange = onChange;
    this.initialState = this.capture();
    this.initialLabel = initialLabel;
    this.undoStack = [];
    this.redoStack = [];
  }

  get undoLabel() {
    return this.undoStack.at(-1)?.label || null;
  }

  get redoLabel() {
    return this.redoStack.at(-1)?.label || null;
  }

  get entries() {
    return [...this.undoStack, ...this.redoStack.slice().reverse()];
  }

  get currentIndex() {
    return this.undoStack.length;
  }

  get timeline() {
    return [
      { label: this.initialLabel, initial: true },
      ...this.entries.map((entry) => ({ label: entry.label, initial: false })),
    ];
  }

  record(label, beforeState) {
    const afterState = this.capture();
    if (JSON.stringify(beforeState) === JSON.stringify(afterState)) return false;
    this.undoStack.push({ label, beforeState, afterState });
    if (this.undoStack.length > HISTORY_LIMIT) {
      const expiredEntry = this.undoStack.shift();
      this.initialState = expiredEntry.afterState;
      this.initialLabel = expiredEntry.label;
    }
    this.redoStack = [];
    this.onChange();
    return true;
  }

  undo() {
    const entry = this.undoStack.at(-1);
    if (!entry) return null;
    this.restore(entry.beforeState);
    this.undoStack.pop();
    this.redoStack.push(entry);
    this.onChange();
    return entry.label;
  }

  redo() {
    const entry = this.redoStack.at(-1);
    if (!entry) return null;
    this.restore(entry.afterState);
    this.redoStack.pop();
    this.undoStack.push(entry);
    this.onChange();
    return entry.label;
  }

  goTo(index) {
    const targetIndex = Number.parseInt(index, 10);
    const entries = this.entries;
    if (
      !Number.isInteger(targetIndex) ||
      targetIndex < 0 ||
      targetIndex > entries.length ||
      targetIndex === this.currentIndex
    ) {
      return null;
    }

    const snapshot =
      targetIndex === 0 ? this.initialState : entries[targetIndex - 1].afterState;
    const result = {
      direction: targetIndex < this.currentIndex ? "backward" : "forward",
      index: targetIndex,
      label: targetIndex === 0 ? this.initialLabel : entries[targetIndex - 1].label,
    };
    this.restore(snapshot);
    this.undoStack = entries.slice(0, targetIndex);
    this.redoStack = entries.slice(targetIndex).reverse();
    this.onChange();
    return result;
  }

  reset(initialLabel = "Initial state") {
    this.initialState = this.capture();
    this.initialLabel = initialLabel;
    this.undoStack = [];
    this.redoStack = [];
    this.onChange();
  }
}

function captureEditState() {
  return {
    model: {
      position: { ...state.model.position },
      rotation: { ...state.model.rotation },
      scale: { ...state.model.scale },
    },
    planes: (viewport?.constructionPlanes || []).map((plane) => ({
      id: plane.id,
      name: plane.name,
      method: plane.method,
      origin: { x: plane.origin.x, y: plane.origin.y, z: plane.origin.z },
      normal: { x: plane.normal.x, y: plane.normal.y, z: plane.normal.z },
      xAxis: { x: plane.xAxis.x, y: plane.xAxis.y, z: plane.xAxis.z },
      space: plane.space,
      color: plane.color,
      visible: plane.visible,
    })),
    boundsHelperMode: viewport?.boundsHelperMode || null,
  };
}

function restoreEditState(snapshot) {
  state.model.position = { ...snapshot.model.position };
  state.model.rotation = { ...snapshot.model.rotation };
  state.model.scale = { ...snapshot.model.scale };
  writeTransformInputs();
  viewport?.applyTransform();
  viewport?.restoreConstructionPlanes(snapshot.planes, snapshot.boundsHelperMode);
  updateBoundsReadout();
}

function getHistoryIconId(label, isInitial) {
  if (isInitial) return "icon-import";
  const normalizedLabel = label.toLowerCase();
  if (/(rotate|align|lay)/.test(normalizedLabel)) return "icon-rotate";
  if (normalizedLabel.includes("plane")) return "icon-plane";
  if (/(position|move|drop|center)/.test(normalizedLabel)) return "icon-move";
  if (normalizedLabel.includes("scale")) return "icon-cube";
  return "icon-history";
}

function renderHistoryPanel() {
  const timeline = editHistory.timeline;
  const currentIndex = editHistory.currentIndex;
  const totalEdits = timeline.length - 1;
  const navigationLocked = historyLocked || transformGizmoDragging;
  historyPosition.textContent = currentIndex + " / " + totalEdits;
  historyPosition.title =
    currentIndex + " applied of " + totalEdits + " available history edits";
  historyList.replaceChildren();

  let currentEntry = null;
  timeline.forEach((item, index) => {
    const isCurrent = index === currentIndex;
    const isFuture = index > currentIndex;
    const button = document.createElement("button");
    button.className =
      "history-entry" +
      (isCurrent ? " is-current" : "") +
      (isFuture ? " is-future" : "");
    button.type = "button";
    button.dataset.historyIndex = String(index);
    button.disabled = navigationLocked;
    button.title = item.label;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(isCurrent));
    button.setAttribute("aria-posinset", String(index + 1));
    button.setAttribute("aria-setsize", String(timeline.length));
    if (isCurrent) {
      button.setAttribute("aria-current", "step");
      currentEntry = button;
    }

    const marker = document.createElement("span");
    marker.className = "history-entry-marker";
    marker.setAttribute("aria-hidden", "true");

    const icon = document.createElement("span");
    icon.className = "history-entry-icon";
    icon.innerHTML =
      '<svg class="icon" aria-hidden="true"><use href="#' +
      getHistoryIconId(item.label, item.initial) +
      '"></use></svg>';

    const copy = document.createElement("span");
    copy.className = "history-entry-copy";
    const name = document.createElement("strong");
    name.textContent = item.label;
    const detail = document.createElement("small");
    detail.textContent = isCurrent
      ? "Current state"
      : isFuture
        ? "Redo available"
        : item.initial
          ? "History start"
          : "Step " + index;
    copy.append(name, detail);
    button.append(marker, icon, copy);
    historyList.append(button);
  });

  if (currentEntry && !historyPanelBody.hidden) {
    window.requestAnimationFrame(() => {
      const entryTop = currentEntry.offsetTop;
      const entryBottom = entryTop + currentEntry.offsetHeight;
      if (entryTop < historyList.scrollTop) {
        historyList.scrollTop = entryTop;
      } else if (entryBottom > historyList.scrollTop + historyList.clientHeight) {
        historyList.scrollTop = entryBottom - historyList.clientHeight;
      }
    });
  }
}

function updateHistoryUi() {
  const undoLabel = editHistory?.undoLabel;
  const redoLabel = editHistory?.redoLabel;
  const canUndo = Boolean(undoLabel) && !historyLocked && !transformGizmoDragging;
  const canRedo = Boolean(redoLabel) && !historyLocked && !transformGizmoDragging;
  undoButton.disabled = !canUndo;
  redoButton.disabled = !canRedo;
  undoButton.title = canUndo ? "Undo " + undoLabel + " (Ctrl+Z)" : "Nothing to undo";
  redoButton.title = canRedo ? "Redo " + redoLabel + " (Ctrl+Y)" : "Nothing to redo";
  undoButton.setAttribute("aria-label", canUndo ? "Undo " + undoLabel : "Nothing to undo");
  redoButton.setAttribute("aria-label", canRedo ? "Redo " + redoLabel : "Nothing to redo");
  renderHistoryPanel();
}

const editHistory = new EditHistory(
  captureEditState,
  restoreEditState,
  updateHistoryUi,
  "Demo model",
);

function recordEdit(label, beforeState) {
  return editHistory.record(label, beforeState);
}

function commitPendingTransformEdit() {
  if (!pendingTransformEdit) return false;
  const { label, beforeState } = pendingTransformEdit;
  pendingTransformEdit = null;
  return recordEdit(label, beforeState);
}

function prepareForHistoryNavigation() {
  if (!layFlatWorkbench.hidden) {
    closeLayFlatWorkbench();
    clearActiveToolSection();
  }
  if (alignmentPreviewSession) {
    closeAlignmentWorkbenches(true);
    clearActiveToolSection();
  }
  commitPendingTransformEdit();
}

function undoLastEdit() {
  if (historyLocked || transformGizmoDragging) return;
  prepareForHistoryNavigation();
  const label = editHistory.undo();
  if (label) showToast("Undid " + label + ".");
}

function redoLastEdit() {
  if (historyLocked || transformGizmoDragging) return;
  prepareForHistoryNavigation();
  const label = editHistory.redo();
  if (label) showToast("Redid " + label + ".");
}

function jumpToHistoryState(index) {
  if (historyLocked || transformGizmoDragging) return;
  prepareForHistoryNavigation();
  const result = editHistory.goTo(index);
  if (result) showToast("Restored " + result.label + ".");
}

function getHistoryEventButton(event) {
  const target = event.target instanceof Element ? event.target : null;
  return target?.closest("[data-history-index]") || null;
}

function setHistoryPanelCollapsed(isCollapsed) {
  historyPanelBody.hidden = isCollapsed;
  historyPanelToggle.setAttribute("aria-expanded", String(!isCollapsed));
  historyPanelToggle.setAttribute(
    "aria-label",
    (isCollapsed ? "Expand" : "Collapse") + " transform history",
  );
  historyPanelToggle.title =
    (isCollapsed ? "Expand" : "Collapse") + " transform history";
  if (!isCollapsed) renderHistoryPanel();
}

function resetEditHistory(initialLabel = "Initial state") {
  pendingTransformEdit = null;
  pendingTransformGizmoEdit = null;
  transformGizmoDragging = false;
  editHistory.reset(initialLabel);
}

undoButton.addEventListener("click", undoLastEdit);
redoButton.addEventListener("click", redoLastEdit);
historyPanelToggle.addEventListener("click", () => {
  setHistoryPanelCollapsed(!historyPanelBody.hidden);
});
historyList.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  const button = getHistoryEventButton(event);
  if (!button || button.disabled) return;
  event.preventDefault();
  jumpToHistoryState(button.dataset.historyIndex);
});
historyList.addEventListener("click", (event) => {
  if (event.detail !== 0) return;
  const button = getHistoryEventButton(event);
  if (!button || button.disabled) return;
  jumpToHistoryState(button.dataset.historyIndex);
});
setHistoryPanelCollapsed(window.matchMedia("(max-width: 700px)").matches);
updateHistoryUi();

function applyTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  const themeToggle = document.querySelector("#themeToggle");
  const nextTheme = theme === "dark" ? "light" : "dark";
  themeToggle.setAttribute("aria-label", "Switch to " + nextTheme + " theme");
  document.querySelector('meta[name="theme-color"]').content =
    theme === "dark" ? "#484848" : "#a5a4a0";
  if (persist) localStorage.setItem("mesh-to-zero-theme", theme);
  viewport?.updateTheme();
}

document.querySelector("#themeToggle").addEventListener("click", () => {
  const currentTheme = document.documentElement.dataset.theme;
  applyTheme(currentTheme === "dark" ? "light" : "dark");
});

const themePreference = window.matchMedia("(prefers-color-scheme: dark)");
themePreference.addEventListener("change", (event) => {
  if (!localStorage.getItem("mesh-to-zero-theme")) {
    applyTheme(event.matches ? "dark" : "light", false);
  }
});

const leftRail = document.querySelector(".left-rail");
const toolPanel = document.querySelector("#toolPanel");
const sectionButtons = [...document.querySelectorAll("[data-section]")];
sectionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setPressedState(sectionButtons, button);
    const section = button.dataset.section;
    if (section === "rotation") {
      openRotationWorkbench();
      return;
    }
    if (section === "level") {
      openLevelWorkbench();
      return;
    }
    if (section === "lay-flat") {
      openLayFlatWorkbench();
    }
  });
});

const displayButtons = [...document.querySelectorAll("[data-display-mode]")];

function selectDisplayMode(mode) {
  const activeButton = displayButtons.find((button) => button.dataset.displayMode === mode);
  if (!activeButton || activeButton.disabled) return;
  state.displayMode = mode;
  setPressedState(displayButtons, activeButton);
  viewport?.setDisplayMode(mode);
}

function setSurfaceDisplayModesAvailable(isAvailable) {
  for (const button of displayButtons) {
    const requiresSurface = button.dataset.displayMode !== "vertices";
    button.disabled = requiresSurface && !isAvailable;
    if (button.disabled) {
      button.title = "Unavailable for point clouds";
    } else {
      button.removeAttribute("title");
    }
  }

  if (!isAvailable) selectDisplayMode("vertices");
}

displayButtons.forEach((button) => {
  button.addEventListener("click", () => {
    selectDisplayMode(button.dataset.displayMode);
  });
});

const navigationHelp = {
  orbit: "Orbit: hold the middle mouse button and drag.",
  pan: "Pan: hold the right mouse button and drag.",
};

document.querySelectorAll("[data-view-help]").forEach((button) => {
  button.addEventListener("click", () => {
    showToast(navigationHelp[button.dataset.viewHelp]);
  });
});

document.querySelectorAll("[data-view-action]").forEach((button) => {
  button.addEventListener("click", () => {
    const action = button.dataset.viewAction;
    if (action === "zoom-in") viewport?.zoom("in");
    if (action === "zoom-out") viewport?.zoom("out");
    if (action === "fit") viewport?.fitView();
  });
});

const PLANE_MODES = {
  automatic: {
    label: "Automatic",
    description: "Create planes from the complete model automatically.",
    defaultMethod: "auto-axes",
  },
  manual: {
    label: "Manual",
    description: "Create one plane from points, surfaces, edges, or existing planes.",
    defaultMethod: "three-points",
  },
};

const PLANE_METHODS = {
  "three-points": {
    mode: "manual",
    description: "Creates an exact plane through three non-collinear model vertices.",
    instruction: "Pick three vertices or use Model center as one point.",
    minimum: 3,
    maximum: 3,
  },
  "best-fit": {
    mode: "manual",
    description: "Fits a least-squares plane to three or more mesh or point-cloud vertices.",
    instruction: "Pick at least three references; Model center can be included.",
    minimum: 3,
    maximum: 32,
  },
  "planar-surface": {
    mode: "manual",
    description: "Detects and fits the locally flat area around one mesh or point-cloud sample.",
    instruction: "Click a flat area away from edges; nearby points are collected automatically.",
    minimum: 1,
    maximum: 1,
  },
  tangent: {
    mode: "manual",
    description: "Creates a plane at the picked triangle using that face normal.",
    instruction: "Left-click a triangle on a surface mesh.",
    minimum: 1,
    maximum: 1,
  },
  "two-edges": {
    mode: "manual",
    description: "Creates one plane through two coplanar edges defined by four vertices.",
    instruction: "Pick both endpoints of the first edge, then both endpoints of the second.",
    minimum: 4,
    maximum: 4,
  },
  "along-path": {
    mode: "manual",
    description: "Creates a plane normal to a two-point path at a chosen position.",
    instruction: "Pick the start and end vertices of the path.",
    minimum: 2,
    maximum: 2,
    pathPosition: true,
  },
  offset: {
    mode: "manual",
    description: "Copies a reference plane at an exact signed distance.",
    instruction: "Choose a reference plane and enter the offset distance.",
    minimum: 0,
    maximum: 0,
    referenceA: true,
    distance: true,
  },
  angle: {
    mode: "manual",
    description: "Rotates a reference plane around an axis defined by two model vertices.",
    instruction: "Pick two vertices for the rotation axis.",
    minimum: 2,
    maximum: 2,
    referenceA: true,
    angle: true,
  },
  midplane: {
    mode: "manual",
    description: "Creates a plane exactly halfway between two parallel reference planes.",
    instruction: "Choose two parallel planes.",
    minimum: 0,
    maximum: 0,
    referenceA: true,
    referenceB: true,
  },
  perpendicular: {
    mode: "manual",
    description: "Creates a plane through a picked line and perpendicular to a reference plane.",
    instruction: "Pick two vertices that define the line contained by the new plane.",
    minimum: 2,
    maximum: 2,
    referenceA: true,
  },
  bounds: {
    mode: "automatic",
    description: "Creates planes on the six extreme faces of an oriented model boundary box, with source-axis AABB as an option.",
    instruction: "No picking required. Choose the box orientation, then create either boundary faces or center planes.",
    minimum: 0,
    maximum: 0,
    boundsSet: true,
  },
  "auto-axes": {
    mode: "automatic",
    description: "Finds stable principal axes from the full model, with an oriented-bounds fallback for ambiguous dimensions.",
    instruction: "No picking required. Longest → Right, middle → Front, shortest → Top; all intersect at the oriented-bounds center.",
    minimum: 0,
    maximum: 0,
  },
};

const planeButton = document.querySelector("#planeButton");
const planeWorkbench = document.querySelector("#planeWorkbench");
const closePlaneWorkbenchButton = document.querySelector("#closePlaneWorkbench");
const layFlatButton = document.querySelector("#layFlatButton");
const dropToBedButton = document.querySelector("#dropToBedButton");
const layFlatWorkbench = document.querySelector("#layFlatWorkbench");
const closeLayFlatWorkbenchButton = document.querySelector("#closeLayFlatWorkbench");
const cancelLayFlatButton = document.querySelector("#cancelLayFlat");
const layFlatSelectionStatus = document.querySelector("#layFlatSelectionStatus");
const layFlatSelectionHint = document.querySelector("#layFlatSelectionHint");
const originPlaneButtons = [...document.querySelectorAll("[data-origin-plane]")];
const modelCenterVisibilityButton = document.querySelector("#modelCenterVisibility");
const useModelCenterButton = document.querySelector("#useModelCenter");
const modelCenterLocal = document.querySelector("#modelCenterLocal");
const modelCenterWorld = document.querySelector("#modelCenterWorld");
const modelCenterSection = document.querySelector("#modelCenterSection");
const planeModeButtons = [...document.querySelectorAll("[data-plane-mode]")];
const planeModePanels = [...document.querySelectorAll("[data-plane-mode-panel]")];
const planeModeDescription = document.querySelector("#planeModeDescription");
const planeMethodGroupLabel = document.querySelector("#planeMethodGroupLabel");
const planeMethodButtons = [...document.querySelectorAll("[data-plane-method]")];
const planeMethodDescription = document.querySelector("#planeMethodDescription");
const referenceAField = document.querySelector("#referenceAField");
const referenceBField = document.querySelector("#referenceBField");
const distanceField = document.querySelector("#distanceField");
const angleField = document.querySelector("#angleField");
const pathPositionField = document.querySelector("#pathPositionField");
const boundsOrientationField = document.querySelector("#boundsOrientationField");
const boundsSetField = document.querySelector("#boundsSetField");
const planeReferenceA = document.querySelector("#planeReferenceA");
const planeReferenceB = document.querySelector("#planeReferenceB");
const planeDistance = document.querySelector("#planeDistance");
const planeAngle = document.querySelector("#planeAngle");
const pathPosition = document.querySelector("#pathPosition");
const boundsOrientation = document.querySelector("#boundsOrientation");
const boundsPlaneSet = document.querySelector("#boundsPlaneSet");
const planeNameInput = document.querySelector("#planeName");
const referenceSelection = document.querySelector("#referenceSelection");
const selectionCount = document.querySelector("#selectionCount");
const selectionInstruction = document.querySelector("#selectionInstruction");
const selectionDots = document.querySelector("#selectionDots");
const clearPlaneSelectionButton = document.querySelector("#clearPlaneSelection");
const boundsReadout = document.querySelector("#boundsReadout");
const boundsCenter = document.querySelector("#boundsCenter");
const boundsSize = document.querySelector("#boundsSize");
const createPlaneButton = document.querySelector("#createPlaneButton");
const createdPlaneList = document.querySelector("#createdPlaneList");
const clearCreatedPlanesButton = document.querySelector("#clearCreatedPlanes");
const rotationWorkbench = document.querySelector("#rotationWorkbench");
const closeRotationWorkbenchButton = document.querySelector("#closeRotationWorkbench");
const rotationAnalysisStatus = document.querySelector("#rotationAnalysisStatus");
const rotationAnalysisText = document.querySelector("#rotationAnalysisText");
const orientationResults = document.querySelector("#orientationResults");
const orientationCandidateList = document.querySelector("#orientationCandidateList");
const analyzeOrientationButton = document.querySelector("#analyzeOrientation");
const recalculateOrientationButton = document.querySelector("#recalculateOrientation");
const turnOrientationButton = document.querySelector("#turnOrientation");
const applyOrientationButton = document.querySelector("#applyOrientation");
const cancelOrientationButton = document.querySelector("#cancelOrientation");
const levelWorkbench = document.querySelector("#levelWorkbench");
const closeLevelWorkbenchButton = document.querySelector("#closeLevelWorkbench");
const levelEmptyState = document.querySelector("#levelEmptyState");
const levelControls = document.querySelector("#levelControls");
const levelSourcePlane = document.querySelector("#levelSourcePlane");
const levelTargetPlane = document.querySelector("#levelTargetPlane");
const levelAlignmentSummary = document.querySelector("#levelAlignmentSummary");
const openPlaneForLevelButton = document.querySelector("#openPlaneForLevel");
const flipLevelNormalButton = document.querySelector("#flipLevelNormal");
const turnLevelDirectionButton = document.querySelector("#turnLevelDirection");
const applyLevelButton = document.querySelector("#applyLevel");
const cancelLevelButton = document.querySelector("#cancelLevel");
const activePlaneMethods = Object.fromEntries(
  Object.entries(PLANE_MODES).map(([mode, config]) => [mode, config.defaultMethod]),
);
let activePlaneMode = "automatic";
let activePlaneMethod = activePlaneMethods[activePlaneMode];
let selectedReferenceCount = 0;
let alignmentPreviewSession = null;
let automaticOrientationCandidates = [];
let selectedOrientationCandidate = null;
let orientationQuarterTurns = 0;
let orientationAnalysisSequence = 0;
let levelNormalFlipped = false;
let levelQuarterTurns = 0;
let layFlatApplying = false;

function formatPointCoordinates(point) {
  return (
    "X " +
    formatCoordinate(point.x) +
    " · Y " +
    formatCoordinate(point.y) +
    " · Z " +
    formatCoordinate(point.z)
  );
}

function updateModelCenterUi(info = viewport?.getModelCenterInfo()) {
  if (!info) {
    modelCenterLocal.textContent = "Unavailable";
    modelCenterWorld.textContent = "Unavailable";
    useModelCenterButton.disabled = true;
    return;
  }

  modelCenterLocal.textContent = formatPointCoordinates(info.local);
  modelCenterWorld.textContent = formatPointCoordinates(info.world);
  modelCenterVisibilityButton.classList.toggle("is-hidden", !state.modelCenterVisible);
  modelCenterVisibilityButton.setAttribute("aria-pressed", String(state.modelCenterVisible));
  modelCenterVisibilityButton.setAttribute(
    "aria-label",
    (state.modelCenterVisible ? "Hide" : "Show") + " model center",
  );

  const method = PLANE_METHODS[activePlaneMethod];
  const tolerance = viewport.getConstructionVisualScale() * 1e-7;
  const isSelected = viewport.selectionReferences.some(
    (reference) => reference.point.distanceTo(info.local) <= tolerance,
  );
  const canUse =
    !planeWorkbench.hidden &&
    method.maximum > 0 &&
    !["tangent", "planar-surface"].includes(activePlaneMethod) &&
    selectedReferenceCount < method.maximum &&
    !isSelected;
  useModelCenterButton.disabled = !canUse;
  useModelCenterButton.querySelector("span").textContent = isSelected
    ? "Point selected"
    : "Use as point";
}

function updateLeftRailWorkbench() {
  const activeLabel = !planeWorkbench.hidden
    ? "Create plane tools"
    : !layFlatWorkbench.hidden
      ? "Lay Flat tools"
      : !rotationWorkbench.hidden
        ? "Rotate to axes tools"
        : !levelWorkbench.hidden
          ? "Align and level tools"
          : null;
  const isWorkbenchOpen = Boolean(activeLabel);
  leftRail.classList.toggle("is-workbench-mode", isWorkbenchOpen);
  leftRail.setAttribute("aria-label", activeLabel || "Model tools");
  toolPanel.hidden = isWorkbenchOpen;
}

function setPlaneWorkbenchOpen(isOpen) {
  if (isOpen) {
    closeLayFlatWorkbench();
    closeAlignmentWorkbenches(true);
    setPressedState(sectionButtons, null);
  }
  planeWorkbench.hidden = !isOpen;
  planeButton.classList.toggle("is-active", isOpen);
  planeButton.setAttribute("aria-expanded", String(isOpen));
  updateLeftRailWorkbench();
  const method = PLANE_METHODS[activePlaneMethod];
  viewport?.configureConstructionSelection(isOpen, activePlaneMethod, method.maximum);
  if (!isOpen) viewport?.clearConstructionSelection();
  updateTransformGizmoVisibility();
  updateModelCenterUi();
}

function populatePlaneReferences() {
  if (!viewport) return;
  const references = viewport.getReferencePlanes();
  for (const select of [planeReferenceA, planeReferenceB]) {
    const previousValue = select.value;
    select.replaceChildren();
    for (const plane of references) {
      const option = document.createElement("option");
      option.value = plane.id;
      option.textContent = plane.name;
      select.append(option);
    }
    if (references.some((plane) => plane.id === previousValue)) select.value = previousValue;
  }
  if (planeReferenceB.value === planeReferenceA.value && references.length > 1) {
    planeReferenceB.value = references[1].id;
  }
}

function updateBoundsReadout() {
  const info = viewport?.getLocalBoundsInfo();
  if (!info) return;
  boundsCenter.textContent =
    "X " +
    formatCoordinate(info.center.x) +
    " · Y " +
    formatCoordinate(info.center.y) +
    " · Z " +
    formatCoordinate(info.center.z);
  boundsSize.textContent =
    "X " +
    formatCoordinate(info.size.x) +
    " · Y " +
    formatCoordinate(info.size.y) +
    " · Z " +
    formatCoordinate(info.size.z);
}

function updatePlaneCreateState() {
  const method = PLANE_METHODS[activePlaneMethod];
  const hasEnoughReferences = selectedReferenceCount >= method.minimum;
  createPlaneButton.disabled = !viewport || !hasEnoughReferences;
}

function updateSelectionUi(references = []) {
  selectedReferenceCount = references.length;
  const method = PLANE_METHODS[activePlaneMethod];
  if (method.maximum === 0) {
    selectionCount.textContent = "No model points required";
  } else if (activePlaneMethod === "best-fit") {
    selectionCount.textContent = selectedReferenceCount + " / 3+ points";
  } else {
    selectionCount.textContent =
      selectedReferenceCount + " / " + method.maximum + (method.maximum === 1 ? " point" : " points");
  }
  selectionDots.replaceChildren();
  for (let index = 0; index < selectedReferenceCount; index += 1) {
    const dot = document.createElement("span");
    dot.className = "selection-dot";
    selectionDots.append(dot);
  }
  clearPlaneSelectionButton.disabled = selectedReferenceCount === 0;
  updatePlaneCreateState();
  updateModelCenterUi();
}

function renderCreatedPlanes(planes = []) {
  createdPlaneList.replaceChildren();
  clearCreatedPlanesButton.disabled = planes.length === 0;
  if (!planes.length) {
    const empty = document.createElement("p");
    empty.className = "empty-planes";
    empty.textContent = "No construction planes yet.";
    createdPlaneList.append(empty);
    populatePlaneReferences();
    populateAlignmentPlaneReferences();
    return;
  }

  for (const plane of planes) {
    const row = document.createElement("div");
    row.className = "created-plane-row";

    const color = document.createElement("span");
    color.className = "plane-color";
    color.style.setProperty("--plane-color", plane.color);

    const copy = document.createElement("span");
    copy.className = "plane-row-copy";
    const name = document.createElement("strong");
    name.textContent = plane.name;
    const detail = document.createElement("small");
    detail.textContent = plane.method + " · " + plane.space;
    copy.append(name, detail);

    const visibilityButton = document.createElement("button");
    visibilityButton.className = "plane-row-action" + (plane.visible ? "" : " is-hidden");
    visibilityButton.type = "button";
    visibilityButton.setAttribute(
      "aria-label",
      (plane.visible ? "Hide " : "Show ") + plane.name,
    );
    visibilityButton.innerHTML =
      '<svg class="icon" aria-hidden="true"><use href="#icon-eye"></use></svg>';
    visibilityButton.addEventListener("click", () => {
      const beforeState = captureEditState();
      viewport?.setConstructionPlaneVisible(plane.id, !plane.visible);
      recordEdit((plane.visible ? "Show " : "Hide ") + plane.name, beforeState);
    });

    const deleteButton = document.createElement("button");
    deleteButton.className = "plane-row-action";
    deleteButton.type = "button";
    deleteButton.setAttribute("aria-label", "Delete " + plane.name);
    deleteButton.innerHTML =
      '<svg class="icon" aria-hidden="true"><use href="#icon-trash"></use></svg>';
    deleteButton.addEventListener("click", () => {
      const beforeState = captureEditState();
      viewport?.deleteConstructionPlane(plane.id);
      recordEdit("Delete " + plane.name, beforeState);
    });

    row.append(color, copy, visibilityButton, deleteButton);
    createdPlaneList.append(row);
  }
  populatePlaneReferences();
  populateAlignmentPlaneReferences();
}

function updatePlaneMethodUi() {
  const method = PLANE_METHODS[activePlaneMethod];
  planeMethodDescription.textContent = method.description;
  selectionInstruction.textContent = method.instruction;
  referenceAField.hidden = !method.referenceA;
  referenceBField.hidden = !method.referenceB;
  distanceField.hidden = !method.distance;
  angleField.hidden = !method.angle;
  pathPositionField.hidden = !method.pathPosition;
  boundsOrientationField.hidden = !method.boundsSet;
  boundsSetField.hidden = !method.boundsSet;
  referenceSelection.hidden = method.maximum === 0;
  boundsReadout.hidden = !method.boundsSet || boundsOrientation.value !== "source";
  createPlaneButton.querySelector("span").textContent =
    activePlaneMethod === "bounds"
      ? "Create Boundary Planes"
      : activePlaneMethod === "auto-axes"
        ? "Analyze & Create 3 Planes"
        : "Create Plane";
  if (method.boundsSet) updateBoundsReadout();
  viewport?.configureConstructionSelection(
    !planeWorkbench.hidden,
    activePlaneMethod,
    method.maximum,
  );
  updateSelectionUi(viewport?.selectionReferences || []);
}

function updatePlaneModeUi() {
  const mode = PLANE_MODES[activePlaneMode];
  activePlaneMethod = activePlaneMethods[activePlaneMode];
  planeModeDescription.textContent = mode.description;
  planeMethodGroupLabel.textContent = mode.label + " methods";
  modelCenterSection.hidden = activePlaneMode !== "manual";

  for (const button of planeModeButtons) {
    const isActive = button.dataset.planeMode === activePlaneMode;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }
  for (const panel of planeModePanels) {
    panel.hidden = panel.dataset.planeModePanel !== activePlaneMode;
  }
  for (const button of planeMethodButtons) {
    const isActive = button.dataset.planeMethod === activePlaneMethod;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }

  viewport?.clearConstructionSelection();
  updatePlaneMethodUi();
}

planeButton.addEventListener("click", () => setPlaneWorkbenchOpen(planeWorkbench.hidden));
closePlaneWorkbenchButton.addEventListener("click", () => setPlaneWorkbenchOpen(false));

originPlaneButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const plane = button.dataset.originPlane;
    state.originPlanes[plane] = !state.originPlanes[plane];
    button.classList.toggle("is-active", state.originPlanes[plane]);
    button.setAttribute("aria-pressed", String(state.originPlanes[plane]));
    viewport?.setOriginPlaneVisible(plane, state.originPlanes[plane]);
  });
});

modelCenterVisibilityButton.addEventListener("click", () => {
  state.modelCenterVisible = !state.modelCenterVisible;
  viewport?.setModelCenterVisible(state.modelCenterVisible);
  updateModelCenterUi();
});

useModelCenterButton.addEventListener("click", () => {
  viewport?.selectModelCenterReference();
});

planeModeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const nextMode = button.dataset.planeMode;
    if (!PLANE_MODES[nextMode] || nextMode === activePlaneMode) return;
    activePlaneMode = nextMode;
    updatePlaneModeUi();
  });
});

planeMethodButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const nextMethod = button.dataset.planeMethod;
    if (PLANE_METHODS[nextMethod].mode !== activePlaneMode) return;
    activePlaneMethod = nextMethod;
    activePlaneMethods[activePlaneMode] = nextMethod;
    setPressedState(planeMethodButtons, button);
    viewport?.clearConstructionSelection();
    updatePlaneMethodUi();
  });
});

clearPlaneSelectionButton.addEventListener("click", () => viewport?.clearConstructionSelection());
clearCreatedPlanesButton.addEventListener("click", () => {
  const beforeState = captureEditState();
  viewport?.clearConstructionPlanes();
  recordEdit("Clear construction planes", beforeState);
});
boundsOrientation.addEventListener("change", updatePlaneMethodUi);

createPlaneButton.addEventListener("click", () => {
  if (!viewport) return;
  const method = PLANE_METHODS[activePlaneMethod];
  if (selectedReferenceCount < method.minimum) {
    showToast("Select the required model references first.");
    return;
  }

  const distance = Number.parseFloat(planeDistance.value);
  const angle = Number.parseFloat(planeAngle.value);
  const pathPercent = Number.parseFloat(pathPosition.value);
  if ((method.distance && !Number.isFinite(distance)) || (method.angle && !Number.isFinite(angle))) {
    showToast("Enter a valid numeric value.");
    return;
  }
  if (method.pathPosition && !Number.isFinite(pathPercent)) {
    showToast("Enter a valid path position.");
    return;
  }

  try {
    const beforeState = captureEditState();
    const createdCount = viewport.createPlaneFromMethod(activePlaneMethod, {
      name: planeNameInput.value,
      referenceA: planeReferenceA.value,
      referenceB: planeReferenceB.value,
      distance,
      angle,
      pathPosition: pathPercent,
      boundsSet: boundsPlaneSet.value,
      boundsOrientation: boundsOrientation.value,
    });
    recordEdit(
      createdCount === 1 ? "Create construction plane" : "Create " + createdCount + " planes",
      beforeState,
    );
    planeNameInput.value = "";
    updateBoundsReadout();
    if (activePlaneMethod === "auto-axes") {
      showToast("Top, Front, and Right planes created at the oriented model center.");
    } else if (activePlaneMethod === "bounds") {
      const orientationLabel =
        boundsOrientation.value === "model" ? "oriented model" : "source-axis";
      showToast(
        boundsPlaneSet.value === "faces"
          ? "6 " + orientationLabel + " boundary planes created."
          : "3 " + orientationLabel + " center planes created.",
      );
    } else if (activePlaneMethod === "planar-surface") {
      showToast("Plane fitted to the selected local surface.");
    } else {
      showToast(
        createdCount === 1
          ? "Construction plane created."
          : createdCount + " construction planes created from exact extrema.",
      );
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : "The plane could not be created.");
  }
});

function setLayFlatStatus(status, hint) {
  layFlatSelectionStatus.textContent = status;
  layFlatSelectionHint.textContent = hint;
}

function closeLayFlatWorkbench() {
  const wasOpen = !layFlatWorkbench.hidden;
  layFlatWorkbench.hidden = true;
  if (wasOpen) {
    viewport?.configureConstructionSelection(false, "planar-surface", 1);
    viewport?.clearConstructionSelection();
  }
  updateLeftRailWorkbench();
  updateTransformGizmoVisibility();
}

function openLayFlatWorkbench() {
  setPlaneWorkbenchOpen(false);
  closeAlignmentWorkbenches(true);
  layFlatWorkbench.hidden = false;
  setLayFlatStatus(
    "Choose a planar surface",
    "Left-click away from edges. Meshes and point clouds are supported.",
  );
  updateLeftRailWorkbench();
  viewport?.configureConstructionSelection(true, "planar-surface", 1);
  updateTransformGizmoVisibility();
}

function applyLayFlatSurface(reference) {
  if (!viewport || layFlatApplying || layFlatWorkbench.hidden) return;
  layFlatApplying = true;
  setLayFlatStatus("Fitting selected surface…", "Finding its stable local plane.");

  try {
    commitPendingTransformEdit();
    const beforeState = captureEditState();
    const transform = viewport.createLayFlatTransform(reference);
    applyModelTransform(transform.rotation, transform.position);
    const recorded = recordEdit("Lay model flat", beforeState);
    closeLayFlatWorkbench();
    clearActiveToolSection();
    showToast(
      recorded
        ? "Selected surface placed on Z = 0."
        : "The selected surface is already flat on Z = 0.",
    );
  } catch (error) {
    viewport.clearConstructionSelection();
    const message =
      error instanceof Error ? error.message : "The selected surface could not be fitted.";
    setLayFlatStatus("Choose another surface", message);
    showToast(message);
  } finally {
    layFlatApplying = false;
  }
}

function handleConstructionSelectionChange(references = []) {
  updateSelectionUi(references);
  if (!layFlatWorkbench.hidden && !layFlatApplying && references.length === 1) {
    applyLayFlatSurface(references[0]);
  }
}

function dropModelToBed() {
  if (!viewport) return;
  commitPendingTransformEdit();
  const minimumZ = viewport.getExactWorldMinimumZ();
  if (!Number.isFinite(minimumZ)) {
    showToast("The model does not contain usable vertices.");
    return;
  }

  const tolerance = Math.max(
    viewport.getConstructionVisualScale() * Number.EPSILON * 32,
    1e-12,
  );
  if (Math.abs(minimumZ) <= tolerance) {
    showToast("The model is already touching Z = 0.");
    return;
  }

  const beforeState = captureEditState();
  const nextZ = state.model.position.z - minimumZ;
  state.model.position.z = Math.abs(nextZ) <= 1e-12 ? 0 : nextZ;
  writeTransformInputs();
  viewport.applyTransform();
  recordEdit("Drop model to bed", beforeState);
  showToast("Model dropped to its first contact with Z = 0.");
}

closeLayFlatWorkbenchButton.addEventListener("click", () => {
  closeLayFlatWorkbench();
  clearActiveToolSection();
});
cancelLayFlatButton.addEventListener("click", () => {
  closeLayFlatWorkbench();
  clearActiveToolSection();
});
dropToBedButton.addEventListener("click", dropModelToBed);

function clearActiveToolSection() {
  setPressedState(sectionButtons, null);
}

function updateTransformGizmoVisibility() {
  viewport?.setTransformGizmoVisible(
    planeWorkbench.hidden &&
      layFlatWorkbench.hidden &&
      rotationWorkbench.hidden &&
      levelWorkbench.hidden,
  );
}

function beginAlignmentPreview(type) {
  if (alignmentPreviewSession?.type === type) return;
  if (alignmentPreviewSession) endAlignmentPreview(alignmentPreviewSession.type, true);
  alignmentPreviewSession = {
    type,
    originalPosition: { ...state.model.position },
    originalRotation: { ...state.model.rotation },
    historyBefore: captureEditState(),
  };
}

function previewAlignmentTransform(type, quaternion, position = null) {
  beginAlignmentPreview(type);
  applyModelTransform(quaternion, position);
}

function applyModelTransform(quaternion, position = null) {
  const euler = new THREE.Euler().setFromQuaternion(quaternion, "XYZ");
  if (position) {
    state.model.position = {
      x: Math.abs(position.x) <= 1e-12 ? 0 : position.x,
      y: Math.abs(position.y) <= 1e-12 ? 0 : position.y,
      z: Math.abs(position.z) <= 1e-12 ? 0 : position.z,
    };
  }
  state.model.rotation = {
    x: Math.abs(euler.x) <= 1e-12 ? 0 : euler.x,
    y: Math.abs(euler.y) <= 1e-12 ? 0 : euler.y,
    z: Math.abs(euler.z) <= 1e-12 ? 0 : euler.z,
  };
  writeTransformInputs();
  viewport?.applyTransform();
}

function previewAlignmentRotation(type, quaternion) {
  previewAlignmentTransform(type, quaternion);
}

function endAlignmentPreview(type, restore) {
  if (alignmentPreviewSession?.type !== type) return;
  if (restore) {
    state.model.position = { ...alignmentPreviewSession.originalPosition };
    state.model.rotation = { ...alignmentPreviewSession.originalRotation };
    writeTransformInputs();
    viewport?.applyTransform();
  }
  alignmentPreviewSession = null;
}

function closeRotationWorkbench(restore) {
  orientationAnalysisSequence += 1;
  rotationWorkbench.hidden = true;
  endAlignmentPreview("automatic", restore);
  updateLeftRailWorkbench();
  updateTransformGizmoVisibility();
}

function closeLevelWorkbench(restore) {
  levelWorkbench.hidden = true;
  viewport?.configureAlignmentPlanePicking(false);
  endAlignmentPreview("manual", restore);
  updateLeftRailWorkbench();
  updateTransformGizmoVisibility();
}

function closeAlignmentWorkbenches(restore) {
  closeRotationWorkbench(restore);
  closeLevelWorkbench(restore);
}

function setRotationAnalysisStatus(status, message) {
  rotationAnalysisStatus.dataset.state = status;
  rotationAnalysisText.textContent = message;
}

function resetAutomaticOrientationUi() {
  automaticOrientationCandidates = [];
  selectedOrientationCandidate = null;
  orientationQuarterTurns = 0;
  orientationCandidateList.replaceChildren();
  orientationResults.hidden = true;
  analyzeOrientationButton.hidden = false;
  analyzeOrientationButton.disabled = false;
  turnOrientationButton.disabled = true;
  applyOrientationButton.disabled = true;
  setRotationAnalysisStatus("idle", "Ready to analyze the model.");
}

function renderOrientationCandidates() {
  orientationCandidateList.replaceChildren();
  for (const candidate of automaticOrientationCandidates) {
    const button = document.createElement("button");
    button.className = "orientation-candidate";
    button.type = "button";
    button.dataset.orientationId = candidate.id;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", "false");
    const name = document.createElement("strong");
    name.textContent = candidate.name;
    const dimensions = document.createElement("small");
    dimensions.textContent =
      "X " +
      formatCoordinate(candidate.size.x) +
      " · Y " +
      formatCoordinate(candidate.size.y) +
      " · Z " +
      formatCoordinate(candidate.size.z);
    button.append(name, dimensions);
    button.addEventListener("click", () => selectOrientationCandidate(candidate.id));
    orientationCandidateList.append(button);
  }
}

function previewAutomaticOrientation() {
  if (!selectedOrientationCandidate) return;
  const turn = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    orientationQuarterTurns * Math.PI * 0.5,
  );
  const rotation = turn.multiply(selectedOrientationCandidate.quaternion.clone()).normalize();
  previewAlignmentRotation("automatic", rotation);
}

function selectOrientationCandidate(candidateId) {
  selectedOrientationCandidate = automaticOrientationCandidates.find(
    (candidate) => candidate.id === candidateId,
  );
  if (!selectedOrientationCandidate) return;
  orientationQuarterTurns = 0;
  for (const button of orientationCandidateList.children) {
    const isActive = button.dataset.orientationId === candidateId;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  }
  turnOrientationButton.disabled = false;
  applyOrientationButton.disabled = false;
  previewAutomaticOrientation();
}

async function analyzeModelOrientation() {
  if (!viewport || rotationWorkbench.hidden) return;
  const analysisSequence = ++orientationAnalysisSequence;
  analyzeOrientationButton.hidden = true;
  orientationResults.hidden = true;
  applyOrientationButton.disabled = true;
  turnOrientationButton.disabled = true;
  setRotationAnalysisStatus("analyzing", "Analyzing convex hull and oriented bounds...");
  await new Promise((resolve) => requestAnimationFrame(resolve));
  if (analysisSequence !== orientationAnalysisSequence || rotationWorkbench.hidden) return;

  try {
    const result = viewport.createAxisAlignmentCandidates();
    if (analysisSequence !== orientationAnalysisSequence || rotationWorkbench.hidden) return;
    automaticOrientationCandidates = result.candidates;
    renderOrientationCandidates();
    orientationResults.hidden = false;
    setRotationAnalysisStatus(
      "ready",
      "Tested " +
        result.candidateFrameCount.toLocaleString("en-US") +
        " frames across " +
        result.hullVertexCount.toLocaleString("en-US") +
        " hull vertices.",
    );
    selectOrientationCandidate(automaticOrientationCandidates[0].id);
  } catch (error) {
    console.error("Automatic orientation analysis failed:", error);
    resetAutomaticOrientationUi();
    setRotationAnalysisStatus(
      "error",
      error instanceof Error ? error.message : "The model orientation could not be analyzed.",
    );
  }
}

function openRotationWorkbench() {
  setPlaneWorkbenchOpen(false);
  closeLayFlatWorkbench();
  closeLevelWorkbench(true);
  rotationWorkbench.hidden = false;
  updateLeftRailWorkbench();
  updateTransformGizmoVisibility();
  beginAlignmentPreview("automatic");
  resetAutomaticOrientationUi();
  void analyzeModelOrientation();
}

function formatWorldAxis(direction) {
  const axes = [
    ["X", direction.x],
    ["Y", direction.y],
    ["Z", direction.z],
  ].sort((left, right) => Math.abs(right[1]) - Math.abs(left[1]));
  return (axes[0][1] < 0 ? "−" : "+") + axes[0][0];
}

function updateLevelAlignmentSummary() {
  const target = ALIGNMENT_TARGETS[levelTargetPlane.value];
  const targetAxis = formatWorldAxis(target.normal);
  const directionTurn =
    levelQuarterTurns === 0
      ? ""
      : " · Extra turn " + levelQuarterTurns * 90 + "° around " + targetAxis;
  levelAlignmentSummary.textContent =
    (levelNormalFlipped ? "Flipped plane normal" : "Plane normal") +
    " → " +
    targetAxis +
    " · Plane offset on " +
    targetAxis.slice(1) +
    " → 0 · Composed from current state" +
    directionTurn;
}

function previewLevelAlignment() {
  if (levelWorkbench.hidden || !levelSourcePlane.value || !viewport) return;
  try {
    viewport.setAlignmentPlaneSelection(
      levelSourcePlane.value,
      levelTargetPlane.value,
    );
    const baseTransform = alignmentPreviewSession
      ? {
          position: alignmentPreviewSession.originalPosition,
          rotation: alignmentPreviewSession.originalRotation,
          scale: state.model.scale,
        }
      : state.model;
    const transform = viewport.createPlaneAlignmentTransform(
      levelSourcePlane.value,
      levelTargetPlane.value,
      levelNormalFlipped,
      levelQuarterTurns,
      baseTransform,
    );
    previewAlignmentTransform("manual", transform.rotation, transform.position);
    updateLevelAlignmentSummary();
    applyLevelButton.disabled = false;
  } catch (error) {
    applyLevelButton.disabled = true;
    showToast(error instanceof Error ? error.message : "The plane could not be aligned.");
  }
}

function populateAlignmentPlaneReferences() {
  const planes = viewport?.getModelAlignmentPlanes() || [];
  const previousValue = levelSourcePlane.value;
  levelSourcePlane.replaceChildren();
  for (const plane of planes) {
    const option = document.createElement("option");
    option.value = plane.id;
    option.textContent = plane.name + " · " + plane.method;
    levelSourcePlane.append(option);
  }
  if (planes.some((plane) => plane.id === previousValue)) {
    levelSourcePlane.value = previousValue;
  }

  const hasPlanes = planes.length > 0;
  levelEmptyState.hidden = hasPlanes;
  levelControls.hidden = !hasPlanes;
  applyLevelButton.disabled = !hasPlanes;
  if (!levelWorkbench.hidden) {
    viewport?.configureAlignmentPlanePicking(
      hasPlanes,
      hasPlanes ? levelSourcePlane.value : null,
      hasPlanes ? levelTargetPlane.value : null,
    );
    if (hasPlanes) previewLevelAlignment();
  }
}

function resetLevelSourceAdjustments() {
  levelNormalFlipped = false;
  levelQuarterTurns = 0;
  flipLevelNormalButton.setAttribute("aria-pressed", "false");
}

function handleAlignmentPlanePick(hit) {
  if (!viewport || levelWorkbench.hidden || levelControls.hidden) return;

  if (hit.kind === "source") {
    const option = [...levelSourcePlane.options].find(
      (candidate) => candidate.value === hit.id,
    );
    if (!option) return;
    if (levelSourcePlane.value !== hit.id) resetLevelSourceAdjustments();
    levelSourcePlane.value = hit.id;
    previewLevelAlignment();
    showToast(option.textContent + " selected as the model reference.");
    return;
  }

  if (hit.kind === "target" && ALIGNMENT_TARGETS[hit.id]) {
    const targetChanged = levelTargetPlane.value !== hit.id;
    levelTargetPlane.value = hit.id;
    if (targetChanged) levelQuarterTurns = 0;
    previewLevelAlignment();
    showToast(ALIGNMENT_TARGETS[hit.id].name + " selected as the world target.");
  }
}

function openLevelWorkbench() {
  setPlaneWorkbenchOpen(false);
  closeLayFlatWorkbench();
  closeRotationWorkbench(true);
  levelWorkbench.hidden = false;
  updateLeftRailWorkbench();
  updateTransformGizmoVisibility();
  levelNormalFlipped = false;
  levelQuarterTurns = 0;
  flipLevelNormalButton.setAttribute("aria-pressed", "false");
  beginAlignmentPreview("manual");
  populateAlignmentPlaneReferences();
}

analyzeOrientationButton.addEventListener("click", () => void analyzeModelOrientation());
recalculateOrientationButton.addEventListener("click", () => void analyzeModelOrientation());
turnOrientationButton.addEventListener("click", () => {
  orientationQuarterTurns = (orientationQuarterTurns + 1) % 4;
  previewAutomaticOrientation();
});
applyOrientationButton.addEventListener("click", () => {
  if (!selectedOrientationCandidate) return;
  const beforeState = alignmentPreviewSession?.historyBefore;
  closeRotationWorkbench(false);
  if (beforeState) recordEdit("Rotate model to axes", beforeState);
  clearActiveToolSection();
  showToast("Automatic axis rotation applied. Position and scale were preserved.");
});
cancelOrientationButton.addEventListener("click", () => {
  closeRotationWorkbench(true);
  clearActiveToolSection();
});
closeRotationWorkbenchButton.addEventListener("click", () => {
  closeRotationWorkbench(true);
  clearActiveToolSection();
});

levelSourcePlane.addEventListener("change", () => {
  resetLevelSourceAdjustments();
  previewLevelAlignment();
});
levelTargetPlane.addEventListener("change", () => {
  levelQuarterTurns = 0;
  previewLevelAlignment();
});
flipLevelNormalButton.addEventListener("click", () => {
  levelNormalFlipped = !levelNormalFlipped;
  flipLevelNormalButton.setAttribute("aria-pressed", String(levelNormalFlipped));
  previewLevelAlignment();
});
turnLevelDirectionButton.addEventListener("click", () => {
  levelQuarterTurns = (levelQuarterTurns + 1) % 4;
  previewLevelAlignment();
});
applyLevelButton.addEventListener("click", () => {
  if (applyLevelButton.disabled) return;
  const beforeState = alignmentPreviewSession?.historyBefore;
  closeLevelWorkbench(false);
  if (beforeState) recordEdit("Align plane from current state", beforeState);
  clearActiveToolSection();
  showToast("Plane aligned. This result is now the base for the next alignment.");
});
cancelLevelButton.addEventListener("click", () => {
  closeLevelWorkbench(true);
  clearActiveToolSection();
});
closeLevelWorkbenchButton.addEventListener("click", () => {
  closeLevelWorkbench(true);
  clearActiveToolSection();
});
openPlaneForLevelButton.addEventListener("click", () => {
  closeLevelWorkbench(true);
  setPlaneWorkbenchOpen(true);
});

if (viewport) {
  viewport.onSelectionChange = handleConstructionSelectionChange;
  viewport.onPlanesChange = renderCreatedPlanes;
  viewport.onModelCenterChange = updateModelCenterUi;
  viewport.onAlignmentPlanePick = handleAlignmentPlanePick;
}
populatePlaneReferences();
renderCreatedPlanes(viewport?.constructionPlanes || []);
updatePlaneModeUi();
updateModelCenterUi();

const transformInputs = [...document.querySelectorAll("[data-transform]")];
const transformGizmoModeButtons = [...document.querySelectorAll("[data-gizmo-mode]")];
const transformGizmoSpaceButtons = [...document.querySelectorAll("[data-gizmo-space]")];
const gridSnapEnabledInput = document.querySelector("#gridSnapEnabled");
const gridSnapStepInput = document.querySelector("#gridSnapStep");
const angleSnapEnabledInput = document.querySelector("#angleSnapEnabled");
const angleSnapStepInput = document.querySelector("#angleSnapStep");
const transformGizmoControlElements = [
  ...transformGizmoModeButtons,
  ...transformGizmoSpaceButtons,
  gridSnapEnabledInput,
  gridSnapStepInput,
  angleSnapEnabledInput,
  angleSnapStepInput,
];

function writeTransformInputs() {
  for (const input of transformInputs) {
    const group = input.dataset.transform;
    const axis = input.dataset.axis;
    const rawValue = state.model[group][axis];
    const value = group === "rotation" ? THREE.MathUtils.radToDeg(rawValue) : rawValue;
    input.value = value.toFixed(group === "rotation" ? 2 : 3);
  }
}

function formatSnapStep(value) {
  return Number.parseFloat(Number(value).toPrecision(6)).toString();
}

function applyTransformGizmoSettings() {
  viewport?.setTransformGizmoSettings(state.transformGizmo);
}

function updateTransformGizmoUi() {
  const modeButton = transformGizmoModeButtons.find(
    (button) => button.dataset.gizmoMode === state.transformGizmo.mode,
  );
  const spaceButton = transformGizmoSpaceButtons.find(
    (button) => button.dataset.gizmoSpace === state.transformGizmo.space,
  );
  if (modeButton) setPressedState(transformGizmoModeButtons, modeButton);
  if (spaceButton) setPressedState(transformGizmoSpaceButtons, spaceButton);
  gridSnapEnabledInput.checked = state.transformGizmo.gridSnap;
  gridSnapStepInput.value = formatSnapStep(state.transformGizmo.gridStep);
  angleSnapEnabledInput.checked = state.transformGizmo.angleSnap;
  angleSnapStepInput.value = formatSnapStep(state.transformGizmo.angleStep);
}

function updateSnapStep(input, stateKey, minimum, maximum = Number.POSITIVE_INFINITY) {
  const value = Number.parseFloat(input.value);
  if (!Number.isFinite(value) || value <= 0) return false;
  state.transformGizmo[stateKey] = THREE.MathUtils.clamp(value, minimum, maximum);
  applyTransformGizmoSettings();
  return true;
}

transformGizmoModeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.transformGizmo.mode = button.dataset.gizmoMode;
    setPressedState(transformGizmoModeButtons, button);
    applyTransformGizmoSettings();
  });
});

transformGizmoSpaceButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.transformGizmo.space = button.dataset.gizmoSpace;
    setPressedState(transformGizmoSpaceButtons, button);
    applyTransformGizmoSettings();
  });
});

gridSnapEnabledInput.addEventListener("change", () => {
  state.transformGizmo.gridSnap = gridSnapEnabledInput.checked;
  applyTransformGizmoSettings();
});

angleSnapEnabledInput.addEventListener("change", () => {
  state.transformGizmo.angleSnap = angleSnapEnabledInput.checked;
  applyTransformGizmoSettings();
});

gridSnapStepInput.addEventListener("input", () => {
  updateSnapStep(gridSnapStepInput, "gridStep", GEOMETRY_EPSILON);
});
gridSnapStepInput.addEventListener("blur", () => {
  updateSnapStep(gridSnapStepInput, "gridStep", GEOMETRY_EPSILON);
  gridSnapStepInput.value = formatSnapStep(state.transformGizmo.gridStep);
});

angleSnapStepInput.addEventListener("input", () => {
  updateSnapStep(angleSnapStepInput, "angleStep", 0.1, 180);
});
angleSnapStepInput.addEventListener("blur", () => {
  updateSnapStep(angleSnapStepInput, "angleStep", 0.1, 180);
  angleSnapStepInput.value = formatSnapStep(state.transformGizmo.angleStep);
});

if (viewport) {
  viewport.onTransformGizmoStart = (mode) => {
    commitPendingTransformEdit();
    transformGizmoDragging = true;
    pendingTransformGizmoEdit = {
      label: mode === "rotate" ? "Rotate model with gizmo" : "Move model with gizmo",
      beforeState: captureEditState(),
    };
    updateHistoryUi();
  };
  viewport.onTransformGizmoChange = () => {
    writeTransformInputs();
  };
  viewport.onTransformGizmoEnd = () => {
    const edit = pendingTransformGizmoEdit;
    pendingTransformGizmoEdit = null;
    transformGizmoDragging = false;
    const recorded = edit ? recordEdit(edit.label, edit.beforeState) : false;
    if (!recorded) updateHistoryUi();
  };
  viewport.onTransformGridStepChange = (value) => {
    state.transformGizmo.gridStep = value;
    gridSnapStepInput.value = formatSnapStep(value);
    applyTransformGizmoSettings();
  };
}
updateTransformGizmoUi();
applyTransformGizmoSettings();
updateTransformGizmoVisibility();

function resetTransform() {
  const hadLayFlatWorkbenchOpen = !layFlatWorkbench.hidden;
  const hadAlignmentWorkbenchOpen = !rotationWorkbench.hidden || !levelWorkbench.hidden;
  closeLayFlatWorkbench();
  closeAlignmentWorkbenches(true);
  if (hadLayFlatWorkbenchOpen || hadAlignmentWorkbenchOpen) clearActiveToolSection();
  state.model.position = { x: 0, y: 0, z: 0 };
  state.model.rotation = { x: 0, y: 0, z: 0 };
  state.model.scale = { x: 1, y: 1, z: 1 };
  writeTransformInputs();
  viewport?.applyTransform();
}

const transformHistoryLabels = {
  position: "Change model position",
  rotation: "Change model rotation",
  scale: "Change model scale",
};

function beginTransformInputEdit(input) {
  if (!layFlatWorkbench.hidden) {
    closeLayFlatWorkbench();
    clearActiveToolSection();
  }
  if (alignmentPreviewSession) {
    closeAlignmentWorkbenches(true);
    clearActiveToolSection();
  }
  if (pendingTransformEdit) return;
  pendingTransformEdit = {
    label: transformHistoryLabels[input.dataset.transform],
    beforeState: captureEditState(),
  };
}

transformInputs.forEach((input) => {
  input.addEventListener("focus", () => beginTransformInputEdit(input));

  input.addEventListener("input", () => {
    beginTransformInputEdit(input);
    const group = input.dataset.transform;
    const axis = input.dataset.axis;
    const numericValue = Number.parseFloat(input.value);
    if (!Number.isFinite(numericValue)) return;

    if (group === "rotation") {
      state.model.rotation[axis] = THREE.MathUtils.degToRad(numericValue);
    } else if (group === "scale") {
      const safeScale = Math.max(0.05, numericValue);
      state.model.scale[axis] = safeScale;
      if (state.scaleLinked) {
        for (const linkedInput of transformInputs.filter(
          (item) => item.dataset.transform === "scale",
        )) {
          state.model.scale[linkedInput.dataset.axis] = safeScale;
          if (linkedInput !== input) linkedInput.value = numericValue.toFixed(3);
        }
      }
    } else {
      state.model.position[axis] = numericValue;
    }

    viewport?.applyTransform();
  });

  input.addEventListener("change", commitPendingTransformEdit);

  input.addEventListener("blur", () => {
    const value = Number.parseFloat(input.value);
    if (Number.isFinite(value)) {
      input.value = value.toFixed(input.dataset.transform === "rotation" ? 2 : 3);
    } else {
      writeTransformInputs();
    }
    commitPendingTransformEdit();
  });
});

const linkScaleButton = document.querySelector("#linkScaleButton");
linkScaleButton.addEventListener("click", () => {
  state.scaleLinked = !state.scaleLinked;
  linkScaleButton.classList.toggle("is-linked", state.scaleLinked);
  linkScaleButton.setAttribute("aria-pressed", String(state.scaleLinked));
  linkScaleButton.setAttribute(
    "aria-label",
    state.scaleLinked ? "Unlink scale axes" : "Link scale axes",
  );
});

function centerModelToOrigin() {
  const hadLayFlatWorkbenchOpen = !layFlatWorkbench.hidden;
  const hadAlignmentWorkbenchOpen = !rotationWorkbench.hidden || !levelWorkbench.hidden;
  closeLayFlatWorkbench();
  closeAlignmentWorkbenches(true);
  if (hadLayFlatWorkbenchOpen || hadAlignmentWorkbenchOpen) clearActiveToolSection();
  const centerInfo = viewport?.getModelCenterInfo();
  if (!centerInfo) {
    showToast("No model center is available.");
    return;
  }

  const beforeState = captureEditState();
  state.model.position = {
    x: state.model.position.x - centerInfo.world.x,
    y: state.model.position.y - centerInfo.world.y,
    z: state.model.position.z - centerInfo.world.z,
  };
  writeTransformInputs();
  viewport.applyTransform();
  recordEdit("Center model to origin", beforeState);
  showToast("Mesh center moved to the world origin.");
}

document.querySelector("#centerButton").addEventListener("click", centerModelToOrigin);

const fileInput = document.querySelector("#fileInput");
const importButton = document.querySelector("#importButton");
const exportButton = document.querySelector("#exportButton");
const clearModelButton = document.querySelector("#clearModelButton");
const modelStatus = document.querySelector("#modelStatus");
const modelName = document.querySelector("#modelName");
const selectionChip = document.querySelector(".selection-chip");
const numberFormatter = new Intl.NumberFormat("en-US");
let importInProgress = false;
let exportInProgress = false;
let fileDragDepth = 0;

function updateFileActionState() {
  const isBusy = importInProgress || exportInProgress;
  historyLocked = isBusy;
  importButton.disabled = isBusy;
  importButton.setAttribute("aria-busy", String(importInProgress));
  exportButton.disabled = isBusy || !viewport?.canExportModel();
  exportButton.setAttribute("aria-busy", String(exportInProgress));
  fileInput.disabled = isBusy;
  clearModelButton.disabled = isBusy;
  for (const control of transformGizmoControlElements) control.disabled = isBusy;
  viewport?.setTransformGizmoEnabled(!isBusy);
  updateHistoryUi();
}

function setImportBusy(isBusy) {
  importInProgress = isBusy;
  updateFileActionState();
}

function setExportBusy(isBusy) {
  exportInProgress = isBusy;
  updateFileActionState();
}

async function importModelFile(file) {
  if (importInProgress) {
    showToast("Wait for the current model to finish loading.");
    return;
  }

  const extension = getFileExtension(file.name);
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    showToast("Choose a PLY, OBJ, or STL file.");
    return;
  }

  if (!viewport) {
    showToast("WebGL 2 is required to load a model.");
    return;
  }

  setImportBusy(true);
  showToast("Loading " + file.name + "...");

  try {
    const result = await viewport.loadFile(file);
    resetTransform();
    setSurfaceDisplayModesAvailable(result.hasSurfaceGeometry);
    viewport.fitView();
    updateBoundsReadout();
    resetEditHistory("Import " + file.name);

    const elementLabel = result.hasSurfaceGeometry ? "vertices" : "points";
    modelName.textContent = file.name;
    modelStatus.title =
      file.name + " · " + numberFormatter.format(result.vertexCount) + " " + elementLabel;
    selectionChip.textContent = getDisplayName(file.name);
    modelStatus.hidden = false;
    showToast(
      file.name +
        " loaded · " +
        numberFormatter.format(result.vertexCount) +
        " " +
        elementLabel +
        ".",
    );
  } catch (error) {
    console.error("Model import failed:", error);
    showToast(error instanceof Error ? error.message : "The model could not be loaded.");
  } finally {
    setImportBusy(false);
  }
}

function eventContainsFiles(event) {
  const dataTransfer = event.dataTransfer;
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types || []).includes("Files") || dataTransfer.files.length > 0;
}

function setDropOverlayVisible(isVisible) {
  workspace.classList.toggle("is-file-dragging", isVisible);
  dropOverlay.setAttribute("aria-hidden", String(!isVisible));
}

function resetFileDragState() {
  fileDragDepth = 0;
  setDropOverlayVisible(false);
}

importButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const [file] = fileInput.files;
  fileInput.value = "";
  if (file) void importModelFile(file);
});

window.addEventListener("dragenter", (event) => {
  if (!eventContainsFiles(event)) return;
  event.preventDefault();
  fileDragDepth += 1;
  setDropOverlayVisible(true);
});

window.addEventListener("dragover", (event) => {
  if (!eventContainsFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});

window.addEventListener("dragleave", (event) => {
  if (!eventContainsFiles(event)) return;
  event.preventDefault();
  fileDragDepth = Math.max(0, fileDragDepth - 1);
  if (fileDragDepth === 0) setDropOverlayVisible(false);
});

window.addEventListener("drop", (event) => {
  if (!eventContainsFiles(event)) return;
  event.preventDefault();

  const files = Array.from(event.dataTransfer.files);
  resetFileDragState();

  if (files.length !== 1) {
    showToast("Drop one PLY, OBJ, or STL file at a time.");
    return;
  }

  void importModelFile(files[0]);
});

window.addEventListener("blur", resetFileDragState);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) resetFileDragState();
});

clearModelButton.addEventListener("click", () => {
  resetTransform();
  viewport?.showDemoModel();
  setSurfaceDisplayModesAvailable(true);
  modelStatus.hidden = true;
  modelStatus.removeAttribute("title");
  modelName.textContent = "Untitled mesh";
  selectionChip.textContent = "Cube";
  updateBoundsReadout();
  resetEditHistory("Demo model");
  updateFileActionState();
  showToast("Imported model cleared.");
});

function downloadExportFile({ data, mimeType, fileName }) {
  const url = URL.createObjectURL(new Blob([data], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

exportButton.addEventListener("click", async () => {
  if (exportInProgress) return;
  if (!viewport?.canExportModel()) {
    showToast("Import a model before exporting it.");
    return;
  }

  setExportBusy(true);
  showToast("Preparing transformed model...");
  await new Promise((resolve) => requestAnimationFrame(resolve));

  try {
    const exported = viewport.exportModel();
    downloadExportFile(exported);
    showToast(exported.fileName + " exported.");
  } catch (error) {
    console.error("Model export failed:", error);
    showToast(error instanceof Error ? error.message : "The model could not be exported.");
  } finally {
    setExportBusy(false);
  }
});

updateFileActionState();

document.querySelector(".brand").addEventListener("click", (event) => {
  event.preventDefault();
  viewport?.fitView();
});

window.addEventListener("keydown", (event) => {
  const shortcutKey = event.key.toLowerCase();
  const hasHistoryModifier = (event.ctrlKey || event.metaKey) && !event.altKey;
  if (hasHistoryModifier && (shortcutKey === "z" || shortcutKey === "y")) {
    const keepsNativeTextHistory =
      event.target instanceof HTMLInputElement && !event.target.matches("[data-transform]");
    if (keepsNativeTextHistory) return;
    event.preventDefault();
    if (shortcutKey === "y" || event.shiftKey) {
      redoLastEdit();
    } else {
      undoLastEdit();
    }
    return;
  }
  if (event.key === "Escape") {
    resetFileDragState();
    if (!planeWorkbench.hidden) setPlaneWorkbenchOpen(false);
    if (!layFlatWorkbench.hidden) {
      closeLayFlatWorkbench();
      clearActiveToolSection();
    }
    if (!rotationWorkbench.hidden || !levelWorkbench.hidden) {
      closeAlignmentWorkbenches(true);
      clearActiveToolSection();
    }
    return;
  }
  if (event.target instanceof HTMLInputElement) return;
  if (shortcutKey === "f") viewport?.fitView();
  if (event.key === "1") displayButtons[0].click();
  if (event.key === "2") displayButtons[1].click();
  if (event.key === "3") displayButtons[2].click();
});

applyTheme(document.documentElement.dataset.theme || "light", false);
