import { describe, expect, it } from 'vitest';
import { Euler, PerspectiveCamera } from 'three';
import { FreeFlyMotion } from '../src/lib/utils/freeFlyMotion';

function createCamera() {
  const camera = new PerspectiveCamera(65, 1, 1, 10000);
  camera.position.set(0, 160, 0);
  return camera;
}

describe('FreeFlyMotion', () => {
  it('moves forward/backward and strafes horizontally with WASD', () => {
    const motion = new FreeFlyMotion();
    const camera = createCamera();

    motion.setKey('KeyW', true);
    motion.startClock(0);
    motion.advance(100, camera, { flySpeed: 500 });
    expect(camera.position.z).toBeLessThan(0);
    expect(camera.position.x).toBeCloseTo(0, 5);
    expect(camera.position.y).toBeCloseTo(160, 5);

    motion.reset();
    camera.position.set(0, 160, 0);
    motion.setKey('KeyD', true);
    motion.startClock(200);
    motion.advance(300, camera, { flySpeed: 500 });
    expect(camera.position.x).toBeGreaterThan(0);
    expect(camera.position.z).toBeCloseTo(0, 5);
  });

  it('ascends on Space/E and descends on Shift/C/Q', () => {
    const motion = new FreeFlyMotion();
    const camera = createCamera();

    motion.setKey('Space', true);
    motion.startClock(0);
    motion.advance(100, camera, { flySpeed: 400 });
    expect(camera.position.y).toBeGreaterThan(160);

    const highY = camera.position.y;
    motion.setKey('Space', false);
    motion.setKey('ShiftLeft', true);
    motion.advance(300, camera, { flySpeed: 400 });
    expect(camera.position.y).toBeLessThan(highY);
  });

  it('moves horizontally even while pitched vertically and respects camera yaw', () => {
    const motion = new FreeFlyMotion();
    const camera = createCamera();
    camera.quaternion.setFromEuler(new Euler(-Math.PI / 3, Math.PI / 2, 0, 'YXZ'));

    motion.setKey('KeyW', true);
    motion.startClock(0);
    motion.advance(100, camera, { flySpeed: 500 });
    expect(camera.position.x).toBeLessThan(0);
    expect(camera.position.y).toBeCloseTo(160, 5);
  });

  it('rotates yaw and clamped pitch via lookDelta', () => {
    const motion = new FreeFlyMotion();
    const camera = createCamera();
    motion.lookDelta(100, -10000, camera, 0.01);
    const euler = new Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    expect(euler.y).toBeCloseTo(-1, 4);
    expect(euler.x).toBeLessThan(Math.PI / 2);
  });

  it('ignores non-fly keys and clears held movement on reset', () => {
    const motion = new FreeFlyMotion();
    expect(motion.setKey('KeyX', true)).toBe(false);
    motion.setKey('KeyE', true);
    expect(motion.active).toBe(true);
    motion.reset();
    expect(motion.active).toBe(false);
  });
});
