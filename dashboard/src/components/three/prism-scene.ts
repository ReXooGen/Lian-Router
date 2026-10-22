import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Color,
  DirectionalLight,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PerspectiveCamera,
  PMREMGenerator,
  Points,
  PointsMaterial,
  Scene,
  Sprite,
  SpriteMaterial,
  Texture,
  TubeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  CanvasTexture,
  CatmullRomCurve3,
  ShaderMaterial,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

/** Camera distance from the cube center; also the z of every beam anchor. */
const CAMERA_DISTANCE = 7.6;
/** How far right of the viewport center the cube sits on desktop (fraction of width). */
const COMPOSITION_SHIFT = 0.24;
const EDGE_COLOR = 0xf4f7ff;
const INNER_EDGE_COLOR = 0xc2cad6;
const CORE_COLOR = 0x111115;

export interface PrismSceneHandle {
  dispose(): void;
}

interface BeamMaterials {
  readonly pulse: ShaderMaterial;
  readonly glow: ShaderMaterial;
}

/**
 * Custom GLSL shader for continuous, uncut flowing light streams along the tubes.
 * - Base track remains visible from screen edge to screen edge (never clipped).
 * - Multiple bright light packets travel smoothly from left corners -> center -> right edge.
 */
function beamMaterial(
  shared: { uTime: { value: number } },
  speed: number,
  opacity: number,
  dashScale: number,
  phaseOffset: number,
): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: shared.uTime,
      uSpeed: { value: speed },
      uOpacity: { value: opacity },
      uDash: { value: dashScale },
      uPhase: { value: phaseOffset },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = -mv.xyz;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uSpeed;
      uniform float uOpacity;
      uniform float uDash;
      uniform float uPhase;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vView;

      void main() {
        // Traveling wave along the tube (0 -> 1 from start to end)
        float flow = fract(vUv.x * uDash - uTime * uSpeed + uPhase);

        // Smooth comet-like light pulse: sharp bright head + soft trailing tail
        float pulse = smoothstep(0.0, 0.12, flow) * smoothstep(0.58, 0.14, flow);

        // Uncut continuous base rail (0.28) + bright traveling pulse (0.72)
        float body = 0.28 + 0.72 * pulse;

        // Seam-independent cylindrical falloff
        float facing = abs(dot(normalize(vNormal), normalize(vView)));
        float across = pow(facing, 2.1);

        float alpha = body * across * uOpacity;
        gl_FragColor = vec4(vec3(0.96, 0.97, 1.0), alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    toneMapped: false,
  });
}

function curveThrough(points: readonly Vector3[]): CatmullRomCurve3 {
  return new CatmullRomCurve3(points as Vector3[], false, "catmullrom", 0.35);
}

function addBeam(
  group: Group,
  curve: CatmullRomCurve3,
  materials: BeamMaterials,
  radius: number,
): void {
  const core = new Mesh(new TubeGeometry(curve, 112, radius, 10, false), materials.pulse);
  core.frustumCulled = false;
  group.add(core);

  const glow = new Mesh(
    new TubeGeometry(curve, 112, radius * 2.6, 10, false),
    materials.glow,
  );
  glow.frustumCulled = false;
  group.add(glow);
}

/** A bright star flare at the prism's routing core. */
function flareTexture(): Texture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context !== null) {
    const gradient = context.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size / 2,
    );
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.08, "rgba(255,255,255,0.92)");
    gradient.addColorStop(0.26, "rgba(244,247,255,0.28)");
    gradient.addColorStop(0.55, "rgba(194,202,214,0.06)");
    gradient.addColorStop(1, "rgba(194,202,214,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);

    context.globalCompositeOperation = "lighter";
    const ray = (x0: number, y0: number, x1: number, y1: number): void => {
      const linear = context.createLinearGradient(x0, y0, x1, y1);
      linear.addColorStop(0, "rgba(255,255,255,0)");
      linear.addColorStop(0.5, "rgba(255,255,255,0.9)");
      linear.addColorStop(1, "rgba(255,255,255,0)");
      context.strokeStyle = linear;
      context.lineWidth = 1.6;
      context.beginPath();
      context.moveTo(x0, y0);
      context.lineTo(x1, y1);
      context.stroke();
    };
    ray(0, size / 2, size, size / 2);
    ray(size / 2, 0, size / 2, size);
  }
  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function edgeLine(
  box: BoxGeometry,
  linewidth: number,
  colorHex: number,
  opacity: number,
  materials: LineMaterial[],
): LineSegments2 {
  const edges = new EdgesGeometry(box);
  const positions = edges.getAttribute("position");
  const geometry = new LineSegmentsGeometry();
  if (positions !== undefined) {
    geometry.setPositions(positions.array as Float32Array);
  }
  const material = new LineMaterial({
    color: new Color(colorHex),
    linewidth,
    transparent: true,
    opacity,
    depthWrite: false,
    toneMapped: false,
  });
  material.resolution.set(1, 1);
  materials.push(material);
  const line = new LineSegments2(geometry, material);
  line.computeLineDistances();
  line.frustumCulled = false;
  line.renderOrder = 3;
  edges.dispose();
  return line;
}

/**
 * Builds one concentric glass layer with recessed square aperture frames on its faces
 * (matching the concentric architectural look of the reference image).
 */
function glassCubeLayer(
  size: number,
  linewidth: number,
  glassOpacity: number,
  edgeOpacity: number,
  edgeColor: number,
  lineMaterials: LineMaterial[],
): Group {
  const group = new Group();
  const geometry = new BoxGeometry(size, size, size);
  const glass = new Mesh(
    geometry,
    new MeshPhysicalMaterial({
      color: 0xf4f7ff,
      metalness: 0.05,
      roughness: 0.12,
      transmission: 0.92,
      thickness: size * 0.18,
      ior: 1.45,
      attenuationColor: new Color(0xc2cad6),
      attenuationDistance: 4.5,
      transparent: true,
      opacity: glassOpacity,
      clearcoat: 0.8,
      clearcoatRoughness: 0.08,
      envMapIntensity: 0.75,
      side: 0,
      depthWrite: false,
    }),
  );
  glass.renderOrder = 1;
  group.add(glass);
  group.add(edgeLine(geometry, linewidth, edgeColor, edgeOpacity, lineMaterials));
  return group;
}

function coreCube(size: number, lineMaterials: LineMaterial[]): Group {
  const group = new Group();
  const geometry = new BoxGeometry(size, size, size);
  const mesh = new Mesh(
    geometry,
    new MeshPhysicalMaterial({
      color: new Color(CORE_COLOR),
      metalness: 0.25,
      roughness: 0.35,
      clearcoat: 0.5,
      transparent: true,
      opacity: 0.65,
      envMapIntensity: 0.5,
    }),
  );
  mesh.renderOrder = 0;
  group.add(mesh);
  group.add(edgeLine(geometry, 1.4, INNER_EDGE_COLOR, 0.45, lineMaterials));
  return group;
}

/** Dark studio environment with crisp white strip lights for glass reflections. */
function studioEnvironment(): Scene {
  const scene = new Scene();
  scene.background = new Color(0x030305);
  const panel = new MeshBasicMaterial({ color: 0xffffff });
  const geometry = new BoxGeometry(1, 1, 1);
  const strips: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
    [0, 6, 0, 18, 0.18, 18],
    [-6, 1.5, 0, 0.16, 9, 14],
    [6, -1, 0, 0.16, 9, 14],
    [0, -6, 0, 18, 0.14, 18],
    [0, 0, -8, 12, 12, 0.14],
    [-3, 4.5, 3, 0.12, 6, 8],
    [3, -4, -2, 0.12, 6, 8],
    [0, 0, 8, 12, 12, 0.12],
  ];
  for (const [x, y, z, sx, sy, sz] of strips) {
    const strip = new Mesh(geometry, panel);
    strip.position.set(x, y, z);
    strip.scale.set(sx, sy, sz);
    scene.add(strip);
  }
  return scene;
}

export function createPrismScene(
  canvas: HTMLCanvasElement,
  options: { readonly reducedMotion?: boolean } = {},
): PrismSceneHandle | null {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
  } catch {
    return null;
  }

  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;

  const scene = new Scene();
  const camera = new PerspectiveCamera(34, 1, 0.1, 200);
  // Keep camera level on Y=0 so camera-space beams are perfectly horizontal
  camera.position.set(0, 0, CAMERA_DISTANCE);
  camera.lookAt(0, 0, 0);
  scene.add(camera);

  const pmrem = new PMREMGenerator(renderer);
  const environment = studioEnvironment();
  const environmentTarget = pmrem.fromScene(environment, 0.02, 0.1, 100);
  scene.environment = environmentTarget.texture;
  environment.traverse((object) => {
    if (object instanceof Mesh) {
      object.geometry.dispose();
      const material = object.material;
      const materials = Array.isArray(material) ? material : [material];
      for (const entry of materials) entry.dispose();
    }
  });
  pmrem.dispose();

  scene.add(new AmbientLight(0xf4f7ff, 0.45));
  const key = new DirectionalLight(0xffffff, 3.0);
  key.position.set(-4, 6, 5);
  scene.add(key);
  const rim = new DirectionalLight(0xc2cad6, 2.0);
  rim.position.set(5, -4, -4);
  scene.add(rim);

  // Nested concentric glassmorphic cube (scaled down & aligned like the reference image)
  const lineMaterials: LineMaterial[] = [];
  const cubeGroup = new Group();
  const outer = glassCubeLayer(1.62, 2.4, 0.58, 0.92, EDGE_COLOR, lineMaterials);
  const middle = glassCubeLayer(1.22, 1.8, 0.45, 0.68, INNER_EDGE_COLOR, lineMaterials);
  const inner = glassCubeLayer(0.86, 1.4, 0.35, 0.5, INNER_EDGE_COLOR, lineMaterials);
  const core = coreCube(0.52, lineMaterials);

  cubeGroup.add(outer, middle, inner, core);
  // Isometric resting orientation matching the 3D render
  cubeGroup.rotation.set(0.42, -0.68, 0);
  scene.add(cubeGroup);

  // Subtle static ambient dust around the prism (does NOT auto-rotate)
  const dustPositions: number[] = [];
  for (let i = 0; i < 95; i += 1) {
    const radius = 1.4 + Math.random() * 2.2;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    dustPositions.push(
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.sin(phi) * Math.sin(theta) * 0.75,
      radius * Math.cos(phi),
    );
  }
  const dustGeometry = new BufferGeometry();
  dustGeometry.setAttribute("position", new Float32BufferAttribute(dustPositions, 3));
  const dust = new Points(
    dustGeometry,
    new PointsMaterial({
      color: new Color(0xf4f7ff),
      size: 0.02,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    }),
  );
  cubeGroup.add(dust);

  // Beams live in camera space so dragging rotates the cube while beams stay fixed
  const beamGroup = new Group();
  const beams = new Group();
  beamGroup.add(beams);
  camera.add(beamGroup);

  const clock = { value: 0 };
  const sharedTime = { uTime: clock };

  // Create per-lane materials with staggered phases so pulses look organic
  const makeBeamMatPair = (speed: number, phase: number): BeamMaterials => ({
    pulse: beamMaterial(sharedTime, speed, 0.95, 2.2, phase),
    glow: beamMaterial(sharedTime, speed, 0.38, 2.2, phase),
  });

  const inputMatTop = makeBeamMatPair(0.42, 0.0);
  const inputMatBottom = makeBeamMatPair(0.42, 0.45);
  const outputMatLanes: BeamMaterials[] = [
    makeBeamMatPair(0.48, 0.1),
    makeBeamMatPair(0.48, 0.35),
    makeBeamMatPair(0.48, 0.6),
    makeBeamMatPair(0.48, 0.85),
  ];

  const flare = new Sprite(
    new SpriteMaterial({
      map: flareTexture(),
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending,
      toneMapped: false,
    }),
  );
  flare.scale.setScalar(1.65);
  flare.position.set(0, 0, -CAMERA_DISTANCE + 0.02);
  beamGroup.add(flare);

  // User-only OrbitControls (no autoRotate)
  const controls = new OrbitControls(camera, canvas);
  controls.enableZoom = false;
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.rotateSpeed = 0.75;
  controls.autoRotate = false;
  controls.target.set(0, 0, 0);
  controls.update();

  const resize = (): void => {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;

    // On desktop (>1020px), shift cube right of center; on mobile stacked view, center it
    const isDesktop = window.innerWidth > 1020;
    const shift = isDesktop ? COMPOSITION_SHIFT : 0;
    camera.setViewOffset(width, height, -shift * width, 0, width, height);
    camera.updateProjectionMatrix();

    const drawing = renderer.getDrawingBufferSize(new Vector2());
    for (const material of lineMaterials) {
      material.resolution.set(drawing.x, drawing.y);
    }

    const distance = CAMERA_DISTANCE;
    const halfHeight = Math.tan((camera.fov * Math.PI) / 360) * distance;
    const halfWidth = halfHeight * camera.aspect;
    const center = new Vector3(0, 0, -distance);

    // Account for viewOffset shift so beams truly reach beyond the far-left & far-right corners
    const leftEdgeX = -halfWidth * (1 + shift * 2) * 1.25;
    const rightEdgeX = halfWidth * (1 - shift * 2) * 1.45;

    while (beams.children.length > 0) {
      const child = beams.children[0];
      if (child === undefined) break;
      beams.remove(child);
      if (child instanceof Mesh) child.geometry.dispose();
    }

    // Two uncut inputs originating past the top-left and bottom-left viewport corners
    const inputTop = curveThrough([
      new Vector3(leftEdgeX, halfHeight * 1.05, -distance),
      new Vector3(leftEdgeX * 0.52, halfHeight * 0.42, -distance + 0.15),
      new Vector3(-halfWidth * 0.16, halfHeight * 0.1, -distance + 0.25),
      center,
    ]);
    const inputBottom = curveThrough([
      new Vector3(leftEdgeX, -halfHeight * 1.05, -distance),
      new Vector3(leftEdgeX * 0.52, -halfHeight * 0.42, -distance + 0.15),
      new Vector3(-halfWidth * 0.16, -halfHeight * 0.1, -distance + 0.25),
      center,
    ]);
    addBeam(beams, inputTop, inputMatTop, 0.026);
    addBeam(beams, inputBottom, inputMatBottom, 0.026);

    // Four uncut outputs diverging from the prism core past the right viewport edge
    const outputs = [-0.66, -0.22, 0.22, 0.66];
    outputs.forEach((lane, idx) => {
      const curve = curveThrough([
        center,
        new Vector3(halfWidth * 0.18, halfHeight * lane * 0.38, -distance + 0.22),
        new Vector3(rightEdgeX * 0.55, halfHeight * lane * 0.78, -distance + 0.05),
        new Vector3(rightEdgeX, halfHeight * lane * 1.12, -distance),
      ]);
      addBeam(beams, curve, outputMatLanes[idx]!, 0.024);
    });
  };

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  let frame = 0;
  let disposed = false;
  let last = performance.now();
  const render = (): void => {
    frame = requestAnimationFrame(render);
    if (disposed) return;
    const now = performance.now();
    const delta = Math.min((now - last) / 1000, 0.05);
    last = now;
    // Animate only the light pulses along the beams; cube stays stationary until dragged
    if (!options.reducedMotion) clock.value += delta;
    controls.update();
    renderer.render(scene, camera);
  };
  frame = requestAnimationFrame(render);

  return {
    dispose(): void {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      scene.traverse((object) => {
        if (
          object instanceof Mesh ||
          object instanceof Points ||
          object instanceof LineSegments2
        ) {
          object.geometry.dispose();
          const material = object.material;
          const materials = Array.isArray(material) ? material : [material];
          for (const entry of materials) entry.dispose();
        } else if (object instanceof Sprite) {
          object.material.map?.dispose();
          object.material.dispose();
        }
      });
      environmentTarget.texture.dispose();
      renderer.dispose();
    },
  };
}