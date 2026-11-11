// Gaussian Splat gallery viewer — lists every splat in manifest.json and
// lets you crossfade between them via the hamburger menu: two stacked
// Viewer layers (one active, one disposable) for a clean crossfade, progressive/chunked streaming via
// addSplatScene's progressiveLoad option, no rebuild step — point this at
// a local manifest.json + ./splats/*.ksplat directory and it just works.
//
// To add a new splat later: drop its .ksplat file into ./splats/ and add
// one entry to manifest.json. No other change needed — this file reads
// the manifest at load time.

import * as THREE from "./lib/three.module.js";
import * as GaussianSplats3D from "./lib/gaussian-splats-3d.module.js";

const CROSSFADE_MS = 1100; // must match styles.css .splat-layer transition duration
const IDLE_TIMEOUT_MS = 3000;
const FLIGHT_SPEED = 0.00028;
const WAYPOINT_MIN_RADIUS_FACTOR = 0.28;
const WAYPOINT_MAX_RADIUS_FACTOR = 0.55;
const WAYPOINT_ARRIVE_EPS = 0.05;

// ---- Color grading + clip-volume filter state --------------------------
// Lives outside any one controller because it must survive splat switches
// and crossfades -- reapplied to each controller's live material uniforms
// (and, for the clip volume, its gizmo mesh) every time a controller's
// splat material is (re)built -- see syncFiltersToController() below.
// Values are persisted so a visitor's grading/clip setup survives reloads.
const FILTERS_STORAGE_KEY = "gs-gallery-filters-v1";

function defaultFilters() {
  return {
    color: {
      hueDeg: 0,
      saturation: 1,
      brightness: 0,
      contrast: 1,
      gamma: 1,
    },
    clip: {
      enabled: false,
      shape: "box", // "box" | "sphere"
      invert: false,
      showGizmo: true,
      // Position/scale are normalized to each scene's own center/size (see
      // sceneCenter + sceneMaxDim in createController) so the same slider
      // range (-1..1 / 0.02..2) behaves sensibly regardless of how large or
      // small a given splat's world-space coordinates happen to be.
      position: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      rotationDeg: { x: 0, y: 0, z: 0 },
    },
  };
}

function loadFilters() {
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return defaultFilters();
    const parsed = JSON.parse(raw);
    const base = defaultFilters();
    return {
      color: { ...base.color, ...(parsed.color || {}) },
      clip: {
        ...base.clip,
        ...(parsed.clip || {}),
        position: { ...base.clip.position, ...((parsed.clip || {}).position || {}) },
        scale: { ...base.clip.scale, ...((parsed.clip || {}).scale || {}) },
        rotationDeg: { ...base.clip.rotationDeg, ...((parsed.clip || {}).rotationDeg || {}) },
      },
    };
  } catch {
    return defaultFilters();
  }
}

let FILTERS = loadFilters();

function persistFilters() {
  try {
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(FILTERS));
  } catch {
    /* storage unavailable (private mode, quota) -- filters just won't persist */
  }
}

// Reusable scratch objects for composing the clip volume's transform matrix.
const clipScratchPos = new THREE.Vector3();
const clipScratchQuat = new THREE.Quaternion();
const clipScratchEuler = new THREE.Euler();
const clipScratchScale = new THREE.Vector3();
const clipScratchMatrix = new THREE.Matrix4();

// Builds the clip volume's world-space transform matrix for a given scene's
// center/size. Position and scale sliders are both scaled by sceneMaxDim so
// the default (position 0, scale 1) box/sphere comfortably covers the whole
// scene regardless of its absolute world-space units.
function computeClipVolumeMatrix(clip, sceneCenter, sceneMaxDim) {
  const c = clip;
  const dim = Math.max(sceneMaxDim, 0.001);
  clipScratchPos.set(
    sceneCenter.x + c.position.x * dim,
    sceneCenter.y + c.position.y * dim,
    sceneCenter.z + c.position.z * dim
  );
  clipScratchEuler.set(
    (c.rotationDeg.x * Math.PI) / 180,
    (c.rotationDeg.y * Math.PI) / 180,
    (c.rotationDeg.z * Math.PI) / 180,
    "XYZ"
  );
  clipScratchQuat.setFromEuler(clipScratchEuler);
  clipScratchScale.set(
    Math.max(c.scale.x, 0.001) * dim,
    Math.max(c.scale.y, 0.001) * dim,
    Math.max(c.scale.z, 0.001) * dim
  );
  clipScratchMatrix.compose(clipScratchPos, clipScratchQuat, clipScratchScale);
  return clipScratchMatrix;
}

// `color`/`clip` are explicit filter objects (same shape as
// defaultFilters().color / .clip) rather than always reading the global
// FILTERS -- this lets the keyframe player (see KeyframePlayer below) push
// per-frame *interpolated* grading/clip values into the shader without
// touching the live Adjust-panel state or localStorage.
function applyColorAdjustToMaterial(material, color) {
  if (!material || !material.uniforms) return;
  const u = material.uniforms;
  const c = color;
  const isDefault =
    c.hueDeg === 0 && c.saturation === 1 && c.brightness === 0 && c.contrast === 1 && c.gamma === 1;
  if (!u.colorAdjustEnabled) return; // uniforms not present on this material build
  u.colorAdjustEnabled.value = isDefault ? 0 : 1;
  u.hueShift.value = c.hueDeg / 360;
  u.saturationAdjust.value = c.saturation;
  u.brightnessAdjust.value = c.brightness;
  u.contrastAdjust.value = c.contrast;
  u.gammaAdjust.value = c.gamma;
  material.uniformsNeedUpdate = true;
}

function applyClipToMaterial(material, clip, sceneCenter, sceneMaxDim) {
  if (!material || !material.uniforms || !material.uniforms.clipEnabled) return;
  const u = material.uniforms;
  const c = clip;
  u.clipEnabled.value = c.enabled ? 1 : 0;
  u.clipShape.value = c.shape === "sphere" ? 1 : 0;
  u.clipInverse.value = c.invert ? 1 : 0;
  u.clipMatrixInverse.value.copy(computeClipVolumeMatrix(c, sceneCenter, sceneMaxDim)).invert();
  material.uniformsNeedUpdate = true;
}

const loadingEl = document.getElementById("splat-loading");
const layerEls = {
  a: document.getElementById("splat-layer-a"),
  b: document.getElementById("splat-layer-b"),
};
const currentLabelEl = document.getElementById("current-label");

let SPLATS = [];
let activeKey = "a";
let controllers = { a: null, b: null };
let currentSplatId = null;
let transitioning = false;

// ---- Auto-orbit (idle-flight) on/off toggle ----------------------------
// Persisted so a visitor's choice survives reloads and splat switches.
const AUTO_ORBIT_STORAGE_KEY = "gs-gallery-auto-orbit-enabled";
let autoOrbitEnabled = localStorage.getItem(AUTO_ORBIT_STORAGE_KEY) !== "false";
const autoOrbitListeners = [];

function isAutoOrbitEnabled() {
  return autoOrbitEnabled;
}

function onAutoOrbitChange(listener) {
  autoOrbitListeners.push(listener);
}

function setAutoOrbitEnabled(enabled) {
  if (autoOrbitEnabled === enabled) return;
  autoOrbitEnabled = enabled;
  localStorage.setItem(AUTO_ORBIT_STORAGE_KEY, String(enabled));
  for (const key of Object.keys(controllers)) {
    const controller = controllers[key];
    if (controller) controller.onAutoOrbitToggled(enabled);
  }
  autoOrbitListeners.forEach((fn) => fn(enabled));
  // Pausing is exactly the "share what I'm looking at" moment this is
  // for: stopFlight() (called synchronously above, inside
  // onAutoOrbitToggled) has already parked the camera wherever the
  // flight was mid-transit, so this is the camera's final resting view.
  // notifyCameraSettled is defined later in this file but hoisted (plain
  // function declaration), so referencing it here is safe.
  if (!enabled) notifyCameraSettled(activeKey);
}

function toggleAutoOrbit() {
  setAutoOrbitEnabled(!autoOrbitEnabled);
}

function otherKey(key) {
  return key === "a" ? "b" : "a";
}

// ---- One controller per layer: owns its Viewer + idle-flight camera ----
function createController(layerKey) {
  const layerEl = layerEls[layerKey];

  let viewer = null;
  let sceneCenter = new THREE.Vector3(0, 0, 0);
  let sceneMaxDim = 10;
  let idleTimer = null;
  let flying = false;
  let flightWaypoint = null;
  let flightLastT = 0;
  let disposed = false;
  let skipAutoFit = false; // true when loaded from a URL-encoded camera state
  let boundPointerDown, boundPointerMove, boundActivity;

  // ---- Clip-volume gizmo: a wireframe box/sphere showing exactly what the
  // clip-volume shader uniforms are currently clipping against. Lives in
  // viewer.threeScene (rendered alongside the splat mesh -- see the
  // Viewer.update loop's `if (hasRenderables(this.threeScene))` render
  // call), rebuilt only when the shape (box<->sphere) changes, otherwise
  // just repositioned/rescaled/rotated in place. ------------------------
  let clipGizmoMesh = null;
  let clipGizmoShape = null;

  function buildClipGizmoGeometry(shape) {
    return shape === "sphere"
      ? new THREE.SphereGeometry(0.5, 24, 16)
      : new THREE.BoxGeometry(1, 1, 1);
  }

  function ensureClipGizmo(shape) {
    if (clipGizmoMesh && clipGizmoShape === shape) return clipGizmoMesh;
    if (clipGizmoMesh) {
      viewer.threeScene.remove(clipGizmoMesh);
      clipGizmoMesh.geometry.dispose();
      clipGizmoMesh.material.dispose();
    }
    const geometry = buildClipGizmoGeometry(shape);
    const wireframe = new THREE.WireframeGeometry(geometry);
    const material = new THREE.LineBasicMaterial({
      color: 0xff2a2a,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    });
    clipGizmoMesh = new THREE.LineSegments(wireframe, material);
    clipGizmoMesh.renderOrder = 999;
    clipGizmoShape = shape;
    viewer.threeScene.add(clipGizmoMesh);
    return clipGizmoMesh;
  }

  // Pushes the current FILTERS state (color grading + clip volume) into
  // this controller's live splat material uniforms and clip-volume gizmo.
  // Called once right after a scene finishes loading/bounds-fitting, and
  // again any time a slider in the Adjust panel changes (see
  // applyFiltersToAllControllers() near the UI wiring below).
  function applyFilters() {
    if (disposed || !viewer) return;
    const splatMesh = viewer.getSplatMesh();
    const material = splatMesh ? splatMesh.material : null;
    applyColorAdjustToMaterial(material, FILTERS.color);
    applyClipToMaterial(material, FILTERS.clip, sceneCenter, sceneMaxDim);

    if (!FILTERS.clip.showGizmo) {
      if (clipGizmoMesh) clipGizmoMesh.visible = false;
      return;
    }
    const gizmo = ensureClipGizmo(FILTERS.clip.shape);
    const m = computeClipVolumeMatrix(FILTERS.clip, sceneCenter, sceneMaxDim);
    m.decompose(gizmo.position, gizmo.quaternion, gizmo.scale);
    gizmo.visible = true;
    gizmo.material.color.setHex(FILTERS.clip.enabled ? 0xff2a2a : 0x8888ff);
  }

  function updateSceneBounds() {
    const splatMesh = viewer.getSplatMesh();
    if (!splatMesh || typeof splatMesh.getSplatCount !== "function") return null;
    const total = splatMesh.getSplatCount();
    if (total === 0) return null;

    // Outlier-robust bounds: 5th-95th percentile range per axis instead
    // of raw min/max, which stray SfM noise points can badly inflate.
    const sampleCount = Math.min(total, 20000);
    const stride = Math.max(1, Math.floor(total / sampleCount));
    const tmp = new THREE.Vector3();
    const xs = [], ys = [], zs = [];
    const points = [];
    for (let i = 0; i < total; i += stride) {
      splatMesh.getSplatCenter(i, tmp, true);
      xs.push(tmp.x); ys.push(tmp.y); zs.push(tmp.z);
      points.push(tmp.clone());
    }
    const sortedXs = xs.slice().sort((a, b) => a - b);
    const sortedYs = ys.slice().sort((a, b) => a - b);
    const sortedZs = zs.slice().sort((a, b) => a - b);
    const pct = (arr, p) => arr[Math.max(0, Math.min(arr.length - 1, Math.floor(arr.length * p)))];
    const lo = new THREE.Vector3(pct(sortedXs, 0.05), pct(sortedYs, 0.05), pct(sortedZs, 0.05));
    const hi = new THREE.Vector3(pct(sortedXs, 0.95), pct(sortedYs, 0.95), pct(sortedZs, 0.95));
    const size = hi.clone().sub(lo);

    const inBox = points.filter(
      (p) => p.x >= lo.x && p.x <= hi.x && p.y >= lo.y && p.y <= hi.y && p.z >= lo.z && p.z <= hi.z
    );
    const centroidSource = inBox.length > 0 ? inBox : points;
    const centroid = centroidSource
      .reduce((acc, p) => acc.add(p), new THREE.Vector3())
      .divideScalar(centroidSource.length);

    sceneCenter = centroid;
    sceneMaxDim = Math.max(size.x, size.y, size.z, 0.001);
    return { center: centroid, size };
  }

  function computeFitDistance(padFactor) {
    const fovRad = (50 * Math.PI) / 180;
    return (sceneMaxDim / 2 / Math.tan(fovRad / 2)) * padFactor;
  }

  // The library's InfoPanel (toggled by pressing "I", see gaussian-splats-3d's
  // Viewer.onKeyDown) only shows live camera/render stats -- it has no idea
  // which keys exist. We inject a static shortcuts legend into its DOM right
  // after construction so the same "I" panel also documents every toggle.
  const KEYBOARD_SHORTCUTS = [
    ["I", "Toggle this info panel"],
    ["R", "Toggle automatic camera movement (auto-orbit)"],
    ["O", "Toggle orthographic / perspective camera"],
    ["P", "Toggle point cloud mode"],
    ["C", "Toggle mesh cursor display"],
    ["U", "Toggle control plane display"],
    ["G / F", "Increase / decrease focal adjustment"],
    ["+ / -", "Increase / decrease splat scale"],
    ["\u2190 / \u2192", "Roll camera (rotate around view axis)"],
  ];

  function augmentInfoPanel() {
    if (!viewer || !viewer.infoPanel || !viewer.infoPanel.infoPanel) return;
    const panelEl = viewer.infoPanel.infoPanel;
    if (panelEl.querySelector(".gallery-shortcuts")) return; // already added

    const wrap = document.createElement("div");
    wrap.className = "gallery-shortcuts";
    wrap.style.marginTop = "10px";
    wrap.style.paddingTop = "8px";
    wrap.style.borderTop = "1px solid #555555";

    const title = document.createElement("div");
    title.textContent = "Keyboard shortcuts";
    title.style.fontWeight = "bold";
    title.style.fontSize = "12pt";
    title.style.marginBottom = "6px";
    wrap.appendChild(title);

    const table = document.createElement("div");
    table.style.display = "table";
    wrap.appendChild(table);

    for (const [key, desc] of KEYBOARD_SHORTCUTS) {
      const row = document.createElement("div");
      row.style.display = "table-row";
      const keyCell = document.createElement("div");
      keyCell.style.display = "table-cell";
      keyCell.style.fontWeight = "bold";
      keyCell.style.width = "70px";
      keyCell.style.paddingBottom = "3px";
      keyCell.textContent = key;
      const descCell = document.createElement("div");
      descCell.style.display = "table-cell";
      descCell.style.paddingBottom = "3px";
      descCell.textContent = desc;
      row.appendChild(keyCell);
      row.appendChild(descCell);
      table.appendChild(row);
    }

    panelEl.appendChild(wrap);
  }

  function fitCameraToScene() {
    const bounds = updateSceneBounds();
    if (!bounds) return;
    const distance = computeFitDistance(1.6);
    const camPos = new THREE.Vector3(
      bounds.center.x,
      bounds.center.y - distance * 0.35,
      bounds.center.z - distance
    );
    viewer.camera.position.copy(camPos);
    viewer.camera.lookAt(bounds.center);
    if (viewer.controls) {
      viewer.controls.target.copy(bounds.center);
      viewer.controls.update();
    }
  }

  function flyCameraTo(targetPos, lookAtTarget, durationMs, onDone) {
    stopFlight();
    if (idleTimer) clearTimeout(idleTimer);
    if (viewer.controls) viewer.controls.enabled = false;

    const startPos = viewer.camera.position.clone();
    const startTime = performance.now();

    function easeInOutCubic(t) {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    function step(t) {
      if (disposed || !viewer) return;
      const elapsed = t - startTime;
      const progress = Math.min(1, elapsed / durationMs);
      const eased = easeInOutCubic(progress);
      viewer.camera.position.lerpVectors(startPos, targetPos, eased);
      viewer.camera.lookAt(lookAtTarget);
      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        if (viewer.controls) {
          viewer.controls.enabled = true;
          viewer.controls.target.copy(lookAtTarget);
          viewer.controls.update();
        }
        resetIdleTimer();
        if (onDone) onDone();
      }
    }
    requestAnimationFrame(step);
  }

  // ---- Idle-triggered camera automation: random attractor flight ------
  function randomWaypoint() {
    const radius =
      sceneMaxDim *
      (WAYPOINT_MIN_RADIUS_FACTOR +
        Math.random() * (WAYPOINT_MAX_RADIUS_FACTOR - WAYPOINT_MIN_RADIUS_FACTOR));
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    return new THREE.Vector3(
      sceneCenter.x + radius * Math.sin(phi) * Math.cos(theta),
      sceneCenter.y + radius * Math.sin(phi) * Math.sin(theta) * 0.6,
      sceneCenter.z + radius * Math.cos(phi)
    );
  }

  function flightStep(t) {
    if (!flying || !viewer) return;
    const camera = viewer.camera;
    const dt = t - flightLastT;
    flightLastT = t;

    const toWaypoint = new THREE.Vector3().subVectors(flightWaypoint, camera.position);
    const dist = toWaypoint.length();
    const arriveThreshold = sceneMaxDim * WAYPOINT_ARRIVE_EPS;
    if (dist < arriveThreshold) {
      flightWaypoint = randomWaypoint();
    } else {
      const step = toWaypoint.multiplyScalar(Math.min(1, FLIGHT_SPEED * dt));
      camera.position.add(step);
    }
    camera.lookAt(sceneCenter);
    requestAnimationFrame(flightStep);
  }

  function startFlight() {
    if (flying || !viewer || !autoOrbitEnabled) return;
    flying = true;
    if (viewer.controls) viewer.controls.enabled = false;
    flightWaypoint = randomWaypoint();
    flightLastT = performance.now();
    requestAnimationFrame(flightStep);
  }

  function stopFlight() {
    if (!flying) return;
    flying = false;
    if (viewer && viewer.controls) {
      viewer.controls.enabled = true;
      viewer.controls.target.copy(sceneCenter);
      viewer.controls.update();
    }
  }

  function resetIdleTimer() {
    stopFlight();
    if (idleTimer) clearTimeout(idleTimer);
    if (!autoOrbitEnabled) return;
    idleTimer = setTimeout(startFlight, IDLE_TIMEOUT_MS);
  }

  function onAutoOrbitToggled(enabled) {
    if (enabled) {
      resetIdleTimer(); // arms the idle timer again
    } else {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      stopFlight();
    }
  }

  function attachInteraction() {
    boundPointerDown = resetIdleTimer;
    boundPointerMove = () => {}; // plain move (no drag) shouldn't cancel flight
    boundActivity = resetIdleTimer;
    layerEl.addEventListener("pointerdown", boundPointerDown);
    const activityEvents = ["wheel", "touchstart", "keydown"];
    activityEvents.forEach((evt) => window.addEventListener(evt, boundActivity, { passive: true }));
    resetIdleTimer();
  }
  function detachInteraction() {
    if (boundPointerDown) layerEl.removeEventListener("pointerdown", boundPointerDown);
    if (boundActivity) {
      const activityEvents = ["wheel", "touchstart", "keydown"];
      activityEvents.forEach((evt) => window.removeEventListener(evt, boundActivity));
    }
    if (idleTimer) clearTimeout(idleTimer);
    stopFlight();
  }

  // Loads one splat's .ksplat file. Progressive/chunked streaming is
  // enabled via progressiveLoad: true — addSplatScene's promise resolves
  // early (first chunk in), and onProgress fires as later chunks stream in.
  async function load(splatEntry, initialCameraState) {
    viewer = new GaussianSplats3D.Viewer({
      rootElement: layerEl,
      cameraUp: [0, -1, 0],
      initialCameraPosition: initialCameraState ? initialCameraState.position : [0, -5, 10],
      initialCameraLookAt: initialCameraState ? initialCameraState.target : [0, 0, 0],
      sphericalHarmonicsDegree: 0,
      sharedMemoryForWorkers: false, // plain static hosting, no COOP/COEP headers
    });
    augmentInfoPanel();

    // Shareable-view URLs (see notifyCameraSettled() below): OrbitControls
    // only fires 'end' after a real pointer-driven drag/pinch/wheel
    // gesture finishes, never from our own programmatic camera.position
    // sets (fitCameraToScene, flyCameraTo, the idle-flight loop) -- so
    // this only captures genuine user-adjusted views, exactly the
    // "share what I'm looking at" moment being asked for.
    if (viewer.controls) {
      viewer.controls.addEventListener("end", () => notifyCameraSettled(layerKey));
    }

    let fullyLoaded = false;
    let started = false;
    let pendingFinalize = false;
    await viewer.addSplatScene(splatEntry.file, {
      splatAlphaRemovalThreshold: 5,
      showLoadingUI: false,
      progressiveLoad: true,
      onProgress: (percentComplete) => {
        if (percentComplete >= 100 && !fullyLoaded && viewer) {
          fullyLoaded = true;
          if (started) finalizeFullyLoadedScene();
          else pendingFinalize = true;
        }
      },
    });

    if (initialCameraState) {
      // A camera state came from the URL -- trust it exactly, skip the
      // auto-fit/fly-in that would otherwise override it once loading
      // finishes (see finalizeFullyLoadedScene()).
      skipAutoFit = true;
      updateSceneBounds(); // still needed for filters/idle-flight waypoints
    } else {
      fitCameraToScene();
    }
    applyFilters();
    viewer.start();
    started = true;
    attachInteraction();
    if (pendingFinalize) finalizeFullyLoadedScene();
  }

  function finalizeFullyLoadedScene() {
    if (disposed || !viewer) return;
    const bounds = updateSceneBounds();
    if (!bounds) return;
    applyFilters(); // scene bounds may have shifted now that it's fully streamed in
    if (skipAutoFit) {
      // Still need sceneCenter/sceneMaxDim populated (updateSceneBounds
      // already did that as a side effect) for idle-flight waypoints and
      // resetIdleTimer() to work correctly later -- just skip repositioning
      // the camera, since a URL-provided view should land exactly as given.
      return;
    }
    const distance = computeFitDistance(1.6);
    flyCameraTo(
      new THREE.Vector3(
        bounds.center.x,
        bounds.center.y - distance * 0.35,
        bounds.center.z - distance
      ),
      bounds.center,
      1200
    );
  }

  function activate() {
    layerEl.classList.add("active");
  }
  function deactivate() {
    layerEl.classList.remove("active");
  }

  // ---- Playback hooks for the keyframe sequence player (see
  // KeyframePlayer further down this file). The player drives the camera
  // and material uniforms directly every animation frame, so it needs to
  // temporarily own the camera (idle-flight/OrbitControls suspended) and
  // get a direct handle on the live splat material. -----------------------
  function suspendAutomation() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    stopFlight();
    if (viewer && viewer.controls) viewer.controls.enabled = false;
  }
  function resumeAutomation() {
    if (viewer && viewer.controls) viewer.controls.enabled = true;
    resetIdleTimer();
  }
  function setLiveCamera(position, target) {
    if (!viewer) return;
    viewer.camera.position.copy(position);
    viewer.camera.lookAt(target);
    if (viewer.controls) {
      viewer.controls.target.copy(target);
    }
  }
  function getMaterial() {
    const splatMesh = viewer ? viewer.getSplatMesh() : null;
    return splatMesh ? splatMesh.material : null;
  }
  function getSceneBoundsForFilters() {
    return { center: sceneCenter.clone(), maxDim: sceneMaxDim };
  }

  function dispose() {
    disposed = true;
    detachInteraction();
    if (clipGizmoMesh && viewer) {
      viewer.threeScene.remove(clipGizmoMesh);
      clipGizmoMesh.geometry.dispose();
      clipGizmoMesh.material.dispose();
      clipGizmoMesh = null;
    }
    if (viewer) {
      viewer.dispose();
      viewer = null;
    }
  }

  function getSplatMesh() {
    return viewer ? viewer.getSplatMesh() : null;
  }

  // Canvas + a render-now hook for the PNG snapshot feature below --
  // viewer.renderer.domElement is the live WebGL canvas gaussian-splats-3d
  // draws into; forceRenderNextFrame() guarantees a fresh frame is drawn
  // before we read pixels back out (the canvas is not preserveDrawingBuffer,
  // so capturing stale/cleared pixels is possible without this).
  function getCanvas() {
    return viewer && viewer.renderer ? viewer.renderer.domElement : null;
  }
  function forceRender() {
    if (viewer) viewer.forceRenderNextFrame();
  }
  // Synchronous, immediate render -- bypasses the library's own rAF-driven
  // selfDrivenUpdate() loop entirely. Needed for video export: automated/
  // throttled browser tabs (and, more generally, any tab not in the
  // foreground) can throttle requestAnimationFrame down to just a few Hz,
  // which would otherwise desync the recording loop's real-time pacing
  // from when a frame actually gets drawn, corrupting the exported video's
  // duration. Mirrors exactly what selfDrivenUpdate() does per rAF tick:
  // update() (recomputes the splat sort/position buffers for the current
  // camera -- skipping this is why an early version of this function
  // produced a video frozen on the first frame, since render() alone just
  // redraws whatever was last sorted) then render() (actually draws it).
  function renderNow() {
    if (!viewer) return;
    if (typeof viewer.update === "function") viewer.update();
    if (typeof viewer.render === "function") viewer.render();
  }

  // Current camera position + orbit target, for shareable-view URLs (see
  // notifyCameraSettled() / applyCameraStateFromHash() below). Rounded to
  // 3 decimals -- splat-scale units, not meters, so this is already far
  // finer than visually distinguishable and keeps the URL hash short.
  function getCameraState() {
    if (!viewer || !viewer.camera) return null;
    const round = (v) => Math.round(v * 1000) / 1000;
    const p = viewer.camera.position;
    const t = viewer.controls ? viewer.controls.target : null;
    return {
      position: [round(p.x), round(p.y), round(p.z)],
      target: t ? [round(t.x), round(t.y), round(t.z)] : [0, 0, 0],
    };
  }

  return {
    load,
    activate,
    deactivate,
    dispose,
    getSplatMesh,
    getCanvas,
    forceRender,
    renderNow,
    getCameraState,
    onAutoOrbitToggled,
    applyFilters,
    suspendAutomation,
    resumeAutomation,
    setLiveCamera,
    getMaterial,
    getSceneBoundsForFilters,
  };
}

// ---- Export: build .ply / .splat files from the currently loaded splat
// mesh (the data actually resident in the viewer, read back splat-by-
// splat via GaussianSplats3D's own accessors), or just re-download the
// server's original .ksplat bytes unchanged. ----------------------------

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function clamp255(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

// Quaternion component -> uint8 as used by the .splat format (see
// SplatParser.parseStandardSplatToUncompressedSplatArray in
// gaussian-splats-3d: component = (byte - 128) / 128).
function quatComponentToByte(c) {
  return clamp255(c * 128 + 128);
}

function getSplatMeshSnapshot(splatMesh) {
  const total = splatMesh.getSplatCount();
  const centers = new Float32Array(total * 3);
  const scales = new Float32Array(total * 3);
  const rotations = new Float32Array(total * 4); // x, y, z, w
  const colors = new Uint8Array(total * 4); // r, g, b, a(opacity 0-255)

  const tmpCenter = new THREE.Vector3();
  const tmpScale = new THREE.Vector3();
  const tmpRotation = new THREE.Quaternion();
  const tmpColor = new THREE.Vector4();

  for (let i = 0; i < total; i++) {
    splatMesh.getSplatCenter(i, tmpCenter);
    splatMesh.getSplatScaleAndRotation(i, tmpScale, tmpRotation);
    splatMesh.getSplatColor(i, tmpColor);

    centers[i * 3] = tmpCenter.x;
    centers[i * 3 + 1] = tmpCenter.y;
    centers[i * 3 + 2] = tmpCenter.z;

    scales[i * 3] = tmpScale.x;
    scales[i * 3 + 1] = tmpScale.y;
    scales[i * 3 + 2] = tmpScale.z;

    rotations[i * 4] = tmpRotation.x;
    rotations[i * 4 + 1] = tmpRotation.y;
    rotations[i * 4 + 2] = tmpRotation.z;
    rotations[i * 4 + 3] = tmpRotation.w;

    colors[i * 4] = tmpColor.x;
    colors[i * 4 + 1] = tmpColor.y;
    colors[i * 4 + 2] = tmpColor.z;
    colors[i * 4 + 3] = tmpColor.w;
  }

  return { total, centers, scales, rotations, colors };
}

// Reconstructs a standard INRIA-style (SH degree 0) binary_little_endian
// .ply — the same field set gaussian-splats-3d's own PlyLoader reads back
// in (scale_0..2, rot_0..3, x/y/z, f_dc_0..2, opacity). Scale/opacity are
// re-encoded through the inverse of the exp()/sigmoid() the loader applies
// on read, so re-importing this file elsewhere reproduces the same splat.
function buildPlyBlob(snapshot) {
  const { total, centers, scales, rotations, colors } = snapshot;
  const SH_C0 = 0.28209479177387814;
  const properties = [
    "x", "y", "z",
    "nx", "ny", "nz",
    "f_dc_0", "f_dc_1", "f_dc_2",
    "opacity",
    "scale_0", "scale_1", "scale_2",
    "rot_0", "rot_1", "rot_2", "rot_3",
  ];
  const bytesPerVertex = properties.length * 4; // all float32

  const header =
    "ply\nformat binary_little_endian 1.0\n" +
    `element vertex ${total}\n` +
    properties.map((p) => `property float ${p}\n`).join("") +
    "end_header\n";
  const headerBytes = new TextEncoder().encode(header);

  const body = new ArrayBuffer(bytesPerVertex * total);
  const view = new DataView(body);
  for (let i = 0; i < total; i++) {
    let o = i * bytesPerVertex;
    view.setFloat32(o, centers[i * 3], true); o += 4;
    view.setFloat32(o, centers[i * 3 + 1], true); o += 4;
    view.setFloat32(o, centers[i * 3 + 2], true); o += 4;
    view.setFloat32(o, 0, true); o += 4; // nx (unused by splat renderers)
    view.setFloat32(o, 0, true); o += 4; // ny
    view.setFloat32(o, 0, true); o += 4; // nz

    const r = colors[i * 4] / 255, g = colors[i * 4 + 1] / 255, b = colors[i * 4 + 2] / 255;
    view.setFloat32(o, (r - 0.5) / SH_C0, true); o += 4;
    view.setFloat32(o, (g - 0.5) / SH_C0, true); o += 4;
    view.setFloat32(o, (b - 0.5) / SH_C0, true); o += 4;

    const alpha01 = Math.min(0.999999, Math.max(0.000001, colors[i * 4 + 3] / 255));
    view.setFloat32(o, -Math.log(1 / alpha01 - 1), true); o += 4; // inverse sigmoid

    view.setFloat32(o, Math.log(Math.max(scales[i * 3], 1e-8)), true); o += 4;
    view.setFloat32(o, Math.log(Math.max(scales[i * 3 + 1], 1e-8)), true); o += 4;
    view.setFloat32(o, Math.log(Math.max(scales[i * 3 + 2], 1e-8)), true); o += 4;

    // field order matches gaussian-splats-3d's own INRIAV1PlyParser read:
    // rot_0 -> quat.x, rot_1 -> quat.y, rot_2 -> quat.z, rot_3 -> quat.w
    view.setFloat32(o, rotations[i * 4], true); o += 4;
    view.setFloat32(o, rotations[i * 4 + 1], true); o += 4;
    view.setFloat32(o, rotations[i * 4 + 2], true); o += 4;
    view.setFloat32(o, rotations[i * 4 + 3], true); o += 4;
  }

  return new Blob([headerBytes, body], { type: "application/octet-stream" });
}

// Reconstructs the simple 32-byte-per-splat ".splat" row format
// (position f32x3, scale f32x3, color u8x4, rotation u8x4) used by
// antimatter15/splat and gaussian-splats-3d's own SplatParser.
function buildSplatBlob(snapshot) {
  const { total, centers, scales, rotations, colors } = snapshot;
  const rowBytes = 32;
  const buffer = new ArrayBuffer(rowBytes * total);
  const view = new DataView(buffer);
  for (let i = 0; i < total; i++) {
    let o = i * rowBytes;
    view.setFloat32(o, centers[i * 3], true); o += 4;
    view.setFloat32(o, centers[i * 3 + 1], true); o += 4;
    view.setFloat32(o, centers[i * 3 + 2], true); o += 4;

    view.setFloat32(o, scales[i * 3], true); o += 4;
    view.setFloat32(o, scales[i * 3 + 1], true); o += 4;
    view.setFloat32(o, scales[i * 3 + 2], true); o += 4;

    view.setUint8(o, colors[i * 4]); o += 1;
    view.setUint8(o, colors[i * 4 + 1]); o += 1;
    view.setUint8(o, colors[i * 4 + 2]); o += 1;
    view.setUint8(o, colors[i * 4 + 3]); o += 1;

    const qx = rotations[i * 4], qy = rotations[i * 4 + 1], qz = rotations[i * 4 + 2], qw = rotations[i * 4 + 3];
    view.setUint8(o, quatComponentToByte(qw)); o += 1;
    view.setUint8(o, quatComponentToByte(qx)); o += 1;
    view.setUint8(o, quatComponentToByte(qy)); o += 1;
    view.setUint8(o, quatComponentToByte(qz)); o += 1;
  }
  return new Blob([buffer], { type: "application/octet-stream" });
}

async function downloadCurrentSplat(format) {
  if (!currentSplatId) return;
  const entry = SPLATS.find((s) => s.id === currentSplatId);
  if (!entry) return;
  const activeController = controllers[activeKey];

  if (format === "ksplat") {
    // Identical bytes to what's served — no client-side re-encoding needed.
    const res = await fetch(entry.file);
    const blob = await res.blob();
    triggerDownload(blob, `${entry.id}.ksplat`);
    return;
  }

  if (format === "stl") {
    // Gaussian splats are ellipsoid point clouds, not meshes — turning
    // them into a watertight surface (Poisson reconstruction) is too
    // heavy to run in-browser, so this fetches a server-side-generated
    // mesh pre-built by scripts/ply_to_stl.py (see add_splat.sh / the
    // splat-pipeline repo's stl/ output) rather than re-deriving one
    // client-side from the live splat buffers.
    const res = await fetch(`./stl/${entry.id}.stl`);
    if (!res.ok) {
      console.error(`No precomputed .stl available for '${entry.id}' (status ${res.status}).`);
      return;
    }
    const blob = await res.blob();
    triggerDownload(blob, `${entry.id}.stl`);
    return;
  }

  if (format === "png") {
    // Snapshot of exactly what's on screen right now (current camera
    // angle/zoom), not a re-render from scratch -- reads the live WebGL
    // canvas back as a PNG blob. forceRender() + waiting a frame
    // guarantees the canvas holds a just-drawn frame (gaussian-splats-3d
    // only redraws when something changes, so a canvas that's been idle
    // could otherwise be stale/cleared at capture time).
    const canvas = activeController ? activeController.getCanvas() : null;
    if (!canvas) {
      console.error("No canvas available yet to snapshot.");
      return;
    }
    activeController.forceRender();
    // rAF is throttled/suspended on a backgrounded or hidden tab (confirmed
    // during testing -- a tab switched away mid-tap on mobile hits this too),
    // which would otherwise hang this export forever with zero feedback.
    // Race against a short timeout so the export always proceeds -- worst
    // case it captures a slightly-stale frame instead of a perfectly fresh
    // one, which is a much better failure mode than "nothing happens".
    await Promise.race([
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      new Promise((resolve) => setTimeout(resolve, 400)),
    ]);

    // Background choice: the splat canvas itself is cleared to alpha 0
    // (see setClearColor in the vendored gaussian-splats-3d.module.js),
    // so "transparent" is just the raw canvas bytes. A solid color is
    // composited onto an offscreen canvas first -- draw the fill, then
    // the splat canvas on top -- rather than mutating the live WebGL
    // clear color, which would need a render-and-restore dance and risk
    // visibly flashing the background on screen mid-capture. pngBgSelection
    // is set by the swatch picker further down in this file.
    let exportCanvas = canvas;
    if (pngBgSelection !== "transparent") {
      const bg = document.createElement("canvas");
      bg.width = canvas.width;
      bg.height = canvas.height;
      const ctx = bg.getContext("2d");
      ctx.fillStyle = pngBgSelection;
      ctx.fillRect(0, 0, bg.width, bg.height);
      ctx.drawImage(canvas, 0, 0);
      exportCanvas = bg;
    }

    exportCanvas.toBlob((blob) => {
      if (!blob) {
        console.error("Snapshot failed: canvas.toBlob() returned null.");
        return;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      triggerDownload(blob, `${entry.id}-${stamp}.png`);
    }, "image/png");
    return;
  }

  const splatMesh = activeController ? activeController.getSplatMesh() : null;
  if (!splatMesh || typeof splatMesh.getSplatCount !== "function" || splatMesh.getSplatCount() === 0) {
    console.error("No splat data loaded yet to export.");
    return;
  }
  const snapshot = getSplatMeshSnapshot(splatMesh);
  const blob = format === "ply" ? buildPlyBlob(snapshot) : buildSplatBlob(snapshot);
  triggerDownload(blob, `${entry.id}.${format}`);
}

// ---- Splat navigation / crossfade --------------------------------------
// The URL hash (e.g. "#dmf-dome" or "#dmf-dome@1.2,3.4,5.6,0,0,0" once a
// camera view has been shared) is the shareable address for a splat --
// pasting a link with that hash open loads straight to it (see the initial
// load IIFE below), and camera-position updates below append the view too
// once the user settles on one (auto-orbit paused, or a manual drag ends).
let suppressHashChange = false;
// A "~sequence" suffix parsed from the current/incoming hash that hasn't
// been offered to the user for import yet -- see
// maybeOfferSharedSequenceImport() near the Keyframes panel wiring.
let pendingSharedSequence = null;

// "#<splatId>" or "#<splatId>@px,py,pz,tx,ty,tz" (camera position + orbit
// target, see getCameraState() on the controller). The camera half is
// only appended once a view has actually been shared/settled on -- a
// bare splat switch (navigateToSplat with no camera arg) keeps the old
// splatId-only form so routine splat-to-splat links stay short.
function buildHash(splatId, cameraState) {
  let hash = `#${encodeURIComponent(splatId)}`;
  if (cameraState) {
    const nums = [...cameraState.position, ...cameraState.target];
    hash += `@${nums.join(",")}`;
  }
  return hash;
}

// ---- Keyframe sequence URL sharing ---------------------------------------
// A full keyframe sequence (camera path + color/clip settings + playback
// timing) can be packed into a "~<base64url>" suffix on the URL hash, e.g.
// "#dmf-dome~eyJoIjoyLCJ0IjozLC..." -- pasting that link elsewhere offers
// the recipient an "import this sequence" prompt (see
// maybeOfferSharedSequenceImport() near the Keyframes panel wiring) rather
// than silently overwriting whatever sequence they already have saved
// locally for that splat.
//
// Encoding: numbers are rounded to keep the string short (position/target
// to 3 decimals, color/rotation degrees to 1, scale to 3), keys are
// single/double-letter, and the whole minified JSON blob is base64url-
// encoded (URL-safe alphabet, no padding) so it drops straight into a URL
// hash with no further escaping needed.
function roundTo(v, decimals) {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

function packKeyframeForUrl(kf) {
  const c = kf.color;
  const cl = kf.clip;
  return [
    kf.label || "",
    ...kf.position.map((v) => roundTo(v, 3)),
    ...kf.target.map((v) => roundTo(v, 3)),
    roundTo(c.hueDeg, 1), roundTo(c.saturation, 2), roundTo(c.brightness, 2), roundTo(c.contrast, 2), roundTo(c.gamma, 2),
    cl.enabled ? 1 : 0, cl.shape === "sphere" ? 1 : 0, cl.invert ? 1 : 0, cl.showGizmo ? 1 : 0,
    roundTo(cl.position.x, 3), roundTo(cl.position.y, 3), roundTo(cl.position.z, 3),
    roundTo(cl.scale.x, 3), roundTo(cl.scale.y, 3), roundTo(cl.scale.z, 3),
    roundTo(cl.rotationDeg.x, 1), roundTo(cl.rotationDeg.y, 1), roundTo(cl.rotationDeg.z, 1),
  ];
}

function unpackKeyframeFromUrl(arr, index) {
  const [
    label, px, py, pz, tx, ty, tz,
    hueDeg, saturation, brightness, contrast, gamma,
    clipEnabled, clipShape, clipInvert, clipShowGizmo,
    cpx, cpy, cpz, csx, csy, csz, crx, cry, crz,
  ] = arr;
  return {
    id: `kf-shared-${Date.now()}-${index}`,
    label: label || `Keyframe ${index + 1}`,
    position: [px, py, pz],
    target: [tx, ty, tz],
    color: { hueDeg, saturation, brightness, contrast, gamma },
    clip: {
      enabled: !!clipEnabled,
      shape: clipShape ? "sphere" : "box",
      invert: !!clipInvert,
      showGizmo: !!clipShowGizmo,
      position: { x: cpx, y: cpy, z: cpz },
      scale: { x: csx, y: csy, z: csz },
      rotationDeg: { x: crx, y: cry, z: crz },
    },
  };
}

function base64UrlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(b64url) {
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// Returns null if there are no keyframes to share.
function encodeSequenceForUrl(keyframes, holdS, transitionS, loop) {
  if (!keyframes || keyframes.length === 0) return null;
  const packed = {
    h: roundTo(holdS, 1),
    t: roundTo(transitionS, 1),
    l: loop ? 1 : 0,
    k: keyframes.map(packKeyframeForUrl),
  };
  try {
    return base64UrlEncode(JSON.stringify(packed));
  } catch (err) {
    console.error("Failed to encode keyframe sequence for URL:", err);
    return null;
  }
}

// Returns { keyframes, holdS, transitionS, loop } or null if the string is
// missing/malformed -- malformed input (hand-edited/truncated URL) should
// never hard-crash the viewer, just silently offer nothing to import.
function decodeSequenceFromUrl(b64url) {
  try {
    const packed = JSON.parse(base64UrlDecode(b64url));
    if (!packed || !Array.isArray(packed.k)) return null;
    return {
      holdS: typeof packed.h === "number" ? packed.h : 2,
      transitionS: typeof packed.t === "number" ? packed.t : 3,
      loop: !!packed.l,
      keyframes: packed.k.map((arr, i) => unpackKeyframeFromUrl(arr, i)),
    };
  } catch {
    return null;
  }
}


function setHashForSplat(splatId, replace, cameraState) {
  suppressHashChange = true;
  const url = `${location.pathname}${location.search}${buildHash(splatId, cameraState)}`;
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  // Rendering is driven entirely by in-memory state, not by 'hashchange' --
  // this flag just stops our own pushState from re-triggering navigation.
  setTimeout(() => { suppressHashChange = false; }, 0);
}

// Parses "<splatId>", "<splatId>@px,py,pz,tx,ty,tz", and/or a trailing
// "~<base64url-sequence>" from location.hash. The "~sequence" suffix can
// appear on its own or after a "@camera" suffix (e.g.
// "dmf-dome@1,2,3,0,0,0~eyJo...") -- it's always the last segment.
// Returns { splatId, cameraState, sharedSequence } with each half null
// when absent or malformed (a hand-edited/truncated URL shouldn't hard
// crash the viewer -- it just falls back to defaults for that part).
function parseHash() {
  let raw = location.hash.replace(/^#/, "");
  if (!raw) return { splatId: null, cameraState: null, sharedSequence: null };

  let sharedSequence = null;
  const tildeIndex = raw.indexOf("~");
  if (tildeIndex !== -1) {
    sharedSequence = decodeSequenceFromUrl(raw.slice(tildeIndex + 1));
    raw = raw.slice(0, tildeIndex);
  }

  const atIndex = raw.indexOf("@");
  if (atIndex === -1) {
    return { splatId: decodeURIComponent(raw), cameraState: null, sharedSequence };
  }
  const splatId = decodeURIComponent(raw.slice(0, atIndex));
  const nums = raw.slice(atIndex + 1).split(",").map(Number);
  if (nums.length !== 6 || nums.some((n) => Number.isNaN(n))) {
    return { splatId, cameraState: null, sharedSequence };
  }
  return {
    splatId,
    cameraState: { position: nums.slice(0, 3), target: nums.slice(3, 6) },
    sharedSequence,
  };
}

// Called whenever the active layer's camera "settles" on a view worth
// sharing: OrbitControls' 'end' event (real user drag/pinch/wheel just
// finished -- see the listener wired in createController.load()), or the
// auto-orbit pause button being pressed (see the auto-orbit wiring further
// down). Ignores events from a background/transitioning layer so a splat
// crossfade mid-flight never clobbers the hash with a stale camera state.
function notifyCameraSettled(layerKey) {
  if (layerKey !== activeKey || transitioning || !currentSplatId) return;
  const controller = controllers[activeKey];
  const cameraState = controller ? controller.getCameraState() : null;
  if (!cameraState) return;
  // replaceState, not pushState: a drag can end many times per session
  // and shouldn't flood browser history -- the URL stays shareable either
  // way since replaceState still updates the visible address bar.
  setHashForSplat(currentSplatId, true, cameraState);
}


async function navigateToSplat(splatId, options = {}) {
  if (transitioning || splatId === currentSplatId) return;
  const entry = SPLATS.find((s) => s.id === splatId);
  if (!entry) return;
  transitioning = true;

  const incomingKey = otherKey(activeKey);
  const outgoingKey = activeKey;

  const incoming = createController(incomingKey);
  controllers[incomingKey] = incoming;

  try {
    await incoming.load(entry, options.cameraState || null);
  } catch (err) {
    console.error("Failed to load splat", splatId, err);
    incoming.dispose();
    controllers[incomingKey] = null;
    transitioning = false;
    return;
  }

  incoming.activate();
  const outgoing = controllers[outgoingKey];
  if (outgoing) outgoing.deactivate();

  currentSplatId = splatId;
  activeKey = incomingKey;
  updateCurrentLabel(entry);
  if (!options.skipHashUpdate) setHashForSplat(splatId, options.replaceHash);

  setTimeout(() => {
    if (outgoing) outgoing.dispose();
    controllers[outgoingKey] = null;
    transitioning = false;
  }, CROSSFADE_MS + 100);
}

function updateCurrentLabel(entry) {
  if (currentLabelEl) currentLabelEl.textContent = entry ? entry.label : "";
}

// ---- Initial load -------------------------------------------------------
(async () => {
  try {
    const res = await fetch("./manifest.json");
    const data = await res.json();
    SPLATS = data.splats || [];
  } catch (err) {
    console.error("Failed to load manifest.json:", err);
    SPLATS = [];
  }

  if (SPLATS.length === 0) {
    if (loadingEl) loadingEl.remove();
    return;
  }

  // Deep link: "#<id>" or "#<id>@camera..." in the address bar picks the
  // initial splat (and camera view, if present) instead of always
  // defaulting to SPLATS[0] + the auto-fit camera. A trailing "~sequence"
  // suffix (see decodeSequenceFromUrl) is stashed in pendingSharedSequence
  // for the Keyframes panel to offer importing once it finishes wiring up.
  const { splatId: hashId, cameraState: hashCameraState, sharedSequence: initialSharedSequence } = parseHash();
  if (initialSharedSequence) {
    pendingSharedSequence = initialSharedSequence;
    // maybeOfferSharedSequenceImport is defined later in this file but
    // hoisted (plain function declaration) -- by the time this IIFE
    // resumes past its first "await fetch(manifest.json)" the whole
    // module has already finished executing synchronously (including
    // defining that function), so calling it here is safe.
    maybeOfferSharedSequenceImport();
  }
  const hashEntry = hashId ? SPLATS.find((s) => s.id === hashId) : null;
  const initialEntry = hashEntry || SPLATS[0];
  const initialCameraState = hashEntry ? hashCameraState : null;

  const initial = createController(activeKey);
  controllers[activeKey] = initial;
  try {
    await initial.load(initialEntry, initialCameraState);
    currentSplatId = initialEntry.id;
    updateCurrentLabel(initialEntry);
    initial.activate();
    // Normalize the address bar to the splat actually loaded (covers both
    // a bare "/" with no hash yet, and an invalid/unknown hash that fell
    // back to SPLATS[0]) -- replaceState so this doesn't add a history
    // entry. Preserves the camera state if one was successfully loaded
    // from the hash, so a hard refresh on a shared-view URL doesn't
    // silently drop the "@..." camera suffix.
    setHashForSplat(initialEntry.id, true, initialCameraState);
  } catch (err) {
    console.error("Gaussian Splat gallery failed to load:", err);
  } finally {
    if (loadingEl) {
      loadingEl.classList.add("done");
      setTimeout(() => loadingEl.remove(), 700);
    }
  }
})();

// Back/forward navigation, or manually editing the hash in the address bar.
window.addEventListener("hashchange", () => {
  if (suppressHashChange) return;
  const { splatId: hashId, cameraState, sharedSequence } = parseHash();
  if (sharedSequence) {
    pendingSharedSequence = sharedSequence;
    maybeOfferSharedSequenceImport();
  }
  if (!hashId) return;
  const entry = SPLATS.find((s) => s.id === hashId);
  if (!entry) return;
  // The hash already reflects the destination -- don't push/replace again.
  navigateToSplat(hashId, { skipHashUpdate: true, cameraState });
});

// ---- Hamburger toggleable splat list ------------------------------------
const hamburgerEl = document.getElementById("menu-overview-btn");
const menuListEl = document.getElementById("menu-list");
const menuListUl = menuListEl ? menuListEl.querySelector("ul") : null;

function buildMenuList() {
  if (!menuListUl) return;
  menuListUl.innerHTML = "";
  // Newest splats first (manifest.json is append-order/oldest-first since
  // add_splat.sh appends each new splat to the end) -- reversing here means
  // whatever was just created is visible immediately without scrolling,
  // while the scrollable panel (see styles.css #menu-list) still lets you
  // reach older entries further down.
  const ordered = SPLATS.slice().reverse();
  for (const entry of ordered) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `#${encodeURIComponent(entry.id)}`; // real shareable deep link, not just a click hook
    a.textContent = entry.label;
    if (entry.id === currentSplatId) {
      a.classList.add("current");
    } else {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        navigateToSplat(entry.id);
        closeMenuList();
      });
    }
    if (entry.created) {
      const dateSpan = document.createElement("span");
      dateSpan.className = "menu-date";
      dateSpan.textContent = entry.created;
      a.appendChild(dateSpan);
    }
    li.appendChild(a);
    menuListUl.appendChild(li);
  }
}

function openMenuList() {
  if (!menuListEl) return;
  buildMenuList();
  menuListEl.classList.add("open");
  menuListEl.setAttribute("aria-hidden", "false");
  if (hamburgerEl) hamburgerEl.setAttribute("aria-expanded", "true");
}

function closeMenuList() {
  if (!menuListEl) return;
  menuListEl.classList.remove("open");
  menuListEl.setAttribute("aria-hidden", "true");
  if (hamburgerEl) hamburgerEl.setAttribute("aria-expanded", "false");
}

function toggleMenuList() {
  if (!menuListEl) return;
  if (menuListEl.classList.contains("open")) closeMenuList();
  else openMenuList();
}

if (hamburgerEl) {
  hamburgerEl.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenuList();
  });
}
document.addEventListener("click", (e) => {
  if (!menuListEl || !menuListEl.classList.contains("open")) return;
  if (menuListEl.contains(e.target) || (hamburgerEl && hamburgerEl.contains(e.target))) return;
  closeMenuList();
});

// ---- Download button: export the splat currently on screen -------------
const downloadBtnEl = document.getElementById("download-btn");
const downloadMenuEl = document.getElementById("download-menu");
const downloadMenuUl = downloadMenuEl ? downloadMenuEl.querySelector("ul") : null;

// PNG background swatch picker -- see index.html for the markup. Selection
// state lives here (not re-derived from the DOM on every export) so the
// choice persists across repeated snapshots and survives buildDownloadMenu()
// rebuilding the <ul> on each menu open (the swatch row itself is never
// rebuilt, only its aria-pressed/selected styling updates).
let pngBgSelection = "transparent"; // "transparent" | "#rrggbb"
const pngBgSwatchesEl = document.getElementById("png-bg-swatches");
const pngBgCustomInputEl = document.getElementById("png-bg-color-input");
const pngBgCustomSwatchEl = pngBgCustomInputEl ? pngBgCustomInputEl.closest(".png-bg-swatch-custom") : null;

function selectPngBgSwatch(color) {
  pngBgSelection = color;
  if (!pngBgSwatchesEl) return;
  for (const btn of pngBgSwatchesEl.querySelectorAll(".png-bg-swatch")) {
    const isCustom = btn === pngBgCustomSwatchEl;
    const btnColor = isCustom ? pngBgCustomInputEl.value : btn.dataset.color;
    btn.setAttribute("aria-pressed", String(btnColor === color));
  }
}

if (pngBgSwatchesEl) {
  for (const btn of pngBgSwatchesEl.querySelectorAll("button.png-bg-swatch")) {
    btn.addEventListener("click", () => selectPngBgSwatch(btn.dataset.color));
  }
}
if (pngBgCustomInputEl && pngBgCustomSwatchEl) {
  pngBgCustomSwatchEl.dataset.hasValue = "false";
  pngBgCustomInputEl.addEventListener("input", () => {
    // Reflects the picked color onto the swatch face itself so "custom"
    // isn't just a static "+" forever -- same affordance as the preset
    // swatches, once a color has actually been chosen.
    pngBgCustomSwatchEl.style.background = pngBgCustomInputEl.value;
    pngBgCustomSwatchEl.dataset.hasValue = "true";
    selectPngBgSwatch(pngBgCustomInputEl.value);
  });
}

const DOWNLOAD_FORMATS = [
  { format: "png", label: "Download snapshot (.png)" },
  { format: "ply", label: "Download as .ply" },
  { format: "splat", label: "Download as .splat" },
  { format: "ksplat", label: "Download as .ksplat" },
  { format: "stl", label: "Download as .stl (mesh)" },
];

function buildDownloadMenu() {
  if (!downloadMenuUl) return;
  downloadMenuUl.innerHTML = "";
  for (const { format, label } of DOWNLOAD_FORMATS) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", (e) => {
      e.preventDefault();
      closeDownloadMenu();
      downloadCurrentSplat(format).catch((err) => console.error("Download failed:", err));
    });
    li.appendChild(button);
    downloadMenuUl.appendChild(li);
  }
}

function openDownloadMenu() {
  if (!downloadMenuEl) return;
  buildDownloadMenu();
  downloadMenuEl.classList.add("open");
  downloadMenuEl.setAttribute("aria-hidden", "false");
  if (downloadBtnEl) downloadBtnEl.setAttribute("aria-expanded", "true");
}

function closeDownloadMenu() {
  if (!downloadMenuEl) return;
  downloadMenuEl.classList.remove("open");
  downloadMenuEl.setAttribute("aria-hidden", "true");
  if (downloadBtnEl) downloadBtnEl.setAttribute("aria-expanded", "false");
}

function toggleDownloadMenu() {
  if (!downloadMenuEl) return;
  if (downloadMenuEl.classList.contains("open")) closeDownloadMenu();
  else openDownloadMenu();
}

if (downloadBtnEl) {
  downloadBtnEl.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleDownloadMenu();
  });
}
document.addEventListener("click", (e) => {
  if (!downloadMenuEl || !downloadMenuEl.classList.contains("open")) return;
  if (downloadMenuEl.contains(e.target) || (downloadBtnEl && downloadBtnEl.contains(e.target))) return;
  closeDownloadMenu();
});

// ---- Auto-orbit toggle button + "R" keyboard shortcut -------------------
const autoOrbitBtnEl = document.getElementById("auto-orbit-btn");

function reflectAutoOrbitState(enabled) {
  if (!autoOrbitBtnEl) return;
  autoOrbitBtnEl.setAttribute("aria-pressed", String(enabled));
  autoOrbitBtnEl.setAttribute(
    "aria-label",
    enabled ? "Stop automatic camera movement" : "Start automatic camera movement"
  );
}

reflectAutoOrbitState(isAutoOrbitEnabled());
onAutoOrbitChange(reflectAutoOrbitState);

if (autoOrbitBtnEl) {
  autoOrbitBtnEl.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleAutoOrbit();
  });
}

// "R" for "rotate" — matches the single-letter convention of this viewer's
// other toggles (I/O/P/C/U). Ignores presses while a text input/textarea
// has focus (none currently exist in this page, but keeps this robust if
// one's ever added) so typing "r" elsewhere never accidentally toggles it.
window.addEventListener("keydown", (e) => {
  if (e.code !== "KeyR") return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  toggleAutoOrbit();
});

// ---- Adjust panel: color grading + clip volume -------------------------
// Pushes FILTERS into every live controller's splat material/gizmo, then
// persists to localStorage. Called by every slider/checkbox listener below.
function applyFiltersToAllControllers() {
  for (const key of Object.keys(controllers)) {
    const controller = controllers[key];
    if (controller) controller.applyFilters();
  }
  persistFilters();
}

const adjustBtnEl = document.getElementById("adjust-btn");
const adjustPanelEl = document.getElementById("adjust-panel");

function openAdjustPanel() {
  if (!adjustPanelEl) return;
  adjustPanelEl.classList.add("open");
  adjustPanelEl.setAttribute("aria-hidden", "false");
  if (adjustBtnEl) adjustBtnEl.setAttribute("aria-expanded", "true");
}
function closeAdjustPanel() {
  if (!adjustPanelEl) return;
  adjustPanelEl.classList.remove("open");
  adjustPanelEl.setAttribute("aria-hidden", "true");
  if (adjustBtnEl) adjustBtnEl.setAttribute("aria-expanded", "false");
}
function toggleAdjustPanel() {
  if (!adjustPanelEl) return;
  if (adjustPanelEl.classList.contains("open")) closeAdjustPanel();
  else openAdjustPanel();
}
if (adjustBtnEl) {
  adjustBtnEl.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleAdjustPanel();
  });
}
document.addEventListener("click", (e) => {
  if (!adjustPanelEl || !adjustPanelEl.classList.contains("open")) return;
  if (adjustPanelEl.contains(e.target) || (adjustBtnEl && adjustBtnEl.contains(e.target))) return;
  closeAdjustPanel();
});

// Binds a <input type="range"> + its <output> display to a FILTERS leaf
// value. `format` renders the output text; `toStored`/parse float by
// default. Reads the slider's own current DOM value as the initial display
// (index.html's markup default matches defaultFilters(), but this also
// correctly reflects a value restored from localStorage via `initial`).
function bindRange(id, outputId, initial, format, onChange) {
  const input = document.getElementById(id);
  const output = document.getElementById(outputId);
  if (!input) return;
  input.value = String(initial);
  if (output) output.textContent = format(initial);
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    if (output) output.textContent = format(v);
    onChange(v);
  });
}

function bindCheckbox(id, initial, onChange) {
  const input = document.getElementById(id);
  if (!input) return;
  input.checked = initial;
  input.addEventListener("change", () => onChange(input.checked));
}

const deg = (v) => `${Math.round(v)}\u00b0`;
const fixed2 = (v) => v.toFixed(2);

// ---- Color section -------------------------------------------------------
bindRange("adj-hue", "adj-hue-val", FILTERS.color.hueDeg, deg, (v) => {
  FILTERS.color.hueDeg = v;
  applyFiltersToAllControllers();
});
bindRange("adj-saturation", "adj-saturation-val", FILTERS.color.saturation, fixed2, (v) => {
  FILTERS.color.saturation = v;
  applyFiltersToAllControllers();
});
bindRange("adj-brightness", "adj-brightness-val", FILTERS.color.brightness, fixed2, (v) => {
  FILTERS.color.brightness = v;
  applyFiltersToAllControllers();
});
bindRange("adj-contrast", "adj-contrast-val", FILTERS.color.contrast, fixed2, (v) => {
  FILTERS.color.contrast = v;
  applyFiltersToAllControllers();
});
bindRange("adj-gamma", "adj-gamma-val", FILTERS.color.gamma, fixed2, (v) => {
  FILTERS.color.gamma = v;
  applyFiltersToAllControllers();
});

document.querySelectorAll('.adjust-reset[data-reset="color"]').forEach((btn) => {
  btn.addEventListener("click", () => {
    FILTERS.color = defaultFilters().color;
    bindRange("adj-hue", "adj-hue-val", FILTERS.color.hueDeg, deg, (v) => {
      FILTERS.color.hueDeg = v;
      applyFiltersToAllControllers();
    });
    bindRange("adj-saturation", "adj-saturation-val", FILTERS.color.saturation, fixed2, (v) => {
      FILTERS.color.saturation = v;
      applyFiltersToAllControllers();
    });
    bindRange("adj-brightness", "adj-brightness-val", FILTERS.color.brightness, fixed2, (v) => {
      FILTERS.color.brightness = v;
      applyFiltersToAllControllers();
    });
    bindRange("adj-contrast", "adj-contrast-val", FILTERS.color.contrast, fixed2, (v) => {
      FILTERS.color.contrast = v;
      applyFiltersToAllControllers();
    });
    bindRange("adj-gamma", "adj-gamma-val", FILTERS.color.gamma, fixed2, (v) => {
      FILTERS.color.gamma = v;
      applyFiltersToAllControllers();
    });
    applyFiltersToAllControllers();
  });
});

// ---- Clip volume section --------------------------------------------------
bindCheckbox("adj-clip-enabled", FILTERS.clip.enabled, (v) => {
  FILTERS.clip.enabled = v;
  applyFiltersToAllControllers();
});
bindCheckbox("adj-clip-gizmo", FILTERS.clip.showGizmo, (v) => {
  FILTERS.clip.showGizmo = v;
  applyFiltersToAllControllers();
});
bindCheckbox("adj-clip-invert", FILTERS.clip.invert, (v) => {
  FILTERS.clip.invert = v;
  applyFiltersToAllControllers();
});

document.querySelectorAll('input[name="adj-clip-shape"]').forEach((radio) => {
  radio.checked = radio.value === FILTERS.clip.shape;
  radio.addEventListener("change", () => {
    if (!radio.checked) return;
    FILTERS.clip.shape = radio.value;
    applyFiltersToAllControllers();
  });
});

for (const axis of ["x", "y", "z"]) {
  bindRange(`adj-clip-pos-${axis}`, `adj-clip-pos-${axis}-val`, FILTERS.clip.position[axis], fixed2, (v) => {
    FILTERS.clip.position[axis] = v;
    applyFiltersToAllControllers();
  });
  bindRange(`adj-clip-scale-${axis}`, `adj-clip-scale-${axis}-val`, FILTERS.clip.scale[axis], fixed2, (v) => {
    FILTERS.clip.scale[axis] = v;
    applyFiltersToAllControllers();
  });
  bindRange(`adj-clip-rot-${axis}`, `adj-clip-rot-${axis}-val`, FILTERS.clip.rotationDeg[axis], deg, (v) => {
    FILTERS.clip.rotationDeg[axis] = v;
    applyFiltersToAllControllers();
  });
}

function refreshClipUIFromFilters() {
  const c = FILTERS.clip;
  const enabledEl = document.getElementById("adj-clip-enabled");
  if (enabledEl) enabledEl.checked = c.enabled;
  const gizmoEl = document.getElementById("adj-clip-gizmo");
  if (gizmoEl) gizmoEl.checked = c.showGizmo;
  const invertEl = document.getElementById("adj-clip-invert");
  if (invertEl) invertEl.checked = c.invert;
  document.querySelectorAll('input[name="adj-clip-shape"]').forEach((radio) => {
    radio.checked = radio.value === c.shape;
  });
  for (const axis of ["x", "y", "z"]) {
    bindRange(`adj-clip-pos-${axis}`, `adj-clip-pos-${axis}-val`, c.position[axis], fixed2, (v) => {
      FILTERS.clip.position[axis] = v;
      applyFiltersToAllControllers();
    });
    bindRange(`adj-clip-scale-${axis}`, `adj-clip-scale-${axis}-val`, c.scale[axis], fixed2, (v) => {
      FILTERS.clip.scale[axis] = v;
      applyFiltersToAllControllers();
    });
    bindRange(`adj-clip-rot-${axis}`, `adj-clip-rot-${axis}-val`, c.rotationDeg[axis], deg, (v) => {
      FILTERS.clip.rotationDeg[axis] = v;
      applyFiltersToAllControllers();
    });
  }
}

document.querySelectorAll('.adjust-reset[data-reset="clip"]').forEach((btn) => {
  btn.addEventListener("click", () => {
    FILTERS.clip = defaultFilters().clip;
    refreshClipUIFromFilters();
    applyFiltersToAllControllers();
  });
});

// Push whatever filters were restored from localStorage (or defaults) into
// any controller that's already loaded by the time this script section runs
// (initial load's IIFE above is async, so this is usually a no-op the very
// first time, but matters for e.g. a hard reload racing this script).
applyFiltersToAllControllers();

// =========================================================================
// ---- Keyframe sequences: capture camera + color/clip state, preview a
// smooth flythrough, and record/export it as a video. --------------------
// =========================================================================
//
// A "keyframe" is a snapshot of: camera position, orbit target, and the
// full FILTERS object (color grading + clip volume) at the moment it was
// captured. Sequences are stored per-splat-id in localStorage so switching
// splats automatically swaps in that splat's own saved sequence.
//
// Interpolation: camera position and orbit target are each fit with a
// Catmull-Rom spline through all keyframe points (THREE.CatmullRomCurve3)
// for a smooth flythrough rather than straight linear hops between
// keyframes; filter values (hue/saturation/etc, clip position/scale/
// rotation) are plain per-segment lerps. Playback alternates HOLD_S
// (camera parked exactly on a keyframe) and TRANSITION_S (moving to the
// next one) -- both durations are user-adjustable in the panel.

const KEYFRAMES_STORAGE_PREFIX = "gs-gallery-keyframes-";

function keyframesStorageKey(splatId) {
  return `${KEYFRAMES_STORAGE_PREFIX}${splatId}`;
}

function loadSequenceFor(splatId) {
  try {
    const raw = localStorage.getItem(keyframesStorageKey(splatId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSequenceFor(splatId, keyframes) {
  try {
    localStorage.setItem(keyframesStorageKey(splatId), JSON.stringify(keyframes));
  } catch {
    /* storage unavailable -- sequence just won't persist */
  }
}

// ---- KeyframePlayer: owns the active splat's keyframe list + playback/
// recording state. Re-pointed at a new splat's sequence by
// setActiveSplatForKeyframes() (called from navigateToSplat() and the
// initial-load IIFE above) so the panel always reflects the splat on
// screen. --------------------------------------------------------------
const KeyframePlayer = (() => {
  let activeSplatId = null;
  let keyframes = [];
  let playing = false;
  let recording = false;
  let rafId = null;
  let playStartTime = 0;
  let onStateChange = () => {};

  // Playback tunables, read live from the panel's sliders -- see
  // wireKeyframesPanel() below.
  function getHoldSeconds() {
    const el = document.getElementById("kf-hold-s");
    return el ? parseFloat(el.value) : 2;
  }
  function getTransitionSeconds() {
    const el = document.getElementById("kf-transition-s");
    return el ? parseFloat(el.value) : 3;
  }
  function getLoop() {
    const el = document.getElementById("kf-loop");
    return el ? el.checked : false;
  }

  function setActiveSplat(splatId) {
    stop();
    activeSplatId = splatId;
    keyframes = loadSequenceFor(splatId);
    onStateChange();
  }

  function getKeyframes() {
    return keyframes;
  }

  function persist() {
    if (activeSplatId) saveSequenceFor(activeSplatId, keyframes);
  }

  // Captures the CURRENTLY ACTIVE controller's live camera + FILTERS state
  // as a new keyframe appended to the end of the sequence.
  function addKeyframe() {
    const controller = controllers[activeKey];
    if (!controller) return null;
    const cameraState = controller.getCameraState();
    if (!cameraState) return null;
    const kf = {
      id: `kf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      label: `Keyframe ${keyframes.length + 1}`,
      position: cameraState.position,
      target: cameraState.target,
      color: JSON.parse(JSON.stringify(FILTERS.color)),
      clip: JSON.parse(JSON.stringify(FILTERS.clip)),
    };
    keyframes.push(kf);
    persist();
    onStateChange();
    return kf;
  }

  function removeKeyframe(id) {
    keyframes = keyframes.filter((k) => k.id !== id);
    persist();
    onStateChange();
  }

  // Overwrites EVERY keyframe's stored color+clip snapshot with the
  // CURRENT live FILTERS state, leaving each keyframe's camera
  // position/target untouched. Lets a user dial in grading/clip settings
  // once (via the Adjust panel) and stamp them onto an already-built
  // camera path, so the same move can be re-recorded with different looks
  // without re-capturing every keyframe from scratch.
  function applyCurrentFiltersToAllKeyframes() {
    if (keyframes.length === 0) return 0;
    const color = JSON.parse(JSON.stringify(FILTERS.color));
    const clip = JSON.parse(JSON.stringify(FILTERS.clip));
    for (const kf of keyframes) {
      kf.color = JSON.parse(JSON.stringify(color));
      kf.clip = JSON.parse(JSON.stringify(clip));
    }
    persist();
    onStateChange();
    return keyframes.length;
  }

  // Single-keyframe counterpart: overwrites just ONE keyframe's stored
  // color+clip snapshot with the current live FILTERS state, leaving its
  // camera position/target AND every other keyframe untouched. Lets a
  // user vary the look across a sequence intentionally (e.g. grade shot 1
  // differently from shot 3) instead of always applying one look
  // uniformly. Returns false if the id doesn't exist (keyframe removed
  // mid-interaction).
  function applyCurrentFiltersToKeyframe(id) {
    const kf = keyframes.find((k) => k.id === id);
    if (!kf) return false;
    kf.color = JSON.parse(JSON.stringify(FILTERS.color));
    kf.clip = JSON.parse(JSON.stringify(FILTERS.clip));
    persist();
    onStateChange();
    return true;
  }

  function renameKeyframe(id, label) {
    const kf = keyframes.find((k) => k.id === id);
    if (!kf) return;
    kf.label = label || kf.label;
    persist();
  }

  function reorder(fromIndex, toIndex) {
    if (fromIndex === toIndex) return;
    const [moved] = keyframes.splice(fromIndex, 1);
    keyframes.splice(toIndex, 0, moved);
    persist();
    onStateChange();
  }

  // Replaces the ENTIRE sequence with the given keyframes -- used when
  // importing a shared "~sequence" link (see maybeOfferSharedSequenceImport
  // near the Keyframes panel wiring). Only applies if there's an active
  // splat loaded to persist against.
  function replaceAllKeyframes(newKeyframes) {
    if (!activeSplatId) return;
    keyframes = newKeyframes || [];
    persist();
    onStateChange();
  }

  // Jumps the live camera straight to one keyframe (no transition) -- used
  // when clicking a keyframe's label in the list to preview just that shot.
  function jumpTo(id) {
    const kf = keyframes.find((k) => k.id === id);
    const controller = controllers[activeKey];
    if (!kf || !controller) return;
    controller.suspendAutomation();
    controller.setLiveCamera(
      new THREE.Vector3(kf.position[0], kf.position[1], kf.position[2]),
      new THREE.Vector3(kf.target[0], kf.target[1], kf.target[2])
    );
    applyFilterSnapshotToController(controller, kf.color, kf.clip);
    controller.forceRender();
  }

  // ---- Interpolation ----------------------------------------------------
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  function lerpAngleDeg(a, b, t) {
    // Shortest-path lerp around the 360deg circle (hue, rotation axes) so a
    // 350deg -> 10deg transition spins 20deg forward, not 340deg backward.
    let diff = ((b - a + 540) % 360) - 180;
    return a + diff * t;
  }
  function lerpColor(a, b, t) {
    return {
      hueDeg: lerpAngleDeg(a.hueDeg, b.hueDeg, t),
      saturation: lerp(a.saturation, b.saturation, t),
      brightness: lerp(a.brightness, b.brightness, t),
      contrast: lerp(a.contrast, b.contrast, t),
      gamma: lerp(a.gamma, b.gamma, t),
    };
  }
  function lerpClip(a, b, t) {
    // Shape/enabled/invert/showGizmo are discrete -- snap to the segment's
    // starting keyframe's value for the whole transition rather than
    // interpolating something meaningless like "40% box, 60% sphere".
    return {
      enabled: a.enabled,
      shape: a.shape,
      invert: a.invert,
      showGizmo: a.showGizmo,
      position: {
        x: lerp(a.position.x, b.position.x, t),
        y: lerp(a.position.y, b.position.y, t),
        z: lerp(a.position.z, b.position.z, t),
      },
      scale: {
        x: lerp(a.scale.x, b.scale.x, t),
        y: lerp(a.scale.y, b.scale.y, t),
        z: lerp(a.scale.z, b.scale.z, t),
      },
      rotationDeg: {
        x: lerpAngleDeg(a.rotationDeg.x, b.rotationDeg.x, t),
        y: lerpAngleDeg(a.rotationDeg.y, b.rotationDeg.y, t),
        z: lerpAngleDeg(a.rotationDeg.z, b.rotationDeg.z, t),
      },
    };
  }

  // Pushes an explicit (not-FILTERS-global) color/clip snapshot into one
  // controller's live material + gizmo -- mirrors controller.applyFilters()
  // but bypasses the global FILTERS state entirely, since during playback
  // the values are per-frame interpolated and must never be written back
  // into FILTERS/localStorage.
  function applyFilterSnapshotToController(controller, color, clip) {
    const material = controller.getMaterial();
    applyColorAdjustToMaterial(material, color);
    const bounds = controller.getSceneBoundsForFilters();
    applyClipToMaterial(material, clip, bounds.center, bounds.maxDim);
  }

  // Builds Catmull-Rom splines through every keyframe's position/target for
  // smooth camera motion, plus the flat ordered lists used for per-segment
  // filter lerps. Returns null when there are fewer than 2 keyframes (single
  // keyframe just holds; zero keyframes means nothing to play).
  function buildPath() {
    if (keyframes.length < 2) return null;
    const positions = keyframes.map((k) => new THREE.Vector3(k.position[0], k.position[1], k.position[2]));
    const targets = keyframes.map((k) => new THREE.Vector3(k.target[0], k.target[1], k.target[2]));
    const positionCurve = new THREE.CatmullRomCurve3(positions, false, "catmullrom", 0.5);
    const targetCurve = new THREE.CatmullRomCurve3(targets, false, "catmullrom", 0.5);
    return { positionCurve, targetCurve };
  }

  // Non-looping total duration: hold on every keyframe + transition
  // between each consecutive pair (n holds, n-1 transitions).
  function computeTotalDuration(holdS, transitionS) {
    const n = keyframes.length;
    if (n === 0) return 0;
    if (n === 1) return holdS;
    return n * holdS + (n - 1) * transitionS;
  }

  // Evaluates the full sequence at elapsed time `t` (seconds since playback
  // start). Returns { position, target, color, clip, done } -- done=true
  // once a non-looping sequence has finished its last hold.
  function evaluateAt(t, path, holdS, transitionS) {
    const n = keyframes.length;
    if (n === 1) {
      const kf = keyframes[0];
      return {
        position: new THREE.Vector3(...kf.position),
        target: new THREE.Vector3(...kf.target),
        color: kf.color,
        clip: kf.clip,
        done: t >= holdS,
      };
    }
    const segmentTotal = holdS + transitionS;
    const loopDuration = n * segmentTotal; // includes a transition back from the last to the first keyframe
    const openDuration = computeTotalDuration(holdS, transitionS); // n holds + (n-1) transitions, no wrap
    const loop = getLoop();
    let tt = loop ? t % loopDuration : Math.min(t, openDuration);
    const segIndex = Math.min(n - 1, Math.floor(tt / segmentTotal));
    const segLocal = tt - segIndex * segmentTotal;

    const fromIndex = segIndex;
    const toIndex = loop ? (segIndex + 1) % n : Math.min(segIndex + 1, n - 1);
    const from = keyframes[fromIndex];
    const to = keyframes[toIndex];

    let globalU; // 0..1 position along the whole spline (fromIndex .. fromIndex+1)
    let colorClipT;
    if (segLocal <= holdS) {
      // Holding exactly on `from`.
      globalU = fromIndex;
      colorClipT = 0;
    } else {
      const transitionLocal = Math.min(1, (segLocal - holdS) / transitionS);
      globalU = fromIndex + transitionLocal;
      colorClipT = transitionLocal;
    }

    let position, target;
    if (path) {
      const uNorm = globalU / (n - 1); // CatmullRomCurve3.getPoint expects 0..1 across ALL points
      position = path.positionCurve.getPoint(Math.max(0, Math.min(1, uNorm)));
      target = path.targetCurve.getPoint(Math.max(0, Math.min(1, uNorm)));
    } else {
      position = new THREE.Vector3(...from.position);
      target = new THREE.Vector3(...from.target);
    }

    const color = lerpColor(from.color, to.color, colorClipT);
    const clip = lerpClip(from.clip, to.clip, colorClipT);

    const done = !loop && t >= openDuration - 0.001;
    return { position, target, color, clip, done };
  }

  function stepFrame(controller, path, t) {
    const holdS = getHoldSeconds();
    const transitionS = getTransitionSeconds();
    const frame = evaluateAt(t, path, holdS, transitionS);
    controller.setLiveCamera(frame.position, frame.target);
    applyFilterSnapshotToController(controller, frame.color, frame.clip);
    return frame;
  }

  function play() {
    if (playing || keyframes.length === 0) return;
    const controller = controllers[activeKey];
    if (!controller) return;
    const path = buildPath();
    controller.suspendAutomation();
    playing = true;
    playStartTime = performance.now();
    onStateChange();

    function tick() {
      if (!playing) return;
      const controllerNow = controllers[activeKey];
      if (!controllerNow) {
        stop();
        return;
      }
      const t = (performance.now() - playStartTime) / 1000;
      const frame = stepFrame(controllerNow, path, t);
      controllerNow.forceRender();
      if (frame.done) {
        stop();
        return;
      }
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    if (!playing) return;
    playing = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    const controller = controllers[activeKey];
    if (controller) controller.resumeAutomation();
    onStateChange();
  }

  // Plays the sequence exactly once (ignores the Loop checkbox) and records
  // it to a video file. CRITICAL: this reuses the EXACT SAME rAF-driven
  // tick loop as play() above (same stepFrame + forceRender() call, same
  // real-wall-clock-based timing) rather than a separate hand-rolled
  // frame-stepping loop -- three earlier attempts at a bespoke manual
  // stepping loop (fixed-step with setTimeout pacing, then with explicit
  // double-rAF paint waits) each introduced a NEW bug (wrong duration,
  // frozen-on-frame-1, or now a pathologically stalled/smeared recording
  // that took 40x longer than the preview and barely animated) because
  // they were duplicating logic instead of reusing the one code path
  // already proven correct by the live preview. captureStream(fps)
  // samples the canvas continuously and automatically while that proven
  // loop runs -- this function's only job is to start the recorder, let
  // the proven tick loop run to completion, then stop it.
  async function recordVideo({ fps, width, height, onProgress }) {
    if (recording || playing || keyframes.length === 0) return null;
    const controller = controllers[activeKey];
    if (!controller) return null;
    const canvas = controller.getCanvas();
    if (!canvas) return null;

    const path = buildPath();
    const holdS = getHoldSeconds();
    const transitionS = getTransitionSeconds();
    const totalDuration = computeTotalDuration(holdS, transitionS);

    recording = true;
    controller.suspendAutomation();
    onStateChange();

    let resized = false;
    if (width && height && (width !== canvas.width || height !== canvas.height)) {
      // The library drives canvas size via its own ResizeObserver on
      // rootElement, so we resize the ROOT ELEMENT (CSS size) rather than
      // the canvas directly -- the ResizeObserver callback then resizes
      // the actual drawing buffer (and camera aspect) to match.
      const layerEl = canvas.closest(".splat-layer");
      if (layerEl) {
        layerEl.dataset.kfOrigWidth = layerEl.style.width || "";
        layerEl.dataset.kfOrigHeight = layerEl.style.height || "";
        layerEl.style.width = `${width}px`;
        layerEl.style.height = `${height}px`;
        resized = true;
        // Give the ResizeObserver a tick to fire and actually resize the
        // WebGL drawing buffer before we start capturing frames.
        await new Promise((r) => setTimeout(r, 120));
      }
    }

    const stream = canvas.captureStream(fps); // continuous automatic sampling while the proven tick loop below runs
    const mimeCandidates = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ];
    const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12_000_000 });
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    const recordedBlobPromise = new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    });
    recorder.start(200); // periodic dataavailable chunks, not just one at stop()

    // The exact same tick() logic as play(), just awaited to completion
    // here instead of running fire-and-forget -- real requestAnimationFrame
    // timing, real wall-clock-based `t`, same stepFrame()/forceRender()
    // call. This is what makes the preview animate correctly, so reusing
    // it verbatim is what makes the recording animate correctly too.
    await new Promise((resolve) => {
      const playStart = performance.now();
      function tick() {
        const controllerNow = controllers[activeKey];
        if (!controllerNow) {
          resolve();
          return;
        }
        const t = (performance.now() - playStart) / 1000;
        const frame = stepFrame(controllerNow, path, t);
        controllerNow.forceRender();
        if (onProgress) onProgress(Math.min(1, t / totalDuration));
        if (frame.done) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });

    await new Promise((r) => setTimeout(r, 300)); // let the last sampled frame(s) flush through
    recorder.stop();
    const blob = await recordedBlobPromise;

    if (resized) {
      const layerEl = canvas.closest(".splat-layer");
      if (layerEl) {
        layerEl.style.width = layerEl.dataset.kfOrigWidth || "";
        layerEl.style.height = layerEl.dataset.kfOrigHeight || "";
        delete layerEl.dataset.kfOrigWidth;
        delete layerEl.dataset.kfOrigHeight;
        await new Promise((r) => setTimeout(r, 120)); // let it resize back
      }
    }

    recording = false;
    controller.resumeAutomation();
    onStateChange();
    return blob;
  }

  function isPlaying() {
    return playing;
  }
  function isRecording() {
    return recording;
  }
  function setOnStateChange(fn) {
    onStateChange = fn;
  }

  return {
    setActiveSplat,
    getKeyframes,
    addKeyframe,
    removeKeyframe,
    applyCurrentFiltersToAllKeyframes,
    applyCurrentFiltersToKeyframe,
    renameKeyframe,
    reorder,
    replaceAllKeyframes,
    jumpTo,
    play,
    stop,
    recordVideo,
    isPlaying,
    isRecording,
    setOnStateChange,
  };
})();

// ---- Keyframes panel UI wiring ------------------------------------------
const keyframesBtnEl = document.getElementById("keyframes-btn");
const keyframesPanelEl = document.getElementById("keyframes-panel");
const kfListEl = document.getElementById("kf-list");
const kfAddBtnEl = document.getElementById("kf-add-btn");
const kfApplyFiltersBtnEl = document.getElementById("kf-apply-filters-btn");
const kfApplyFiltersStatusEl = document.getElementById("kf-apply-filters-status");
const kfPlayBtnEl = document.getElementById("kf-play-btn");
const kfStopBtnEl = document.getElementById("kf-stop-btn");
const kfRecordBtnEl = document.getElementById("kf-record-btn");
const kfRecordStatusEl = document.getElementById("kf-record-status");
const kfShareBtnEl = document.getElementById("kf-share-btn");
const kfShareStatusEl = document.getElementById("kf-share-status");
const kfImportBannerEl = document.getElementById("kf-import-banner");
const kfImportApplyBtnEl = document.getElementById("kf-import-apply-btn");
const kfImportDismissBtnEl = document.getElementById("kf-import-dismiss-btn");

function openKeyframesPanel() {
  if (!keyframesPanelEl) return;
  keyframesPanelEl.classList.add("open");
  keyframesPanelEl.setAttribute("aria-hidden", "false");
  if (keyframesBtnEl) keyframesBtnEl.setAttribute("aria-expanded", "true");
}
function closeKeyframesPanel() {
  if (!keyframesPanelEl) return;
  keyframesPanelEl.classList.remove("open");
  keyframesPanelEl.setAttribute("aria-hidden", "true");
  if (keyframesBtnEl) keyframesBtnEl.setAttribute("aria-expanded", "false");
}
function toggleKeyframesPanel() {
  if (!keyframesPanelEl) return;
  if (keyframesPanelEl.classList.contains("open")) closeKeyframesPanel();
  else openKeyframesPanel();
}
if (keyframesBtnEl) {
  keyframesBtnEl.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleKeyframesPanel();
  });
}
document.addEventListener("click", (e) => {
  if (!keyframesPanelEl || !keyframesPanelEl.classList.contains("open")) return;
  if (keyframesPanelEl.contains(e.target) || (keyframesBtnEl && keyframesBtnEl.contains(e.target))) return;
  closeKeyframesPanel();
});

let kfDragFromIndex = null;

function renderKeyframeList() {
  if (!kfListEl) return;
  const items = KeyframePlayer.getKeyframes();
  kfListEl.replaceChildren(); // clear previous list items (no HTML parsing, safe)
  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "kf-list-empty";
    empty.textContent = "No keyframes yet.";
    kfListEl.appendChild(empty);
  } else {
    items.forEach((kf, index) => {
      const li = document.createElement("li");
      li.className = "kf-item";
      li.draggable = true;
      li.dataset.id = kf.id;

      li.addEventListener("dragstart", () => {
        kfDragFromIndex = index;
        li.classList.add("dragging");
      });
      li.addEventListener("dragend", () => li.classList.remove("dragging"));
      li.addEventListener("dragover", (e) => e.preventDefault());
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        if (kfDragFromIndex === null) return;
        KeyframePlayer.reorder(kfDragFromIndex, index);
        kfDragFromIndex = null;
      });

      const indexSpan = document.createElement("span");
      indexSpan.className = "kf-item-index";
      indexSpan.textContent = String(index + 1);
      li.appendChild(indexSpan);

      const labelInput = document.createElement("input");
      labelInput.className = "kf-item-label";
      labelInput.value = kf.label;
      labelInput.title = "Click to jump the camera here; edit to rename";
      labelInput.addEventListener("focus", () => KeyframePlayer.jumpTo(kf.id));
      labelInput.addEventListener("change", () => KeyframePlayer.renameKeyframe(kf.id, labelInput.value));
      li.appendChild(labelInput);

      // Stamps the CURRENT Adjust-panel color/clip settings onto just
      // THIS keyframe, leaving its camera position and every other
      // keyframe's look untouched -- the per-keyframe counterpart to the
      // "Apply current look to all keyframes" button below the list.
      const applyLookBtn = document.createElement("button");
      applyLookBtn.type = "button";
      applyLookBtn.className = "kf-item-btn kf-item-apply-look-btn";
      applyLookBtn.textContent = "\u{1F3A8}"; // palette emoji -- distinct glyph from remove's "x"
      applyLookBtn.title = "Apply current color/clip settings to this keyframe only";
      applyLookBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        KeyframePlayer.applyCurrentFiltersToKeyframe(kf.id);
        if (kfApplyFiltersStatusEl) {
          kfApplyFiltersStatusEl.textContent = `Applied current look to "${kf.label}".`;
          setTimeout(() => {
            if (kfApplyFiltersStatusEl.textContent.startsWith("Applied current look to \"")) {
              kfApplyFiltersStatusEl.textContent = "";
            }
          }, 4000);
        }
      });
      li.appendChild(applyLookBtn);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "kf-item-btn";
      removeBtn.textContent = "\u2715";
      removeBtn.title = "Remove keyframe";
      removeBtn.addEventListener("click", () => KeyframePlayer.removeKeyframe(kf.id));
      li.appendChild(removeBtn);

      kfListEl.appendChild(li);
    });
  }

  const hasEnough = items.length >= 1;
  const hasTransition = items.length >= 2;
  if (kfPlayBtnEl) kfPlayBtnEl.disabled = !hasEnough || KeyframePlayer.isRecording();
  if (kfRecordBtnEl) kfRecordBtnEl.disabled = !hasTransition || KeyframePlayer.isRecording();
  if (kfStopBtnEl) kfStopBtnEl.disabled = !KeyframePlayer.isPlaying();
  if (kfApplyFiltersBtnEl) {
    kfApplyFiltersBtnEl.disabled = !hasEnough || KeyframePlayer.isPlaying() || KeyframePlayer.isRecording();
  }
  if (kfShareBtnEl) kfShareBtnEl.disabled = !hasEnough;
}

KeyframePlayer.setOnStateChange(() => {
  renderKeyframeList();
  if (kfPlayBtnEl) kfPlayBtnEl.disabled = KeyframePlayer.isPlaying() || KeyframePlayer.isRecording() || KeyframePlayer.getKeyframes().length === 0;
  if (kfStopBtnEl) kfStopBtnEl.disabled = !KeyframePlayer.isPlaying();
  if (kfRecordBtnEl) kfRecordBtnEl.disabled = KeyframePlayer.isPlaying() || KeyframePlayer.isRecording() || KeyframePlayer.getKeyframes().length < 2;
  if (kfApplyFiltersBtnEl) {
    kfApplyFiltersBtnEl.disabled = KeyframePlayer.isPlaying() || KeyframePlayer.isRecording() || KeyframePlayer.getKeyframes().length === 0;
  }
  if (kfShareBtnEl) kfShareBtnEl.disabled = KeyframePlayer.getKeyframes().length === 0;
});

if (kfAddBtnEl) {
  kfAddBtnEl.addEventListener("click", () => KeyframePlayer.addKeyframe());
}
if (kfApplyFiltersBtnEl) {
  // Stamps the CURRENT Adjust-panel color/clip settings onto every
  // existing keyframe's stored snapshot, leaving camera position/target
  // untouched -- lets the same camera move be re-recorded with a
  // different look without rebuilding the whole sequence. Confirms first
  // since this overwrites per-keyframe looks that may have been
  // deliberately varied frame-to-frame.
  kfApplyFiltersBtnEl.addEventListener("click", () => {
    const count = KeyframePlayer.getKeyframes().length;
    if (count === 0) return;
    const proceed = window.confirm(
      `Apply the current color/clip settings to all ${count} keyframe${count === 1 ? "" : "s"}? ` +
      `Camera positions are kept; any per-keyframe color/clip differences will be overwritten.`
    );
    if (!proceed) return;
    KeyframePlayer.applyCurrentFiltersToAllKeyframes();
    if (kfApplyFiltersStatusEl) {
      kfApplyFiltersStatusEl.textContent = `Applied current look to ${count} keyframe${count === 1 ? "" : "s"}.`;
      setTimeout(() => {
        if (kfApplyFiltersStatusEl.textContent.startsWith("Applied current look")) {
          kfApplyFiltersStatusEl.textContent = "";
        }
      }, 4000);
    }
  });
}
if (kfPlayBtnEl) {
  kfPlayBtnEl.addEventListener("click", () => KeyframePlayer.play());
}
if (kfStopBtnEl) {
  kfStopBtnEl.addEventListener("click", () => KeyframePlayer.stop());
}

// ---- Copy share link: encodes the active sequence (camera path +
// color/clip settings + hold/transition/loop timing) into a "~<base64url>"
// suffix appended to the current splat's URL hash, then copies that full
// URL to the clipboard. See encodeSequenceForUrl() near parseHash() above.
if (kfShareBtnEl) {
  kfShareBtnEl.addEventListener("click", async () => {
    const keyframesNow = KeyframePlayer.getKeyframes();
    if (keyframesNow.length === 0) return;
    const holdEl = document.getElementById("kf-hold-s");
    const transitionEl = document.getElementById("kf-transition-s");
    const loopEl = document.getElementById("kf-loop");
    const holdS = holdEl ? parseFloat(holdEl.value) : 2;
    const transitionS = transitionEl ? parseFloat(transitionEl.value) : 3;
    const loop = loopEl ? loopEl.checked : false;

    const encoded = encodeSequenceForUrl(keyframesNow, holdS, transitionS, loop);
    if (!encoded) {
      if (kfShareStatusEl) kfShareStatusEl.textContent = "Nothing to share yet -- add at least one keyframe.";
      return;
    }
    // Build off the splat-only hash (no camera-state suffix) so the link
    // always lands on this splat's default view before the shared
    // sequence's own first keyframe takes over -- a stale "@camera" from
    // the current address bar would just be redundant noise here.
    const shareUrl = `${location.origin}${location.pathname}${location.search}` +
      `${buildHash(currentSplatId || "")}~${encoded}`;

    try {
      await navigator.clipboard.writeText(shareUrl);
      if (kfShareStatusEl) kfShareStatusEl.textContent = "Share link copied to clipboard.";
    } catch (err) {
      // Clipboard API can be unavailable (insecure context, permissions) --
      // fall back to showing the raw URL so it can still be copied by hand
      // rather than silently failing with no feedback at all.
      console.error("Clipboard write failed:", err);
      if (kfShareStatusEl) {
        kfShareStatusEl.textContent = "Couldn't copy automatically -- link:";
        const linkEl = document.createElement("div");
        linkEl.style.wordBreak = "break-all";
        linkEl.style.marginTop = "4px";
        linkEl.textContent = shareUrl;
        kfShareStatusEl.appendChild(linkEl);
      }
    }
    if (kfShareStatusEl) {
      setTimeout(() => {
        if (kfShareStatusEl.textContent.startsWith("Share link copied")) {
          kfShareStatusEl.textContent = "";
        }
      }, 4000);
    }
  });
}

// ---- Shared-sequence import banner --------------------------------------
// Shows whenever a "~sequence" suffix was parsed from the URL hash (see
// pendingSharedSequence, set by the initial-load IIFE and the hashchange
// listener above) and hasn't been dismissed/imported yet. Checked once
// after this section finishes wiring, and again on every hashchange.
function maybeOfferSharedSequenceImport() {
  if (!kfImportBannerEl) return;
  if (!pendingSharedSequence) {
    kfImportBannerEl.classList.remove("open");
    kfImportBannerEl.setAttribute("aria-hidden", "true");
    return;
  }
  kfImportBannerEl.classList.add("open");
  kfImportBannerEl.setAttribute("aria-hidden", "false");
}

if (kfImportApplyBtnEl) {
  kfImportApplyBtnEl.addEventListener("click", () => {
    if (!pendingSharedSequence) return;
    const holdEl = document.getElementById("kf-hold-s");
    const transitionEl = document.getElementById("kf-transition-s");
    const loopEl = document.getElementById("kf-loop");
    if (holdEl) {
      holdEl.value = String(pendingSharedSequence.holdS);
      holdEl.dispatchEvent(new Event("input"));
    }
    if (transitionEl) {
      transitionEl.value = String(pendingSharedSequence.transitionS);
      transitionEl.dispatchEvent(new Event("input"));
    }
    if (loopEl) loopEl.checked = pendingSharedSequence.loop;
    KeyframePlayer.replaceAllKeyframes(pendingSharedSequence.keyframes);
    pendingSharedSequence = null;
    maybeOfferSharedSequenceImport();
    openKeyframesPanel();
  });
}
if (kfImportDismissBtnEl) {
  kfImportDismissBtnEl.addEventListener("click", () => {
    pendingSharedSequence = null;
    maybeOfferSharedSequenceImport();
  });
}

// Catches the initial-page-load case: pendingSharedSequence may already be
// set by the startup IIFE (see near parseHash() usage above) by the time
// this script section runs.
maybeOfferSharedSequenceImport();

bindRange("kf-hold-s", "kf-hold-s-val", 2, (v) => `${v.toFixed(1)}s`, () => {});
bindRange("kf-transition-s", "kf-transition-s-val", 3, (v) => `${v.toFixed(1)}s`, () => {});
bindRange("kf-fps", "kf-fps-val", 30, (v) => String(Math.round(v)), () => {});

if (kfRecordBtnEl) {
  kfRecordBtnEl.addEventListener("click", async () => {
    const fps = parseInt(document.getElementById("kf-fps").value, 10) || 30;
    const resolutionValue = document.getElementById("kf-resolution").value;
    let width = null, height = null;
    if (resolutionValue !== "canvas") {
      const [w, h] = resolutionValue.split("x").map(Number);
      width = w;
      height = h;
    }

    kfRecordBtnEl.disabled = true;
    kfRecordBtnEl.classList.add("recording");
    kfRecordBtnEl.textContent = "Recording\u2026 0%";
    if (kfRecordStatusEl) kfRecordStatusEl.textContent = "Recording in progress -- keep this tab visible and focused.";

    try {
      const blob = await KeyframePlayer.recordVideo({
        fps,
        width,
        height,
        onProgress: (p) => {
          kfRecordBtnEl.textContent = `Recording\u2026 ${Math.round(p * 100)}%`;
        },
      });
      if (blob) {
        const splatId = currentSplatId || "splat";
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        triggerDownload(blob, `${splatId}-flythrough-${stamp}.webm`);
        if (kfRecordStatusEl) kfRecordStatusEl.textContent = "Done -- video downloaded.";
      } else if (kfRecordStatusEl) {
        kfRecordStatusEl.textContent = "Recording failed: no active splat or not enough keyframes.";
      }
    } catch (err) {
      console.error("Keyframe video export failed:", err);
      if (kfRecordStatusEl) kfRecordStatusEl.textContent = `Recording failed: ${err.message || err}`;
    } finally {
      kfRecordBtnEl.classList.remove("recording");
      kfRecordBtnEl.textContent = "Record & download video";
      renderKeyframeList();
    }
  });
}

// Keep the keyframe panel pointed at whichever splat is actually on screen:
// re-point on every successful navigateToSplat() crossfade, and once for
// the initial splat loaded by the startup IIFE above.
const originalNavigateToSplat = navigateToSplat;
navigateToSplat = async function patchedNavigateToSplat(splatId, options = {}) {
  await originalNavigateToSplat(splatId, options);
  if (currentSplatId === splatId) KeyframePlayer.setActiveSplat(splatId);
};

// Poll briefly for the initial splat's id (the startup IIFE is async and
// may not have set currentSplatId yet by the time this script section runs
// synchronously after it).
(function waitForInitialSplat() {
  if (currentSplatId) {
    KeyframePlayer.setActiveSplat(currentSplatId);
    return;
  }
  setTimeout(waitForInitialSplat, 100);
})();


