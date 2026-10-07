<p align="center">
  <img src="favicon.svg" alt="MeshToZero logo" width="134">
</p>

<h1 align="center">MeshToZero</h1>

<p align="center">
  A browser-based workspace for centering, orienting, and precisely aligning 3D meshes and point clouds.
</p>

<p align="center">
  <a href="https://espmaniac.github.io/MeshToZero/"><strong>Open MeshToZero</strong></a>
</p>

## Overview

MeshToZero provides non-destructive tools for preparing PLY, OBJ, and STL models directly in the browser. Import a model, create geometric reference planes, align it to world axes or the XY bed, and export the transformed geometry in its original format.

The application is built with HTML, CSS, JavaScript, and Three.js. It has no framework dependency, build step, account requirement, or server-side component.

## Workflow

1. Import or drag and drop a PLY, OBJ, or STL file.
2. Inspect the model as a mesh, edge view, vertex view, or point cloud.
3. Move, rotate, and scale with numeric fields or the transform gizmo.
4. Create automatic or manual construction planes from the model geometry.
5. Compare a fitted model surface with a chosen X, Y, Z, or construction plane.
6. Auto-orient the model from one of several detected planes or axes, align it manually, lay a selected surface flat, or drop it onto the XY bed.
7. Review or restore any operation from Transform History.
8. Export the transformed model in the same format as the imported file.

## Features

### Transform and placement

- Center-pivot Move and Rotate gizmos
- World and Local coordinate spaces
- Position-to-grid and rotation-to-angle snapping
- CAD object snaps for vertices, edge midpoints, nearest edge points, faces, centers, and plane intersections
- Snap-to-snap translation from a model reference to Grid, a world-plane intersection, or World Origin
- Linked or independent scale controls
- Auto Orient variants from planar or dominant mesh-surface directions, point-cloud plane fits, cylindrical or elongated symmetry axes, and oriented bounds
- Explicit X / Right, Y / Front, and Z / Top targets for every automatic variant
- Central preview plane saved as reusable construction geometry when Auto Orient is applied
- Sequential plane-to-world alignment
- Normal flipping and 90-degree turns around a target normal
- Lay Flat placement from a selected mesh or point-cloud surface
- Exact Drop to Bed placement without changing model rotation
- Non-destructive alignment previews

### Construction geometry

- Automatic Top, Front, and Right model planes
- Model-oriented and source-axis boundary-box planes
- Separate boundary-face and center-plane sets
- Planes through points, edges, paths, and triangles
- Local planar-surface detection for meshes and point clouds
- Best-fit, tangent, offset, angle, midplane, and perpendicular planes
- Model-space planes that follow model transformations
- Fixed Top, Front, and Right world-origin grids

### Plane inspector

- Local planar-surface fitting on meshes and point clouds
- Explicit X / Right, Y / Front, and Z / Top reference-plane controls
- Comparison with any user-created construction plane
- Reference-plane selection from the inspector or by clicking a visible plane in the viewport
- Angular deviation, alignment state, and normal-match percentage for the chosen plane
- Surface and reference normals, sample count, and RMS fit quality

### Editing and navigation

- Model-centered orbit, unrestricted camera rotation, pan, zoom, and fit
- Mesh, edge, vertex, and point-cloud display modes
- Light-gray and dark-gray interface themes
- Responsive desktop and mobile layout
- 100-step undo and redo
- Clickable Photoshop-style Transform History
- Full-workspace file drag and drop

## Supported formats

| Format | Import | Export | Notes |
| --- | --- | --- | --- |
| OBJ | Yes | Yes | Geometry only; external MTL files and textures are not loaded |
| PLY | Yes | Yes | Meshes and point clouds; ASCII or binary representation is preserved |
| STL | Yes | Yes | ASCII or binary representation is preserved |

Current model transformations are baked into exported vertex coordinates.

## Controls

| Input | Action |
| --- | --- |
| Left click | Select model geometry or interact with tools |
| Middle-mouse drag | Orbit around the current model center |
| Right-mouse drag | Pan |
| Mouse wheel | Zoom |
| ViewCube face | Switch to the corresponding orthogonal view |
| ViewCube corner | Switch to the corresponding isometric view |
| ViewCube Home button | Restore the home view and fit the model |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` or `Ctrl+Shift+Z` | Redo |

## Technical notes

- Requires a modern browser with WebGL 2 support
- Uses pinned Three.js ES modules from jsDelivr
- Runs entirely in the browser
- Published as a static GitHub Pages application

## Workspace controls

- The top command strip groups model transforms, alignment, and construction tools. Scroll the strip horizontally on narrow screens.
- Scene objects, reference planes, and edit history stay in the left panel. Use the Scene button to open this panel on smaller screens.
- Construction methods, axis targets, coordinate spaces, and geometry snaps pair icons with text labels.
- Workspace settings contains coordinate space, grid and angle increments, and geometry snapping. The status bar shows whether snapping is active. Settings apply immediately for the current session.
- The top reference grid is shown initially; enable Front and Right in the Scene panel as needed.
- The viewport fills the window behind the interface. ViewCube is centered above the coordinate readout at the bottom right.
