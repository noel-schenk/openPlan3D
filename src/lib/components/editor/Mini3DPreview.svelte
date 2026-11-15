<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import * as THREE from 'three';
  import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
  import { t } from '$lib/i18n';
  import { activeFloor, currentProject, layerVisibility, viewMode } from '$lib/stores/project';
  import { projectSettings } from '$lib/stores/settings';
  import type { Floor, Project } from '$lib/models/types';
  import { getWallStartHeight, getWallEndHeight } from '$lib/models/types';
  import { createSlopedBoxGeometry } from '$lib/utils/slopedWallGeometry';
  import { buildWallSegments, wallProfileSpans } from '$lib/utils/wallProfiles';
  import { createRoomSlabGeometry } from '$lib/utils/roomSlabGeometry';
  import { roomHoles } from '$lib/utils/roomNesting';
  import { resolveRoomGeometry } from '$lib/utils/roomDetection';
  import { stairRises, stairSpan } from '$lib/utils/stairLevels';
  import { SPIRAL_START_ANGLE, SPIRAL_SWEEP, stairFlights } from '$lib/utils/stairPlanGeometry';
  import { columnGeometry } from '$lib/utils/columnGeometry';
  import { floorElevations } from '$lib/utils/floors';
  import { stackedFloorMaterial } from '$lib/utils/floorStack';
  import { createPlacedFurnitureModel } from '$lib/utils/furnitureModelLoader';
  import { disposeModel } from '$lib/utils/furnitureModelResources';
  import { ownColorCanvasTexture } from '$lib/utils/viewerTextures';
  import { DEPTH_ORDER, depthOffset } from '$lib/utils/depthOrder';
  import { getMaterial } from '$lib/utils/materials';
  import { getWallTextureCanvas, getFloorTextureCanvas, setTextureLoadCallback } from '$lib/utils/textureGenerator';
  import { frameScene } from '$lib/utils/frameScene';
  import { sceneSignature } from '$lib/utils/sceneSignature';
  import { updateOrbitDamping } from '$lib/utils/orbitDamping';

  interface Props {
    bottomOffset?: string;
    onclose?: () => void;
  }

  let { bottomOffset = '168px', onclose }: Props = $props();

  let canvasEl = $state<HTMLCanvasElement>();
  let webglUnavailable = $state(false);

  const PREVIEW_W = 180;
  const PREVIEW_H = 120;
  const DEFAULT_2D_COLORS = new Set(['#cccccc', '#888888', '#444444', '#404040']);
  const FALLBACK_ROOM_COLORS = [0xe8dfd1, 0xdce6df, 0xdfe4ee, 0xeee5d8];

  onMount(() => {
    if (!canvasEl) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: false });
    } catch {
      webglUnavailable = true;
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(PREVIEW_W, PREVIEW_H, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xdde9f7);

    const camera = new THREE.PerspectiveCamera(45, PREVIEW_W / PREVIEW_H, 5, 20000);
    camera.position.set(600, 500, 600);

    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    const hemi = new THREE.HemisphereLight(0x87ceeb, 0x8b7355, 0.45);
    const sun = new THREE.DirectionalLight(0xfff8e7, 0.95);
    sun.position.set(500, 1200, 800);
    const fill = new THREE.DirectionalLight(0xc8d8f0, 0.35);
    fill.position.set(-600, 700, -400);
    scene.add(ambient, hemi, sun, fill);

    const groundGeo = new THREE.PlaneGeometry(16000, 16000);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0xd6d0c4, roughness: 0.95 });
    Object.assign(groundMat, depthOffset(DEPTH_ORDER.ground));
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1;
    scene.add(ground);

    const modelGroup = new THREE.Group();
    scene.add(modelGroup);

    const controls = new OrbitControls(camera, canvasEl);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.minDistance = 40;
    controls.target.set(0, 100, 0);

    let mounted = true;
    let dirty = true;
    let animId: number | undefined;
    let lastFrameAt = 0;
    let lastBuildKey = '';
    let framedProjectId: string | null = null;
    let hasFramedGeometry = false;

    function requestRender() {
      dirty = true;
      if (mounted && animId === undefined) {
        lastFrameAt = performance.now();
        animId = requestAnimationFrame(renderLoop);
      }
    }

    function renderLoop(now: number) {
      animId = undefined;
      if (!mounted) return;
      const elapsed = (now - lastFrameAt) / 1000;
      lastFrameAt = now;
      const moving = updateOrbitDamping(controls, elapsed);
      if (dirty || moving) {
        dirty = false;
        renderer.render(scene, camera);
      }
      if (dirty || moving) {
        animId = requestAnimationFrame(renderLoop);
      }
    }

    controls.addEventListener('change', requestRender);

    function floorHasGeometry(floor: Floor): boolean {
      return !!(
        floor.walls.length ||
        floor.rooms.length ||
        floor.furniture.length ||
        floor.stairs?.length ||
        floor.columns?.length ||
        floor.floorPlanes?.length
      );
    }

    function buildFloorMeshes(project: Project, floor: Floor, yOffset: number, active: boolean) {
      const vis = get(layerVisibility);
      const look = active ? undefined : stackedFloorMaterial('translucent');
      const group = new THREE.Group();
      group.position.y = yOffset;

      // Walls (using interior/exterior cuts)
      if (vis.walls) {
        const defaultIntMat = new THREE.MeshStandardMaterial({ color: 0xf5f5f4, roughness: 0.9, ...(look ?? {}) });
        const defaultExtMat = new THREE.MeshStandardMaterial({ color: 0xd4cfc9, roughness: 0.85, ...(look ?? {}) });

        for (const sourceWall of floor.walls) {
          const doors = vis.doors ? floor.doors.filter((d) => d.wallId === sourceWall.id) : [];
          const windows = vis.windows ? floor.windows.filter((w) => w.wallId === sourceWall.id) : [];

          if (sourceWall.curvePoint) {
            for (const span of wallProfileSpans(sourceWall, doors, windows)) {
              const angle = Math.atan2(span.end.y - span.start.y, span.end.x - span.start.x);
              const t = Math.max(sourceWall.thickness, 10);
              for (const seg of span.segments) {
                const geo = createSlopedBoxGeometry(seg.width, t, seg.bottomY, seg.topYLeft, seg.topYRight);
                const mesh = new THREE.Mesh(geo, [defaultExtMat, defaultExtMat, defaultIntMat, defaultIntMat, defaultIntMat, defaultExtMat]);
                mesh.position.set(span.start.x + seg.offsetX * Math.cos(angle), 0, span.start.y + seg.offsetX * Math.sin(angle));
                mesh.rotation.y = -angle;
                group.add(mesh);
              }
            }
            continue;
          }

          const dx = sourceWall.end.x - sourceWall.start.x;
          const dy = sourceWall.end.y - sourceWall.start.y;
          const len = Math.hypot(dx, dy);
          if (len < 1) continue;
          const t = Math.max(sourceWall.thickness, 10);
          const angle = Math.atan2(dy, dx);
          const cx = (sourceWall.start.x + sourceWall.end.x) / 2;
          const cy = (sourceWall.start.y + sourceWall.end.y) / 2;
          const startH = getWallStartHeight(sourceWall);
          const endH = getWallEndHeight(sourceWall);

          let wallMat = defaultIntMat;
          if (!look) {
            const wallColor = sourceWall.interiorColor || sourceWall.color;
            const wallTexId = sourceWall.interiorTexture === 'none' ? undefined : (sourceWall.interiorTexture || sourceWall.texture);
            if (wallTexId) {
              const c = getWallTextureCanvas(wallTexId, wallColor || '#888888');
              if (c) {
                const tex = ownColorCanvasTexture(c);
                tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
                wallMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 });
              }
            } else if (wallColor && !DEFAULT_2D_COLORS.has(wallColor.toLowerCase())) {
              wallMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(wallColor), roughness: 0.9 });
            }
          }

          const mats = [defaultExtMat, defaultExtMat, wallMat, wallMat, wallMat, defaultExtMat];
          for (const seg of buildWallSegments(len, startH, endH, doors, windows)) {
            const geo = createSlopedBoxGeometry(seg.width, t, seg.bottomY, seg.topYLeft, seg.topYRight);
            const mesh = new THREE.Mesh(geo, mats);
            const localX = seg.offsetX - len / 2;
            mesh.position.set(cx + localX * Math.cos(angle), 0, cy + localX * Math.sin(angle));
            mesh.rotation.y = -angle;
            group.add(mesh);
          }
        }
      }

      // Rooms
      const rooms = resolveRoomGeometry(floor);
      const holes = roomHoles(rooms.map((r) => r.polygon));
      for (const [ri, { room, polygon }] of rooms.entries()) {
        if (room.floorOpening || polygon.length < 3) continue;
        const slabGeo = createRoomSlabGeometry(polygon, floor.slabThickness, holes[ri]);
        if (slabGeo) {
          group.add(new THREE.Mesh(slabGeo, new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.95, ...(look ?? {}) })));
        }
        if (active || !slabGeo) {
          const shape = new THREE.Shape();
          shape.moveTo(polygon[0].x, -polygon[0].y);
          for (let i = 1; i < polygon.length; i++) shape.lineTo(polygon[i].x, -polygon[i].y);
          shape.closePath();
          for (const hole of holes[ri]) {
            const path = new THREE.Path();
            path.moveTo(hole[0].x, -hole[0].y);
            for (const p of hole.slice(1)) path.lineTo(p.x, -p.y);
            path.closePath();
            shape.holes.push(path);
          }
          const geo = new THREE.ShapeGeometry(shape);
          let mat: THREE.MeshStandardMaterial;
          if (room.floorTexture === 'none') {
            mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(room.color ?? getMaterial('none').color), roughness: 0.9 });
          } else if (room.floorTexture) {
            const fm = getMaterial(room.floorTexture);
            const fc = getFloorTextureCanvas(room.floorTexture);
            if (fc) {
              const tex = ownColorCanvasTexture(fc);
              tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
              tex.repeat.set(0.005, 0.005);
              mat = new THREE.MeshStandardMaterial({ map: tex, roughness: fm.roughness ?? 0.8 });
            } else {
              mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(fm.color), roughness: fm.roughness ?? 0.8 });
            }
          } else {
            mat = new THREE.MeshStandardMaterial({ color: FALLBACK_ROOM_COLORS[ri % FALLBACK_ROOM_COLORS.length], roughness: 0.9 });
          }
          Object.assign(mat, depthOffset(DEPTH_ORDER.roomFloor), look ?? {});
          const mesh = new THREE.Mesh(geo, mat);
          mesh.rotation.x = -Math.PI / 2;
          mesh.position.y = 1;
          group.add(mesh);
        }
      }

      // Horizontal floor planes
      if (vis.floorPlanes && floor.floorPlanes?.length) {
        for (const plane of floor.floorPlanes) {
          const w = plane.width, h = plane.height, t = plane.thickness;
          if (!(w > 0 && h > 0 && t > 0)) continue;
          let mat: THREE.MeshStandardMaterial;
          if (look) {
            mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(plane.color || '#cccccc'), roughness: 0.9, ...look, ...depthOffset(DEPTH_ORDER.slab) });
          } else if (plane.floorTexture && plane.floorTexture !== 'none') {
            const fm = getMaterial(plane.floorTexture);
            const fc = getFloorTextureCanvas(plane.floorTexture);
            if (fc) {
              const tex = ownColorCanvasTexture(fc);
              tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
              tex.repeat.set(w / 200, h / 200);
              mat = new THREE.MeshStandardMaterial({ map: tex, roughness: fm.roughness ?? 0.8, ...depthOffset(DEPTH_ORDER.slab) });
            } else {
              mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(fm.color), roughness: fm.roughness ?? 0.8, ...depthOffset(DEPTH_ORDER.slab) });
            }
          } else {
            mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(plane.color || '#d6d3d1'), roughness: 0.85, ...depthOffset(DEPTH_ORDER.slab) });
          }
          const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, t, h), mat);
          const topOffset = typeof plane.elevation === 'number' && Number.isFinite(plane.elevation) && plane.elevation !== 0 ? plane.elevation : 0.8;
          mesh.position.set(plane.position.x, topOffset - t / 2, plane.position.y);
          mesh.rotation.y = -((plane.rotation || 0) * Math.PI) / 180;
          group.add(mesh);
        }
      }

      // Stairs
      if (vis.stairs && floor.stairs?.length) {
        const rises = stairRises(project.floors, floor.id);
        for (const stair of floor.stairs) {
          const { base, rise: totalHeight } = stairSpan(stair, rises);
          const riserHeight = totalHeight / stair.riserCount;
          const treadMat = new THREE.MeshStandardMaterial({ color: 0xd4a574, roughness: 0.7, ...(look ?? {}) });
          const riserMat = new THREE.MeshStandardMaterial({ color: 0xb8956a, roughness: 0.8, ...(look ?? {}) });
          const stairGroup = new THREE.Group();
          const flights = stairFlights(stair);
          for (const run of flights.runs) {
            const runGroup = new THREE.Group();
            const td = run.length / run.risers;
            for (let i = 0; i < run.risers; i++) {
              const tread = new THREE.Mesh(new THREE.BoxGeometry(run.width, 3, td), treadMat);
              tread.position.set(0, (i + 1) * riserHeight - 1.5, i * td + td / 2);
              runGroup.add(tread);
              const riser = new THREE.Mesh(new THREE.BoxGeometry(run.width - 1, riserHeight - 0.5, 2), riserMat);
              riser.position.set(0, i * riserHeight + (riserHeight - 0.5) / 2, i * td);
              runGroup.add(riser);
            }
            runGroup.position.set(run.start.x, run.firstRiser * riserHeight, run.start.y);
            runGroup.rotation.y = Math.atan2(run.dir.x, run.dir.y);
            stairGroup.add(runGroup);
          }
          for (const landing of flights.landings) {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(landing.width, 3, landing.height), treadMat);
            mesh.position.set(landing.x + landing.width / 2, landing.atRiser * riserHeight - 1.5, landing.y + landing.height / 2);
            stairGroup.add(mesh);
          }
          if ((stair.stairType || 'straight') === 'spiral') {
            const radius = Math.min(stair.width, stair.depth) / 2;
            const postR = radius * 0.1;
            const post = new THREE.Mesh(new THREE.CylinderGeometry(postR, postR, totalHeight, 8), riserMat);
            post.position.set(0, totalHeight / 2, 0);
            stairGroup.add(post);
            for (let i = 0; i < stair.riserCount; i++) {
              const angle = -(SPIRAL_START_ANGLE + (i / stair.riserCount) * SPIRAL_SWEEP);
              const nextAngle = -(SPIRAL_START_ANGLE + ((i + 1) / stair.riserCount) * SPIRAL_SWEEP);
              const shape = new THREE.Shape();
              shape.moveTo(postR * Math.cos(angle), postR * Math.sin(angle));
              shape.lineTo(radius * Math.cos(angle), radius * Math.sin(angle));
              for (let j = 1; j <= 4; j++) {
                const a = angle + (nextAngle - angle) * (j / 4);
                shape.lineTo(radius * Math.cos(a), radius * Math.sin(a));
              }
              shape.lineTo(postR * Math.cos(nextAngle), postR * Math.sin(nextAngle));
              shape.closePath();
              const tread = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 3, bevelEnabled: false }), treadMat);
              tread.rotation.x = -Math.PI / 2;
              tread.position.y = (i + 1) * riserHeight - 3;
              stairGroup.add(tread);
            }
          }
          stairGroup.position.set(stair.position.x, base, stair.position.y);
          stairGroup.rotation.y = -(stair.rotation * Math.PI) / 180;
          group.add(stairGroup);
        }
      }

      // Columns
      if (vis.columns && floor.columns?.length) {
        for (const col of floor.columns) {
          const h = col.height || 280;
          const mat = new THREE.MeshStandardMaterial({ color: col.color || '#cccccc', roughness: 0.7, ...(look ?? {}), ...depthOffset(DEPTH_ORDER.column) });
          const mesh = new THREE.Mesh(columnGeometry(col), mat);
          mesh.position.set(col.position.x, h / 2, col.position.y);
          group.add(mesh);
        }
      }

      // Furniture (active floor only for legibility & performance)
      if (active && vis.furniture && floor.furniture.length) {
        for (const item of floor.furniture) {
          const model = createPlacedFurnitureModel(item, requestRender, project, depthOffset(DEPTH_ORDER.roomFloor));
          if (model) group.add(model);
        }
      }

      modelGroup.add(group);
    }

    function rebuild() {
      const project = get(currentProject);
      const floor = get(activeFloor);
      if (!project || !floor) return;

      const vis = get(layerVisibility);
      const visKey = `${vis.walls}:${vis.doors}:${vis.windows}:${vis.stairs}:${vis.columns}:${vis.floorPlanes}:${vis.furniture}`;
      const sig = `${sceneSignature(project, floor, true, get(projectSettings).units, 'translucent')}|${visKey}`;
      if (sig === lastBuildKey) return;
      lastBuildKey = sig;

      disposeModel(modelGroup);
      modelGroup.clear();

      const entries = floorElevations(project.floors);
      ground.position.y = Math.min(0, ...entries.map((e) => e.elevation)) - 1;

      let anyGeometry = false;
      for (const entry of entries) {
        if (floorHasGeometry(entry.floor)) anyGeometry = true;
        buildFloorMeshes(project, entry.floor, entry.elevation, entry.floor.id === floor.id);
      }

      const projectChanged = framedProjectId !== project.id;
      if (projectChanged || (!hasFramedGeometry && anyGeometry)) {
        framedProjectId = project.id;
        hasFramedGeometry = anyGeometry;
        const box = new THREE.Box3().setFromObject(modelGroup);
        frameScene(camera, box, controls.target);
        controls.update();
      }

      requestRender();
    }

    const unsubFloor = activeFloor.subscribe(() => rebuild());
    const unsubProj = currentProject.subscribe(() => rebuild());
    const unsubLayers = layerVisibility.subscribe(() => rebuild());
    const unsubSettings = projectSettings.subscribe(() => rebuild());
    const stopTextures = setTextureLoadCallback(() => {
      lastBuildKey = '';
      rebuild();
    });

    rebuild();

    return () => {
      mounted = false;
      stopTextures();
      unsubFloor();
      unsubProj();
      unsubLayers();
      unsubSettings();
      if (animId !== undefined) cancelAnimationFrame(animId);
      controls.removeEventListener('change', requestRender);
      controls.dispose();
      disposeModel(scene);
      scene.clear();
      try { renderer.dispose(); }
      finally { renderer.forceContextLoss(); }
    };
  });
</script>

{#if !webglUnavailable}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    data-mini-3d-preview
    style:bottom={bottomOffset}
    class="group absolute right-2 z-[15] w-[180px] h-[120px] rounded-lg shadow-lg border border-gray-300 bg-slate-200 overflow-hidden max-md:hidden"
    onwheel={(e) => e.stopPropagation()}
    onmousedown={(e) => e.stopPropagation()}
    onpointerdown={(e) => e.stopPropagation()}
    oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
    ontouchstart={(e) => e.stopPropagation()}
  >
    <canvas
      bind:this={canvasEl}
      aria-label={$t('canvasHints.mini3d')}
      width="180"
      height="120"
      class="block w-full h-full cursor-grab active:cursor-grabbing"
    ></canvas>

    <div class="absolute top-1 left-1.5 pointer-events-none rounded bg-slate-900/65 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white">
      3D
    </div>

    <div class="absolute top-1 right-1 flex items-center gap-0.5 opacity-80 group-hover:opacity-100 transition-opacity">
      <button
        type="button"
        onclick={() => viewMode.set('3d')}
        title={$t('canvasHints.open3d')}
        aria-label={$t('canvasHints.open3d')}
        class="w-5 h-5 rounded bg-slate-900/65 hover:bg-slate-900/85 text-white flex items-center justify-center text-[11px] leading-none"
      >↗</button>
      {#if onclose}
        <button
          type="button"
          onclick={onclose}
          title={$t('canvasDisplay.preview3dHint')}
          aria-label={$t('canvasDisplay.preview3dHint')}
          class="w-5 h-5 rounded bg-slate-900/65 hover:bg-slate-900/85 text-white flex items-center justify-center text-[11px] leading-none"
        >×</button>
      {/if}
    </div>
  </div>
{/if}
