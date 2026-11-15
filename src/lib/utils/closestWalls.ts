import * as THREE from 'three';
import type { Wall } from '$lib/models/types';
import { wallPathSpans } from '$lib/utils/wallProfiles';

export interface CameraPoint3D {
  x: number;
  y: number;
  z: number;
}

/**
 * Shortest 3D Euclidean distance from `point` (camera position) to a wall's
 * geometry on `floorElevation`, supporting straight, sloped, and curved walls.
 */
export function wallDistanceToPoint(wall: Wall, point: CameraPoint3D, floorElevation = 0): number {
  const halfThickness = Math.max(0, wall.thickness) / 2;
  let minDistance = Infinity;

  for (const span of wallPathSpans(wall)) {
    const dx = span.end.x - span.start.x;
    const dz = span.end.y - span.start.y;
    const lenSq = dx * dx + dz * dz;
    const t = lenSq > 0
      ? Math.max(0, Math.min(1, ((point.x - span.start.x) * dx + (point.z - span.start.y) * dz) / lenSq))
      : 0;
    const cx = span.start.x + t * dx;
    const cz = span.start.y + t * dz;
    const topY = floorElevation + span.startHeight + (span.endHeight - span.startHeight) * t;
    const cy = Math.max(floorElevation, Math.min(topY, point.y));
    const distance = Math.max(0, Math.hypot(point.x - cx, point.y - cy, point.z - cz) - halfThickness);
    if (distance < minDistance) minDistance = distance;
  }

  return minDistance;
}

/**
 * Returns the IDs of up to `count` walls closest to `cameraPosition`.
 */
export function closestWallIds(
  walls: readonly Wall[],
  cameraPosition: CameraPoint3D,
  floorElevation = 0,
  count = 2
): string[] {
  if (count <= 0 || walls.length === 0) return [];
  return walls
    .map((wall) => ({ id: wall.id, distance: wallDistanceToPoint(wall, cameraPosition, floorElevation) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, count)
    .map((entry) => entry.id);
}

/**
 * Sims-style wall cutaway manager. Clones materials only for the currently
 * faded wall meshes (leaving shared default wall/baseboard materials intact)
 * and restores + disposes cloned materials on clear().
 */
export function createWallFade(opacity = 0.2) {
  const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  const clones = new Map<THREE.Material, THREE.Material>();

  function clear() {
    for (const [mesh, material] of originals) mesh.material = material;
    originals.clear();
    for (const material of clones.values()) material.dispose();
    clones.clear();
  }

  function clone(material: THREE.Material) {
    if (!clones.has(material)) {
      const faded = material.clone();
      faded.transparent = true;
      faded.opacity = Math.min(material.transparent ? material.opacity : 1, opacity);
      faded.depthWrite = false;
      faded.needsUpdate = true;
      clones.set(material, faded);
    }
    return clones.get(material)!;
  }

  return {
    clear,
    apply(meshes: Iterable<THREE.Mesh>, ids: ReadonlySet<string>) {
      clear();
      if (ids.size === 0) return;
      for (const mesh of meshes) {
        const wallId = mesh.userData.cutawayWallId ?? mesh.userData.wallId;
        if (typeof wallId !== 'string' || !ids.has(wallId)) continue;
        originals.set(mesh, mesh.material);
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(clone) : clone(mesh.material);
      }
    }
  };
}
