import { beforeEach, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
  addFloorPlane,
  updateFloorPlane,
  moveFloorPlane,
  removeFloorPlane,
  currentProject,
  loadProject,
  undo,
  redo,
} from '$lib/stores/project';
import { floorPlaneBounds, floorPlaneContainsPoint } from '$lib/utils/floorPlaneGeometry';
import { readProject } from '$lib/utils/projectValidation';
import { roomProject } from './fixtures/project';

beforeEach(() => loadProject(roomProject()));

it('adds, updates, moves, and removes horizontal floor planes with undo/redo', () => {
  const id = addFloorPlane({ x: 200, y: 150 }, { width: 500, height: 300, thickness: 25, elevation: 120 });
  const floor = () => get(currentProject)!.floors[0];
  expect(floor().floorPlanes).toHaveLength(1);
  expect(floor().floorPlanes?.[0]).toMatchObject({
    id,
    position: { x: 200, y: 150 },
    width: 500,
    height: 300,
    thickness: 25,
    elevation: 120,
    rotation: 0,
  });

  updateFloorPlane(id, { width: 600, thickness: 30, elevation: 140 });
  expect(floor().floorPlanes?.[0]).toMatchObject({ width: 600, thickness: 30, elevation: 140 });

  moveFloorPlane(id, { x: 250, y: 200 });
  expect(floor().floorPlanes?.[0].position).toEqual({ x: 250, y: 200 });

  removeFloorPlane(id);
  expect(floor().floorPlanes).toEqual([]);

  undo();
  expect(floor().floorPlanes).toHaveLength(1);
  redo();
  expect(floor().floorPlanes).toEqual([]);
});

it('computes rotated floor plane bounds and hit-tests points accurately', () => {
  const unrotated = { position: { x: 100, y: 200 }, width: 400, height: 200, rotation: 0 };
  expect(floorPlaneBounds(unrotated)).toEqual({ minX: -100, minY: 100, maxX: 300, maxY: 300 });
  expect(floorPlaneContainsPoint({ x: 250, y: 250 }, unrotated)).toBe(true);
  expect(floorPlaneContainsPoint({ x: 250, y: 310 }, unrotated)).toBe(false);

  const rotated90 = { position: { x: 100, y: 200 }, width: 400, height: 200, rotation: 90 };
  const bounds = floorPlaneBounds(rotated90);
  expect(bounds.minX).toBeCloseTo(0);
  expect(bounds.maxX).toBeCloseTo(200);
  expect(bounds.minY).toBeCloseTo(0);
  expect(bounds.maxY).toBeCloseTo(400);
  expect(floorPlaneContainsPoint({ x: 150, y: 350 }, rotated90)).toBe(true);
  expect(floorPlaneContainsPoint({ x: 250, y: 200 }, rotated90)).toBe(false);
});

it('validates floorPlanes on readProject and rejects invalid dimensions', () => {
  const project = roomProject();
  addFloorPlane({ x: 100, y: 100 }, { width: 450, height: 350, thickness: 18, elevation: -10 });
  const loaded = readProject(JSON.parse(JSON.stringify(get(currentProject) ?? project)));
  expect(loaded.floors[0].floorPlanes).toHaveLength(1);
  expect(loaded.floors[0].floorPlanes?.[0]).toMatchObject({ width: 450, height: 350, thickness: 18, elevation: -10 });

  for (const field of ['width', 'height', 'thickness'] as const) {
    const raw = JSON.parse(JSON.stringify(loaded));
    raw.floors[0].floorPlanes[0][field] = 0;
    expect(() => readProject(raw)).toThrow();
  }
});
