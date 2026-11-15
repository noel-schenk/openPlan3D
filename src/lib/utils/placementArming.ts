import { get } from 'svelte/store';
import { placingColumn, placingColumnShape, placingEntourageId, placingFloorPlane, placingFurnitureId, placingStair, selectedTool } from '$lib/stores/project';

/**
 * Stairs, columns, and floor planes are one-shot modes of the select tool, armed from the Build
 * panel: at most one of them is armed, never beside a furniture or entourage placement. The tool
 * switches first because the canvas drops structure arming on every tool change.
 */
function armStructure(stair: boolean, column: boolean, floorPlane = false) {
  selectedTool.set('select');
  placingFurnitureId.set(null);
  placingEntourageId.set(null);
  placingStair.set(stair);
  placingColumn.set(column);
  placingFloorPlane.set(floorPlane);
}

/** Arms stair placement for the next canvas click, or cancels it when it is already armed. */
export function toggleStairPlacement() {
  armStructure(!get(placingStair), false, false);
}

/** Arms column placement with `shape`; the armed shape again cancels it, the other shape swaps it. */
export function toggleColumnPlacement(shape: 'round' | 'square') {
  const armed = get(placingColumn) && get(placingColumnShape) === shape;
  placingColumnShape.set(shape);
  armStructure(false, !armed, false);
}

/** Arms floor-plane placement for the next canvas click, or cancels it when already armed. */
export function toggleFloorPlanePlacement() {
  armStructure(false, false, !get(placingFloorPlane));
}
