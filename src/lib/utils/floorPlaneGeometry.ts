import type { FloorPlane, Point } from '$lib/models/types';

/** Plan-space corners of a horizontal floor plane in clockwise order. */
export function floorPlaneCorners(plane: Pick<FloorPlane, 'position' | 'width' | 'height' | 'rotation'>): Point[] {
  const angle = (plane.rotation || 0) * Math.PI / 180;
  const c = Math.cos(angle), s = Math.sin(angle);
  const hw = plane.width / 2, hh = plane.height / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({
    x: plane.position.x + x * c - y * s,
    y: plane.position.y + x * s + y * c,
  }));
}

/** Axis-aligned plan bounds of a horizontal floor plane. */
export function floorPlaneBounds(plane: Pick<FloorPlane, 'position' | 'width' | 'height' | 'rotation'>) {
  const points = floorPlaneCorners(plane);
  return {
    minX: Math.min(...points.map(p => p.x)),
    minY: Math.min(...points.map(p => p.y)),
    maxX: Math.max(...points.map(p => p.x)),
    maxY: Math.max(...points.map(p => p.y)),
  };
}

/** Whether a plan coordinate falls inside the rotated rectangle of `plane`. */
export function floorPlaneContainsPoint(p: Point, plane: Pick<FloorPlane, 'position' | 'width' | 'height' | 'rotation'>): boolean {
  const dx = p.x - plane.position.x;
  const dy = p.y - plane.position.y;
  const angle = -((plane.rotation || 0) * Math.PI) / 180;
  const rx = dx * Math.cos(angle) - dy * Math.sin(angle);
  const ry = dx * Math.sin(angle) + dy * Math.cos(angle);
  return Math.abs(rx) <= plane.width / 2 && Math.abs(ry) <= plane.height / 2;
}
