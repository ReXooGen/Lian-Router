import { useEffect, useRef, type ReactElement } from "react";
import * as THREE from "three";

export interface PrismRouterProps {
  readonly label?: string;
}

/**
 * Interactive 3D Glassmorphic Prism Router.
 * - Sits in `.lr-hero-prism` (full-bleed across the hero section).
 * - Cube is positioned on the right column (desktop) or centered (mobile).
 * - Does NOT auto-rotate: only rotates when the user drags or uses arrow keys.
 * - Light beams enter uncut from the far-left screen corners, converge into
 *   the prism core, and split out past the far-right screen edge.
 */
export function PrismRouter({ label }: PrismRouterProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    // 1. Scene, Camera & Renderer
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 0, 7.5);

    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;

    // 2. Monochrome Glassmorphism Lighting (sesuai palet --lr-ink & --lr-accent)
    const ambientLight = new THREE.AmbientLight(0xf4f7ff, 0.85);
    scene.add(ambientLight);

    const topLight = new THREE.DirectionalLight(0xffffff, 2.6);
    topLight.position.set(4, 6, 5);
    scene.add(topLight);

    const rimLight = new THREE.DirectionalLight(0xc2cad6, 1.4);
    rimLight.position.set(-5, -4, -3);
    scene.add(rimLight);

    // 3. Anchor Group (Mengatur posisi di kolom kanan pada desktop & tengah pada mobile)
    const anchorGroup = new THREE.Group();
    scene.add(anchorGroup);

    // 4. Cube Group (Hanya berputar saat di-drag user, ukuran proporsional/kecil)
    const cubeGroup = new THREE.Group();
    const initialRot = { x: 0.32, y: -0.58 };
    const targetRot = { x: initialRot.x, y: initialRot.y };
    cubeGroup.rotation.set(initialRot.x, initialRot.y, 0);
    anchorGroup.add(cubeGroup);

    // Material & Geometri 3 Lapisan Kubus Kaca (Frosted Dark Glass)
    const layerSizes = [1.48, 1.04, 0.62];
    const disposables: Array<{ dispose: () => void }> = [];

    layerSizes.forEach((size, idx) => {
      const geo = new THREE.BoxGeometry(size, size, size);
      const mat = new THREE.MeshPhysicalMaterial({
        color: idx === 2 ? 0x18181b : 0xf4f7ff,
        transparent: true,
        opacity: idx === 0 ? 0.14 : idx === 1 ? 0.22 : 0.38,
        roughness: idx === 0 ? 0.15 : 0.25,
        metalness: 0.1,
        transmission: idx === 2 ? 0.5 : 0.88,
        ior: 1.45,
        reflectivity: 0.9,
        side: THREE.DoubleSide,
        depthWrite: false,
      });

      const mesh = new THREE.Mesh(geo, mat);

      // Garis tepi (Hairline Specular Border) senada dengan `.lr-card`
      const edgeGeo = new THREE.EdgesGeometry(geo);
      const edgeMat = new THREE.LineBasicMaterial({
        color: idx === 0 ? 0xffffff : 0xc2cad6,
        transparent: true,
        opacity: idx === 0 ? 0.8 : idx === 1 ? 0.45 : 0.28,
      });
      const wireframe = new THREE.LineSegments(edgeGeo, edgeMat);
      mesh.add(wireframe);

      cubeGroup.add(mesh);
      disposables.push(geo, mat, edgeGeo, edgeMat);
    });

    // Inti Cahaya di Dalam Kubus (Core Glow)
    const coreLight = new THREE.PointLight(0xffffff, 3.5, 3.5);
    anchorGroup.add(coreLight);

    const coreGlowGeo = new THREE.SphereGeometry(0.11, 16, 16);
    const coreGlowMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
    });
    anchorGroup.add(new THREE.Mesh(coreGlowGeo, coreGlowMat));
    disposables.push(coreGlowGeo, coreGlowMat);

    // 5. Jalur Cahaya (Beams) Tidak Terpotong — Masuk dari Pojok Layar ke Inti Kubus
    const beamGroup = new THREE.Group();
    anchorGroup.add(beamGroup);

    interface StreamItem {
      mesh: THREE.Mesh;
      curve: THREE.CatmullRomCurve3;
      speed: number;
      offset: number;
    }
    let streams: StreamItem[] = [];

    // Membuat tekstur gradien memanjang untuk berkas cahaya yang mengalir mulus
    const createPulseTexture = () => {
      const c = document.createElement("canvas");
      c.width = 128;
      c.height = 16;
      const ctx = c.getContext("2d")!;
      const grad = ctx.createLinearGradient(0, 0, 128, 0);
      grad.addColorStop(0, "rgba(255, 255, 255, 0)");
      grad.addColorStop(0.5, "rgba(244, 247, 255, 0.45)");
      grad.addColorStop(0.92, "rgba(255, 255, 255, 1)");
      grad.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 128, 16);
      const tex = new THREE.CanvasTexture(c);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      return tex;
    };

    const pulseTexture = createPulseTexture();
    disposables.push(pulseTexture);

    const buildBeams = (leftReach: number, rightReach: number, vSpread: number) => {
      // Bersihkan jalur lama saat resize
      while (beamGroup.children.length > 0) {
        const child = beamGroup.children[0];
        if (child === undefined) break;
        beamGroup.remove(child);
      }
      streams = [];

      // Koordinat jalur: dari luar batas kiri layar (leftReach) menuju inti (0,0,0)
      const inputPaths = [
        [
          new THREE.Vector3(-leftReach, vSpread * 1.15, -1.2),
          new THREE.Vector3(-leftReach * 0.45, vSpread * 0.42, -0.3),
          new THREE.Vector3(-1.1, 0.22, 0),
          new THREE.Vector3(0, 0, 0),
        ],
        [
          new THREE.Vector3(-leftReach, -vSpread * 1.15, -1.0),
          new THREE.Vector3(-leftReach * 0.45, -vSpread * 0.42, -0.2),
          new THREE.Vector3(-1.1, -0.22, 0),
          new THREE.Vector3(0, 0, 0),
        ],
      ];

      // Koordinat jalur: dari inti (0,0,0) terpecah keluar batas kanan layar (rightReach)
      const outputPaths = [
        [
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(1.1, 0.35, 0),
          new THREE.Vector3(rightReach * 0.48, vSpread * 0.65, -0.2),
          new THREE.Vector3(rightReach, vSpread * 1.25, -0.8),
        ],
        [
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(1.1, 0.12, 0.18),
          new THREE.Vector3(rightReach * 0.48, vSpread * 0.22, 0.25),
          new THREE.Vector3(rightReach, vSpread * 0.42, 0),
        ],
        [
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(1.1, -0.12, -0.18),
          new THREE.Vector3(rightReach * 0.48, -vSpread * 0.22, -0.25),
          new THREE.Vector3(rightReach, -vSpread * 0.42, 0),
        ],
        [
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(1.1, -0.35, 0),
          new THREE.Vector3(rightReach * 0.48, -vSpread * 0.65, -0.2),
          new THREE.Vector3(rightReach, -vSpread * 1.25, -0.8),
        ],
      ];

      const allPaths = [...inputPaths, ...outputPaths];

      allPaths.forEach((pts, idx) => {
        const isInput = idx < inputPaths.length;
        const curve = new THREE.CatmullRomCurve3(pts);

        // 1) Rel Kaca Statis (Base Track)
        const baseGeo = new THREE.TubeGeometry(curve, 72, 0.008, 6, false);
        const baseMat = new THREE.MeshBasicMaterial({
          color: 0xc2cad6,
          transparent: true,
          opacity: 0.16,
        });
        beamGroup.add(new THREE.Mesh(baseGeo, baseMat));
        disposables.push(baseGeo, baseMat);

        // 2) Aliran Cahaya Berjalan (Animated Light Stream)
        const streamTex = pulseTexture.clone();
        streamTex.needsUpdate = true;
        streamTex.repeat.set(2, 1);

        const streamGeo = new THREE.TubeGeometry(curve, 72, 0.018, 8, false);
        const streamMat = new THREE.MeshBasicMaterial({
          map: streamTex,
          transparent: true,
          opacity: 0.95,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const streamMesh = new THREE.Mesh(streamGeo, streamMat);
        beamGroup.add(streamMesh);
        disposables.push(streamGeo, streamMat, streamTex);

        streams.push({
          mesh: streamMesh,
          curve,
          speed: isInput ? 0.38 : 0.46,
          offset: idx * 0.22,
        });
      });
    };

    // 6. Penyesuaian Ukuran Layar & Posisi Kolom Kanan (Responsive Layout)
    const updateLayout = () => {
      const width = canvas.clientWidth || window.innerWidth;
      const height = canvas.clientHeight || 520;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();

      // Hitung lebar & tinggi world-space pada Z = 0
      const fovRad = (camera.fov * Math.PI) / 180;
      const visibleHeight = 2 * Math.tan(fovRad / 2) * camera.position.z;
      const visibleWidth = visibleHeight * camera.aspect;

      // Sesuai breakpoint CSS `@media (max-width: 1020px)`
      const isDesktop = window.innerWidth > 1020;
      const offsetX = isDesktop ? visibleWidth * 0.22 : 0;
      anchorGroup.position.set(offsetX, 0, 0);

      // Pastikan jalur cahaya melewati pojok kiri & kanan layar sepenuhnya (tanpa putus)
      const leftReach = visibleWidth * 0.65 + offsetX + 2.5;
      const rightReach = visibleWidth * 0.65 - offsetX + 2.5;
      const vSpread = visibleHeight * 0.36;

      buildBeams(leftReach, rightReach, vSpread);
    };

    updateLayout();
    const resizeObserver = new ResizeObserver(updateLayout);
    resizeObserver.observe(canvas);

    // 7. Interaksi Drag Manual & Keyboard (Tanpa Auto-Rotate)
    let isDragging = false;
    let prevPointer = { x: 0, y: 0 };

    const onPointerDown = (e: PointerEvent) => {
      isDragging = true;
      prevPointer = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - prevPointer.x;
      const dy = e.clientY - prevPointer.y;
      targetRot.y += dx * 0.0085;
      targetRot.x = Math.max(
        -1.2,
        Math.min(1.2, targetRot.x + dy * 0.0085)
      );
      prevPointer = { x: e.clientX, y: e.clientY };
    };

    const onPointerUp = (e: PointerEvent) => {
      isDragging = false;
      if (canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const step = 0.12;
      if (e.key === "ArrowLeft") targetRot.y -= step;
      if (e.key === "ArrowRight") targetRot.y += step;
      if (e.key === "ArrowUp") targetRot.x = Math.max(-1.2, targetRot.x - step);
      if (e.key === "ArrowDown") targetRot.x = Math.min(1.2, targetRot.x + step);
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("keydown", onKeyDown);

    // 8. Render Loop
    let reqId = 0;
    const clock = new THREE.Clock();

    const animate = () => {
      reqId = requestAnimationFrame(animate);
      const elapsed = clock.getElapsedTime();

      // Rotasi kubus murni mengikuti drag user dengan smooth damping
      cubeGroup.rotation.x += (targetRot.x - cubeGroup.rotation.x) * 0.12;
      cubeGroup.rotation.y += (targetRot.y - cubeGroup.rotation.y) * 0.12;

      // Gerakkan aliran cahaya di sepanjang kurva jika tidak prefers-reduced-motion
      if (!prefersReducedMotion) {
        streams.forEach((s) => {
          const mat = s.mesh.material as THREE.MeshBasicMaterial;
          if (mat.map) {
            mat.map.offset.x = -(elapsed * s.speed + s.offset);
          }
        });
      }

      renderer.render(scene, camera);
    };

    animate();

    return () => {
      cancelAnimationFrame(reqId);
      resizeObserver.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("keydown", onKeyDown);
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="lr-hero-prism"
      tabIndex={0}
      role="img"
      aria-label={
        label ??
        "Routing prism. Drag to turn the glass cube; the light paths stay fixed."
      }
    />
  );
}

export default PrismRouter;