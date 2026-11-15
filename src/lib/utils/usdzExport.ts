import * as THREE from 'three';
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
import type {
  Column,
  Door,
  Floor,
  FloorPlane,
  Project,
  Stair,
  Wall,
  Window as PlanWindow,
} from '$lib/models/types';
import { floorElevations } from './floors';
import { resolveRoomGeometry } from './roomDetection';
import { roomHoles } from './roomNesting';
import { createRoomSlabGeometry } from './roomSlabGeometry';
import {
  baseboardSegment,
  pathOpening,
  wallPathProfile,
  wallPathSpans,
  wallProfileSpans,
} from './wallProfiles';
import {
  WALL_TEXTURE_TILE_CM,
  createSlopedBoxGeometry,
  mapWallUVs,
} from './slopedWallGeometry';
import { doorFrameBoxes, windowOuterBars } from './openingFrames';
import {
  doorFrameColor,
  isGlazedDoor,
  pocketDoorTravel,
  swingLeaves,
} from './doorStyle';
import { stairRises, stairSpan } from './stairLevels';
import {
  SPIRAL_START_ANGLE,
  SPIRAL_SWEEP,
  stairFlights,
} from './stairPlanGeometry';
import { columnGeometry } from './columnGeometry';
import { createPlacedFurnitureModel } from './furnitureModelLoader';
import { disposeModel, ownTexture } from './furnitureModelResources';
import { ownColorCanvasTexture } from './viewerTextures';
import { getFloorTextureCanvas, getWallTextureCanvas } from './textureGenerator';
import { getMaterial } from './materials';
import type { PlanLayerSwitches } from './exportVisibility';

const CM_TO_METERS = 0.01;
const FLOOR_TEXTURE_TILE_CM = 200;

function safeFileName(name: string | undefined): string {
  const cleaned = (name || 'floorplan').trim().replace(/[\\/:*?"<>|]/g, '_');
  return cleaned || 'floorplan';
}

function flipGeometryWinding(geometry: THREE.BufferGeometry) {
  const index = geometry.getIndex();
  if (index) {
    const arr = index.array as Uint16Array | Uint32Array | number[];
    for (let i = 0; i + 2 < arr.length; i += 3) {
      const tmp = arr[i + 1];
      arr[i + 1] = arr[i + 2];
      arr[i + 2] = tmp;
    }
    index.needsUpdate = true;
    return;
  }
  const pos = geometry.getAttribute('position');
  if (!pos) return;
  for (const attr of Object.values(geometry.attributes)) {
    const itemSize = attr.itemSize;
    for (let i = 0; i + 2 < attr.count; i += 3) {
      for (let c = 0; c < itemSize; c++) {
        const aIdx = (i + 1) * itemSize + c;
        const bIdx = (i + 2) * itemSize + c;
        const tmp = attr.array[aIdx];
        (attr.array as Float32Array)[aIdx] = attr.array[bIdx];
        (attr.array as Float32Array)[bIdx] = tmp;
      }
    }
    attr.needsUpdate = true;
  }
}

function ensureNormals(geometry: THREE.BufferGeometry) {
  if (!geometry.getAttribute('normal')) {
    geometry.computeVertexNormals();
  }
}

/**
 * USDZExporter only exports single `MeshStandardMaterial` instances cleanly and
 * skips material arrays or warns on non-standard / double-sided materials.
 */
function toUSDZStandardMaterial(material: THREE.Material | undefined): THREE.MeshStandardMaterial {
  if (material instanceof THREE.MeshStandardMaterial) {
    const cloned = material.clone();
    cloned.side = THREE.FrontSide;
    if (cloned.map) {
      cloned.map = ownTexture(cloned.map.clone());
      cloned.map.needsUpdate = true;
    }
    return cloned;
  }
  const source = material as Partial<THREE.MeshPhysicalMaterial & THREE.MeshBasicMaterial & THREE.MeshLambertMaterial> | undefined;
  return new THREE.MeshStandardMaterial({
    color: source?.color ? source.color.clone() : new THREE.Color(0xcccccc),
    map: source?.map ? ownTexture(source.map.clone()) : null,
    opacity: source?.opacity ?? 1,
    transparent: source?.transparent ?? false,
    roughness: typeof source?.roughness === 'number' ? source.roughness : 0.7,
    metalness: typeof source?.metalness === 'number' ? source.metalness : 0.05,
    side: THREE.FrontSide,
  });
}

function buildSubGeometryForIndices(source: THREE.BufferGeometry, indices: number[]): THREE.BufferGeometry {
  const pos = source.getAttribute('position');
  const norm = source.getAttribute('normal');
  const uv = source.getAttribute('uv');
  const remap = new Map<number, number>();
  const newPos: number[] = [];
  const newNorm: number[] = [];
  const newUv: number[] = [];
  const newIndex: number[] = [];

  for (const oldIdx of indices) {
    let nextIdx = remap.get(oldIdx);
    if (nextIdx === undefined) {
      nextIdx = remap.size;
      remap.set(oldIdx, nextIdx);
      newPos.push(pos.getX(oldIdx), pos.getY(oldIdx), pos.getZ(oldIdx));
      if (norm) newNorm.push(norm.getX(oldIdx), norm.getY(oldIdx), norm.getZ(oldIdx));
      if (uv) newUv.push(uv.getX(oldIdx), uv.getY(oldIdx));
    }
    newIndex.push(nextIdx);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(newPos, 3));
  if (norm) geo.setAttribute('normal', new THREE.Float32BufferAttribute(newNorm, 3));
  if (uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(newUv, 2));
  geo.setIndex(newIndex);
  if (!norm) geo.computeVertexNormals();
  return geo;
}

function splitMultiMaterialMesh(mesh: THREE.Mesh, materials: THREE.Material[]): THREE.Mesh[] {
  const geo = mesh.geometry;
  const groups = geo.groups.length > 0
    ? geo.groups
    : [{ start: 0, count: geo.index ? geo.index.count : geo.getAttribute('position').count, materialIndex: 0 }];

  const byMaterial = new Map<number, number[]>();
  for (const group of groups) {
    const matIdx = group.materialIndex ?? 0;
    let list = byMaterial.get(matIdx);
    if (!list) {
      list = [];
      byMaterial.set(matIdx, list);
    }
    if (geo.index) {
      for (let i = group.start; i < group.start + group.count; i++) {
        list.push(geo.index.getX(i));
      }
    } else {
      for (let i = group.start; i < group.start + group.count; i++) {
        list.push(i);
      }
    }
  }

  const result: THREE.Mesh[] = [];
  for (const [matIdx, indices] of byMaterial.entries()) {
    if (indices.length < 3) continue;
    const subGeo = buildSubGeometryForIndices(geo, indices);
    const subMat = toUSDZStandardMaterial(materials[matIdx] ?? materials[0]);
    const subMesh = new THREE.Mesh(subGeo, subMat);
    subMesh.name = mesh.name;
    result.push(subMesh);
  }
  return result;
}

function makeTiledTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = ownColorCanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, 1);
  texture.needsUpdate = true;
  return texture;
}

function createWallFaceMaterial(colorHex: string, textureId?: string): THREE.MeshStandardMaterial {
  if (textureId) {
    const canvas = getWallTextureCanvas(textureId, colorHex);
    if (canvas) {
      return new THREE.MeshStandardMaterial({
        map: makeTiledTexture(canvas),
        color: 0xffffff,
        roughness: 0.85,
        metalness: 0.02,
      });
    }
  }
  return new THREE.MeshStandardMaterial({
    color: colorHex || '#f5f2ec',
    roughness: 0.85,
    metalness: 0.02,
  });
}

function addWallMeshes(
  group: THREE.Group,
  wall: Wall,
  doors: Door[],
  windows: PlanWindow[],
) {
  const extColor = wall.exteriorColor || wall.color || '#f5f2ec';
  const extTex = wall.exteriorTexture ?? wall.texture;
  const intColor = wall.interiorColor || wall.color || '#f5f2ec';
  const intTex = wall.interiorTexture ?? wall.texture;

  const extMat = createWallFaceMaterial(extColor, extTex);
  const intMat = createWallFaceMaterial(intColor, intTex);
  const baseMat = new THREE.MeshStandardMaterial({ color: '#e5e2dc', roughness: 0.65 });

  const path = wallPathProfile(wall);
  const spans = wallProfileSpans(wall, doors, windows);

  for (const span of spans) {
    const dx = span.end.x - span.start.x;
    const dy = span.end.y - span.start.y;
    const angle = Math.atan2(dy, dx);
    const spanGroup = new THREE.Group();
    spanGroup.position.set((span.start.x + span.end.x) / 2, 0, (span.start.y + span.end.y) / 2);
    spanGroup.rotation.y = -angle;

    for (const seg of span.segments) {
      const geo = createSlopedBoxGeometry(
        seg.width,
        wall.thickness,
        seg.bottomY,
        seg.topYLeft,
        seg.topYRight,
      );
      mapWallUVs(geo, span.from + seg.offsetX - seg.width / 2, WALL_TEXTURE_TILE_CM);
      const mesh = new THREE.Mesh(geo, [extMat, extMat, intMat, intMat, intMat, extMat]);
      mesh.position.x = seg.offsetX - span.length / 2;
      mesh.name = `wall_${wall.id}`;
      spanGroup.add(mesh);

      if (seg.bottomY === 0) {
        const bb = baseboardSegment(seg, span, path.length);
        if (bb.width > 0) {
          const bbGeo = new THREE.BoxGeometry(bb.width, 8, wall.thickness + 2);
          const bbMesh = new THREE.Mesh(bbGeo, baseMat);
          bbMesh.position.set(bb.offsetX - span.length / 2, 4, 0);
          bbMesh.name = `baseboard_${wall.id}`;
          spanGroup.add(bbMesh);
        }
      }
    }
    group.add(spanGroup);
  }
}

function addDoorMeshes(group: THREE.Group, door: Door, wall: Wall) {
  const path = wallPathProfile(wall);
  const centerDist = path.distanceAt(door.position);
  const opening = pathOpening(path, centerDist, door.width, 0, door.height ?? 210);
  if (!opening) return;

  const frameColor = doorFrameColor(door);
  const frameMat = new THREE.MeshStandardMaterial({ color: frameColor, roughness: 0.45, metalness: 0.1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: '#c89b6e', roughness: 0.5, metalness: 0.05 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x88ccee,
    transparent: true,
    opacity: 0.35,
    roughness: 0.1,
    metalness: 0.15,
  });

  for (const box of doorFrameBoxes(path, opening, wall.thickness)) {
    const sample = path.sample(box.center);
    const tangentSample = path.sample(Math.min(path.length, box.center + 1));
    const prevSample = path.sample(Math.max(0, box.center - 1));
    const yaw = Math.atan2(
      tangentSample.point.y - prevSample.point.y,
      tangentSample.point.x - prevSample.point.x,
    );
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(box.width, box.height, box.depth), frameMat);
    mesh.position.set(sample.point.x, box.bottom + box.height / 2, sample.point.y);
    mesh.rotation.y = -yaw;
    mesh.name = `door_frame_${door.id}`;
    group.add(mesh);
  }

  if (door.type === 'opening') return;

  const leftPt = path.sample(opening.left).point;
  const rightPt = path.sample(opening.right).point;
  const openW = Math.hypot(rightPt.x - leftPt.x, rightPt.y - leftPt.y);
  const openH = opening.top - opening.bottom;
  if (openW <= 1 || openH <= 1) return;
  const openAngle = Math.atan2(rightPt.y - leftPt.y, rightPt.x - leftPt.x);

  if (door.type === 'garage') {
    const garageMat = new THREE.MeshStandardMaterial({ color: '#d8dadf', roughness: 0.5, metalness: 0.2 });
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(openW, openH, 5), garageMat);
    leaf.position.set((leftPt.x + rightPt.x) / 2, opening.bottom + openH / 2, (leftPt.y + rightPt.y) / 2);
    leaf.rotation.y = -openAngle;
    leaf.name = `door_garage_${door.id}`;
    group.add(leaf);
    return;
  }

  if (door.type === 'pocket') {
    const spans = wallPathSpans(wall);
    const dirSign = door.swingDirection === 'left' ? -1 : 1;
    const edgePt = dirSign < 0 ? leftPt : rightPt;
    const dir = {
      x: dirSign * Math.cos(openAngle),
      y: dirSign * Math.sin(openAngle),
    };
    const available = dirSign < 0 ? opening.left : path.length - opening.right;
    const travel = pocketDoorTravel(openW, available, edgePt, dir, spans, Math.max(1, wall.thickness / 2 - 2));
    const offset = dirSign * travel;
    const midX = (leftPt.x + rightPt.x) / 2 + offset * Math.cos(openAngle);
    const midZ = (leftPt.y + rightPt.y) / 2 + offset * Math.sin(openAngle);
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(openW, openH, 3.5), leafMat);
    leaf.position.set(midX, opening.bottom + openH / 2, midZ);
    leaf.rotation.y = -openAngle;
    leaf.name = `door_pocket_${door.id}`;
    group.add(leaf);
    return;
  }

  if (isGlazedDoor(door.type)) {
    const panels = door.type === 'bifold' ? 2 : 2;
    const pw = openW / panels;
    for (let i = 0; i < panels; i++) {
      const cx = leftPt.x + ((i + 0.5) / panels) * (rightPt.x - leftPt.x);
      const cz = leftPt.y + ((i + 0.5) / panels) * (rightPt.y - leftPt.y);
      const pane = new THREE.Mesh(new THREE.BoxGeometry(Math.max(1, pw - 8), Math.max(1, openH - 8), 1.5), glassMat);
      pane.position.set(cx, opening.bottom + openH / 2, cz);
      pane.rotation.y = -openAngle;
      pane.name = `door_glass_${door.id}`;
      group.add(pane);
    }
    return;
  }

  for (const leaf of swingLeaves(leftPt, rightPt, door)) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(leaf.width, openH, 4), leafMat);
    mesh.position.set(leaf.pose.x, opening.bottom + openH / 2, leaf.pose.z);
    mesh.rotation.y = -leaf.pose.yaw;
    mesh.name = `door_leaf_${door.id}`;
    group.add(mesh);
  }
}

function addWindowMeshes(group: THREE.Group, win: PlanWindow, wall: Wall) {
  const path = wallPathProfile(wall);
  const centerDist = path.distanceAt(win.position);
  const opening = pathOpening(path, centerDist, win.width, win.sillHeight ?? 90, win.height);
  if (!opening) return;

  const frameMat = new THREE.MeshStandardMaterial({ color: '#f4f4f6', roughness: 0.4, metalness: 0.1 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x88ccee,
    transparent: true,
    opacity: 0.32,
    roughness: 0.08,
    metalness: 0.15,
  });

  const barDepth = Math.min(wall.thickness, 8);
  for (const bar of windowOuterBars(path, opening, 4)) {
    const sample = path.sample(bar.center);
    const nextSample = path.sample(Math.min(path.length, bar.center + 1));
    const prevSample = path.sample(Math.max(0, bar.center - 1));
    const yaw = Math.atan2(nextSample.point.y - prevSample.point.y, nextSample.point.x - prevSample.point.x);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(bar.width, bar.height, barDepth), frameMat);
    mesh.position.set(sample.point.x, bar.bottom + bar.height / 2, sample.point.y);
    mesh.rotation.y = -yaw;
    mesh.name = `window_frame_${win.id}`;
    group.add(mesh);
  }

  const leftPt = path.sample(opening.left).point;
  const rightPt = path.sample(opening.right).point;
  const openW = Math.hypot(rightPt.x - leftPt.x, rightPt.y - leftPt.y);
  const openH = opening.top - opening.bottom;
  if (openW <= 1 || openH <= 1) return;
  const yaw = Math.atan2(rightPt.y - leftPt.y, rightPt.x - leftPt.x);
  const cx = (leftPt.x + rightPt.x) / 2;
  const cz = (leftPt.y + rightPt.y) / 2;

  const glass = new THREE.Mesh(new THREE.BoxGeometry(openW, openH, 1.5), glassMat);
  glass.position.set(cx, opening.bottom + openH / 2, cz);
  glass.rotation.y = -yaw;
  glass.name = `window_glass_${win.id}`;
  group.add(glass);

  const sill = new THREE.Mesh(new THREE.BoxGeometry(openW + 6, 3, wall.thickness + 4), frameMat);
  sill.position.set(cx, opening.bottom - 1.5, cz);
  sill.rotation.y = -yaw;
  sill.name = `window_sill_${win.id}`;
  group.add(sill);
}

function addRoomMeshes(group: THREE.Group, floor: Floor) {
  const resolved = resolveRoomGeometry(floor);
  const polygons = resolved.map(r => r.polygon);
  const holes = roomHoles(polygons);
  const slabThickness = typeof floor.slabThickness === 'number' && Number.isFinite(floor.slabThickness) && floor.slabThickness > 0
    ? floor.slabThickness
    : 5;
  const slabMat = new THREE.MeshStandardMaterial({ color: '#c8c4bc', roughness: 0.9, metalness: 0.02 });

  for (let i = 0; i < resolved.length; i++) {
    const { room, polygon } = resolved[i];
    if (room.floorOpening || polygon.length < 3) continue;
    const roomHolesList = holes[i] ?? [];

    const slabGeo = createRoomSlabGeometry(polygon, slabThickness, roomHolesList);
    if (slabGeo) {
      ensureNormals(slabGeo);
      const slabMesh = new THREE.Mesh(slabGeo, slabMat);
      slabMesh.name = `room_slab_${room.id}`;
      group.add(slabMesh);
    }

    const shape = new THREE.Shape();
    shape.moveTo(polygon[0].x, polygon[0].y);
    for (const p of polygon.slice(1)) shape.lineTo(p.x, p.y);
    shape.closePath();
    for (const hole of roomHolesList) {
      if (hole.length < 3) continue;
      const holePath = new THREE.Path();
      holePath.moveTo(hole[0].x, hole[0].y);
      for (const p of hole.slice(1)) holePath.lineTo(p.x, p.y);
      holePath.closePath();
      shape.holes.push(holePath);
    }

    const floorGeo = new THREE.ShapeGeometry(shape);
    floorGeo.rotateX(Math.PI / 2);
    // ShapeGeometry faces -Y after +PI/2 X rotation; reverse winding so FrontSide faces +Y.
    flipGeometryWinding(floorGeo);
    const pos = floorGeo.getAttribute('position');
    const uvAttr = floorGeo.getAttribute('uv');
    if (pos && uvAttr) {
      for (let vi = 0; vi < pos.count; vi++) {
        uvAttr.setXY(vi, pos.getX(vi) / FLOOR_TEXTURE_TILE_CM, pos.getZ(vi) / FLOOR_TEXTURE_TILE_CM);
      }
      uvAttr.needsUpdate = true;
    }
    floorGeo.computeVertexNormals();

    const matDef = getMaterial(room.floorTexture || 'none');
    const texCanvas = room.floorTexture && room.floorTexture !== 'none'
      ? getFloorTextureCanvas(room.floorTexture)
      : null;
    const floorMat = new THREE.MeshStandardMaterial({
      map: texCanvas ? makeTiledTexture(texCanvas) : null,
      color: texCanvas ? 0xffffff : (room.color || matDef.color),
      roughness: matDef.roughness ?? 0.8,
      metalness: 0.02,
      side: THREE.FrontSide,
    });

    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.position.y = 0.2;
    floorMesh.name = `room_floor_${room.id}`;
    group.add(floorMesh);
  }
}

function addFloorPlaneMesh(group: THREE.Group, plane: FloorPlane) {
  const width = plane.width || 400;
  const depth = plane.height || 400;
  const thickness = plane.thickness || 20;
  const elevation = plane.elevation ?? 0;

  const matDef = getMaterial(plane.floorTexture || 'none');
  const texCanvas = plane.floorTexture && plane.floorTexture !== 'none'
    ? getFloorTextureCanvas(plane.floorTexture)
    : null;
  const material = new THREE.MeshStandardMaterial({
    map: texCanvas ? makeTiledTexture(texCanvas) : null,
    color: texCanvas ? 0xffffff : (plane.color || matDef.color),
    roughness: matDef.roughness ?? 0.85,
    metalness: 0.02,
  });

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, thickness, depth), material);
  mesh.position.set(plane.position.x, elevation - thickness / 2, plane.position.y);
  mesh.rotation.y = -(plane.rotation || 0) * Math.PI / 180;
  mesh.name = `floor_plane_${plane.id}`;
  group.add(mesh);
}

function addStairMeshes(group: THREE.Group, stair: Stair, project: Project, floorId: string) {
  const rises = stairRises(project.floors, floorId);
  const { base, rise } = stairSpan(stair, rises);
  const container = new THREE.Group();
  container.position.set(stair.position.x, base, stair.position.y);
  container.rotation.y = -stair.rotation * Math.PI / 180;
  container.name = `stair_${stair.id}`;

  const treadMat = new THREE.MeshStandardMaterial({ color: '#c4a47c', roughness: 0.65, metalness: 0.04 });
  const n = Math.max(1, stair.riserCount || 12);
  const stepH = rise / n;

  if (stair.stairType === 'spiral') {
    const r = Math.max(20, Math.min(stair.width, stair.depth) / 2);
    const poleMat = new THREE.MeshStandardMaterial({ color: '#6b7280', roughness: 0.4, metalness: 0.6 });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, rise, 16), poleMat);
    pole.position.y = rise / 2;
    container.add(pole);

    const stepThickness = Math.max(4, Math.min(8, stepH * 0.5));
    for (let i = 0; i < n; i++) {
      const a0 = SPIRAL_START_ANGLE + (i / n) * SPIRAL_SWEEP;
      const a1 = SPIRAL_START_ANGLE + ((i + 1) / n) * SPIRAL_SWEEP;
      const shape = new THREE.Shape();
      shape.moveTo(6 * Math.cos(a0), 6 * Math.sin(a0));
      shape.lineTo(r * Math.cos(a0), r * Math.sin(a0));
      shape.absarc(0, 0, r, a0, a1, false);
      shape.lineTo(6 * Math.cos(a1), 6 * Math.sin(a1));
      shape.absarc(0, 0, 6, a1, a0, true);
      const treadGeo = new THREE.ExtrudeGeometry(shape, { depth: stepThickness, bevelEnabled: false, curveSegments: 6 });
      treadGeo.rotateX(Math.PI / 2);
      ensureNormals(treadGeo);
      const tread = new THREE.Mesh(treadGeo, treadMat);
      tread.position.y = (i + 1) * stepH;
      container.add(tread);
    }
    group.add(container);
    return;
  }

  const { runs, landings } = stairFlights(stair);
  for (const run of runs) {
    const stepD = run.length / Math.max(1, run.risers);
    const yaw = Math.atan2(-run.dir.x, -run.dir.y);
    for (let s = 0; s < run.risers; s++) {
      const stepIdx = run.firstRiser + s;
      const totalH = (stepIdx + 1) * stepH;
      const box = new THREE.Mesh(new THREE.BoxGeometry(run.width, stepH, stepD), treadMat);
      box.position.set(
        run.start.x + run.dir.x * (s + 0.5) * stepD,
        totalH - stepH / 2,
        run.start.y + run.dir.y * (s + 0.5) * stepD,
      );
      box.rotation.y = yaw;
      container.add(box);
    }
  }

  const landingThickness = Math.max(8, stepH);
  for (const landing of landings) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(landing.width, landingThickness, landing.height), treadMat);
    box.position.set(
      landing.x + landing.width / 2,
      landing.atRiser * stepH - landingThickness / 2,
      landing.y + landing.height / 2,
    );
    container.add(box);
  }

  group.add(container);
}

function addColumnMesh(group: THREE.Group, col: Column) {
  const h = col.height || 280;
  const mat = new THREE.MeshStandardMaterial({ color: col.color || '#e5e7eb', roughness: 0.65, metalness: 0.05 });
  const mesh = new THREE.Mesh(columnGeometry(col), mat);
  mesh.position.set(col.position.x, h / 2, col.position.y);
  mesh.rotation.y = -(col.rotation || 0) * Math.PI / 180;
  mesh.name = `column_${col.id}`;
  group.add(mesh);
}

function hasNegativeScaleInChain(object: THREE.Object3D, stopAt: THREE.Object3D): boolean {
  let cur: THREE.Object3D | null = object;
  while (cur && cur !== stopAt) {
    if (cur.scale.x < 0 || cur.scale.y < 0 || cur.scale.z < 0) return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * Flatten/normalize the scene into single-material `MeshStandardMaterial` meshes
 * with outward CCW normals and no negative-determinant transforms so `USDZExporter`
 * produces clean USD Preview Surface nodes without skipped meshes or warnings.
 */
function prepareContentForUSDZ(contentRoot: THREE.Group): number {
  contentRoot.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  contentRoot.traverse(child => {
    if (child instanceof THREE.Mesh && child.visible && child.geometry) {
      meshes.push(child);
    }
  });

  const normalizedGroup = new THREE.Group();
  normalizedGroup.name = 'model';
  let meshCount = 0;

  for (const mesh of meshes) {
    const rawMats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (rawMats.length === 0) continue;

    const worldMatrix = mesh.matrixWorld.clone();
    const isReflected = worldMatrix.determinant() < 0;
    const needsBake = isReflected || hasNegativeScaleInChain(mesh, contentRoot);

    const parts: THREE.Mesh[] = Array.isArray(mesh.material)
      ? splitMultiMaterialMesh(mesh, rawMats)
      : [new THREE.Mesh(mesh.geometry.clone(), toUSDZStandardMaterial(rawMats[0]))];

    for (const part of parts) {
      part.name = part.name || mesh.name;
      if (needsBake) {
        part.geometry.applyMatrix4(worldMatrix);
        if (isReflected) flipGeometryWinding(part.geometry);
        ensureNormals(part.geometry);
        normalizedGroup.add(part);
      } else {
        part.applyMatrix4(worldMatrix);
        ensureNormals(part.geometry);
        normalizedGroup.add(part);
      }
      meshCount++;
    }
  }

  const oldRoot = new THREE.Group();
  for (const child of [...contentRoot.children]) {
    oldRoot.add(child);
  }
  disposeModel(oldRoot);

  for (const child of [...normalizedGroup.children]) {
    contentRoot.add(child);
  }
  return meshCount;
}

export function buildUSDZScene(
  project: Project,
  visibility?: Partial<PlanLayerSwitches>,
): { root: THREE.Group; meshCount: number } {
  const showWalls = visibility?.walls !== false;
  const showDoors = visibility?.doors !== false;
  const showWindows = visibility?.windows !== false;
  const showFurniture = visibility?.furniture !== false;
  const showStairs = visibility?.stairs !== false;
  const showColumns = visibility?.columns !== false;
  const showFloorPlanes = visibility?.floorPlanes !== false;

  const contentRoot = new THREE.Group();
  contentRoot.name = safeFileName(project.name);

  for (const { floor, elevation } of floorElevations(project.floors)) {
    const floorGroup = new THREE.Group();
    floorGroup.position.y = elevation;
    floorGroup.name = floor.name || `Floor_${floor.level ?? 0}`;

    addRoomMeshes(floorGroup, floor);

    if (showFloorPlanes) {
      for (const plane of floor.floorPlanes ?? []) {
        addFloorPlaneMesh(floorGroup, plane);
      }
    }

    if (showWalls) {
      for (const wall of floor.walls) {
        const wallDoors = showDoors ? floor.doors.filter(d => d.wallId === wall.id) : [];
        const wallWindows = showWindows ? floor.windows.filter(w => w.wallId === wall.id) : [];
        addWallMeshes(floorGroup, wall, wallDoors, wallWindows);
      }
    }

    if (showDoors) {
      for (const door of floor.doors) {
        const wall = floor.walls.find(w => w.id === door.wallId);
        if (wall) addDoorMeshes(floorGroup, door, wall);
      }
    }

    if (showWindows) {
      for (const win of floor.windows) {
        const wall = floor.walls.find(w => w.id === win.wallId);
        if (wall) addWindowMeshes(floorGroup, win, wall);
      }
    }

    if (showStairs) {
      for (const stair of floor.stairs) {
        addStairMeshes(floorGroup, stair, project, floor.id);
      }
    }

    if (showColumns) {
      for (const col of floor.columns) {
        addColumnMesh(floorGroup, col);
      }
    }

    if (showFurniture) {
      for (const item of floor.furniture) {
        const model = createPlacedFurnitureModel(item, undefined, project);
        if (model) floorGroup.add(model);
      }
    }

    contentRoot.add(floorGroup);
  }

  const meshCount = prepareContentForUSDZ(contentRoot);

  // Center horizontally around X=0, Z=0 and place the lowest surface at Y=0.
  const bounds = new THREE.Box3().setFromObject(contentRoot);
  if (!bounds.isEmpty()) {
    const center = bounds.getCenter(new THREE.Vector3());
    contentRoot.position.set(-center.x, -bounds.min.y, -center.z);
  }

  // OpenPlan3D uses centimetres; USDZ uses metres (metersPerUnit = 1).
  // USDZExporter traverses root.children rather than root's own transform, so
  // the cm->m scale lives on scaleGroup inside root, wrapping the centered contentRoot.
  const scaleGroup = new THREE.Group();
  scaleGroup.scale.setScalar(CM_TO_METERS);
  scaleGroup.add(contentRoot);

  const root = new THREE.Group();
  root.add(scaleGroup);
  return { root, meshCount };
}

export async function exportProjectAsUSDZ(
  project: Project,
  visibility?: Partial<PlanLayerSwitches>,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const { root, meshCount } = buildUSDZScene(project, visibility);
  try {
    if (meshCount === 0) return null;
    const exporter = new USDZExporter();
    return await exporter.parseAsync(root, { includeAnchoringProperties: true });
  } finally {
    disposeModel(root);
  }
}

export async function exportAsUSDZ(
  project: Project,
  visibility?: Partial<PlanLayerSwitches>,
): Promise<boolean> {
  const bytes = await exportProjectAsUSDZ(project, visibility);
  if (!bytes) return false;
  const blob = new Blob([bytes], { type: 'model/vnd.usdz+zip' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeFileName(project.name)}.usdz`;
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
  return true;
}
