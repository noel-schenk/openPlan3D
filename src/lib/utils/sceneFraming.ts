import type { Floor, Project } from '$lib/models/types';

/** What the 3D orbit camera was last fitted to: a project, its active floor and the all-floors view. */
export interface FramingContext {
  projectId: string;
  floorId: string;
  stacked: boolean;
}

export function framingContext(project: Pick<Project, 'id'>, floor: Pick<Floor, 'id'>, stacked: boolean): FramingContext {
  return { projectId: project.id, floorId: floor.id, stacked };
}

/**
 * Whether a scene rebuild fits the orbit camera to the scene again. Only the initial build,
 * another project or toggling all-floors stacking does: switching floors within the same project
 * keeps the user's camera viewpoint and zoom across floors.
 */
export function shouldFrameScene(previous: FramingContext | null, next: FramingContext): boolean {
  return previous === null || previous.projectId !== next.projectId || previous.stacked !== next.stacked;
}
