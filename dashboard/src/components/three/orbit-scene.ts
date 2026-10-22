import {
  AdditiveBlending,
  Color,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  TorusGeometry,
  WebGLRenderer,
  WireframeGeometry,
  LineSegments,
  LineBasicMaterial,
} from "three";

/**
 * A small procedural Three.js object for console surfaces.
 *
 * Procedural by construction (the img2threejs idea): every ring and facet is
 * generated from primitives at runtime, so no mesh file ships with the bundle.
 * Three variants share one geometry recipe so a page can show a family of
 * related objects rather than the same one repeated.
 *
 * Interaction follows the zslabs landing pattern: press and hold to take over
 * the rotation, drag to spin, release to hand it back to the idle drift. The
 * pointer is captured on the canvas so a drag that leaves the element keeps
 * turning the object instead of stranding it mid-gesture.
 */

export type OrbitVariant = "core" | "shell" | "gate";

export interface OrbitHandle {
  /** Scroll progress for the host page, 0 at the top and 1 at the end. */
  setProgress(progress: number): void;
  dispose(): void;
}

interface VariantSpec {
  readonly segments: number;
  readonly rings: readonly { readonly radius: number; readonly tube: number; readonly tilt: number }[];
  readonly spin: number;
}

const VARIANTS: Record<OrbitVariant, VariantSpec> = {
  core: {
    segments: 1,
    rings: [
      { radius: 1.5, tube: 0.014, tilt: 0 },
      { radius: 1.95, tube: 0.01, tilt: 0.85 },
    ],
    spin: 0.22,
  },
  shell: {
    segments: 2,
    rings: [
      { radius: 1.35, tube: 0.012, tilt: 0.35 },
      { radius: 1.8, tube: 0.009, tilt: -0.6 },
      { radius: 2.2, tube: 0.007, tilt: 1.1 },
    ],
    spin: 0.16,
  },
  gate: {
    segments: 0,
    rings: [
      { radius: 1.7, tube: 0.016, tilt: 0 },
      { radius: 2.15, tube: 0.011, tilt: 1.25 },
    ],
    spin: 0.3,
  },
};

export function createOrbitObject(
  canvas: HTMLCanvasElement,
  variant: OrbitVariant,
): OrbitHandle | null {
  const spec = VARIANTS[variant];

  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    return null;
  }

  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new Scene();
  const camera = new PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 0.4, 8.2);
  camera.lookAt(0, 0, 0);

  const group = new Group();

  if (spec.segments > 0) {
    const node = new Mesh(
      new IcosahedronGeometry(0.58, spec.segments),
      new MeshBasicMaterial({
        color: new Color(0xd6dce6),
        wireframe: true,
        transparent: true,
        opacity: 0.85,
      }),
    );
    group.add(node);
  } else {
    // The gate variant is open in the middle: a halo instead of a solid node.
    const halo = new Mesh(
      new IcosahedronGeometry(0.42, 1),
      new MeshBasicMaterial({
        color: new Color(0xaab4c4),
        transparent: true,
        opacity: 0.22,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    group.add(halo);
  }

  for (const ring of spec.rings) {
    const mesh = new Mesh(
      new TorusGeometry(ring.radius, ring.tube, 8, 112),
      new MeshBasicMaterial({
        color: new Color(0xc2cad6),
        transparent: true,
        opacity: 0.5,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    mesh.rotation.x = Math.PI / 2 + ring.tilt;
    group.add(mesh);

    const edges = new LineSegments(
      new WireframeGeometry(new TorusGeometry(ring.radius, ring.tube * 1.7, 6, 64)),
      new LineBasicMaterial({
        color: new Color(0x9aa3b2),
        transparent: true,
        opacity: 0.28,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    edges.rotation.copy(mesh.rotation);
    group.add(edges);
  }

  scene.add(group);

  // Rotation state. `held` takes priority over the idle drift; velocity carries
  // the flick after release so the object keeps its momentum.
  let yaw = 0;
  let pitch = -0.15;
  let velocityY = spec.spin;
  let velocityX = 0;
  let held = false;
  let lastX = 0;
  let lastY = 0;
  let progress = 0;
  let eased = 0;
  let frame = 0;
  let disposed = false;

  const resize = (): void => {
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  };
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  // Only draw while the object is on screen. The console puts several of these
  // on a page and most are scrolled past; an idle WebGL context per object is
  // real GPU work for something nobody can see.
  let visible = true;
  const visibility = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) visible = entry.isIntersecting;
    },
    { rootMargin: "120px" },
  );
  visibility.observe(canvas);

  const onPointerDown = (event: PointerEvent): void => {
    held = true;
    lastX = event.clientX;
    lastY = event.clientY;
    velocityX = 0;
    velocityY = 0;
    // Capture keeps the drag alive when the pointer leaves the canvas. It can
    // be rejected for an id the browser no longer tracks (a released pointer, a
    // synthetic event); the drag still works from the element's own listeners,
    // so a rejection must not abort the gesture.
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Capture is an optimisation, not a requirement.
    }
    canvas.classList.add("is-held");
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!held) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    // Scale by 1/120 so a normal drag is a comfortable turn, not a spin-out.
    yaw += dx / 120;
    pitch = Math.max(-1.2, Math.min(1.2, pitch + dy / 220));
    velocityY = dx / 120;
    velocityX = dy / 220;
  };

  const release = (event: PointerEvent): void => {
    if (!held) return;
    held = false;
    canvas.classList.remove("is-held");
    try {
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    } catch {
      // Symmetric with setPointerCapture above: nothing to release.
    }
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);

  let last = performance.now();
  const render = (): void => {
    if (disposed) return;
    const now = performance.now();
    const delta = Math.min((now - last) / 1000, 0.05);
    last = now;

    // Exponential smoothing: scroll and pointer both land smoothly instead of
    // snapping, which is what keeps the object feeling like it has weight.
    eased += (progress - eased) * (1 - Math.exp(-5 * delta));

    if (held) {
      // Held: the pointer owns the angle; nothing else moves the object.
    } else {
      // Released: the flick decays and the idle drift resumes underneath.
      velocityY += (spec.spin - velocityY) * (1 - Math.exp(-1.5 * delta));
      velocityX += (0 - velocityX) * (1 - Math.exp(-2.4 * delta));
      yaw += velocityY * delta;
      pitch += velocityX * delta;
      pitch += (-0.15 - pitch) * (1 - Math.exp(-1.1 * delta));
    }

    group.rotation.y = yaw;
    group.rotation.x = pitch + eased * 0.35;

    // Scroll opens the rings apart and pulls the camera back, so travelling
    // the page unwraps the object rather than just sliding past it.
    group.scale.setScalar(1 + eased * 0.18);
    camera.position.z = 8.2 - eased * 1.5;
    camera.position.y = 0.4 - eased * 0.6;
    camera.lookAt(0, 0, 0);

    if (visible) {
      renderer.render(scene, camera);
    }
    frame = requestAnimationFrame(render);
  };
  frame = requestAnimationFrame(render);

  return {
    setProgress(next: number): void {
      progress = Math.min(1, Math.max(0, next));
    },
    dispose(): void {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      visibility.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", release);
      canvas.removeEventListener("pointercancel", release);
      canvas.classList.remove("is-held");
      scene.traverse((object) => {
        if (object instanceof Mesh || object instanceof LineSegments) {
          object.geometry.dispose();
          const material = object.material;
          if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
          else material.dispose();
        }
      });
      renderer.dispose();
    },
  };
}

export default createOrbitObject;
