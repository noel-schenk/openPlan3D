import { Euler, type Camera } from 'three';

const keys = new Set([
  'KeyW', 'KeyS', 'KeyA', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'KeyE',
  'ShiftLeft', 'ShiftRight', 'KeyC', 'KeyQ',
]);

export interface FreeFlySettings {
  /** Flight speed in cm/s. */
  flySpeed: number;
}

const MAX_PITCH = Math.PI / 2 - 0.01;
const DAMPING = 14;

/**
 * Minecraft-style Creative free-fly camera motion:
 * - W/A/S/D or Arrow keys move horizontally relative to camera yaw
 * - Space / E fly straight up (+Y)
 * - Shift / C / Q fly straight down (-Y)
 */
export class FreeFlyMotion {
  private held = new Set<string>();
  private previous: number | null = null;
  private waitingForFirstFrame = false;
  private rightVelocity = 0;
  private forwardVelocity = 0;
  private verticalVelocity = 0;
  private rotation = new Euler(0, 0, 0, 'YXZ');

  get active(): boolean {
    const isHeld = (code: string) => this.held.has(code);
    const forward = (isHeld('KeyW') || isHeld('ArrowUp')) !== (isHeld('KeyS') || isHeld('ArrowDown'));
    const strafe = (isHeld('KeyD') || isHeld('ArrowRight')) !== (isHeld('KeyA') || isHeld('ArrowLeft'));
    const vertical = (isHeld('Space') || isHeld('KeyE')) !== (isHeld('ShiftLeft') || isHeld('ShiftRight') || isHeld('KeyC') || isHeld('KeyQ'));
    return Boolean(this.rightVelocity || this.forwardVelocity || this.verticalVelocity || forward || strafe || vertical);
  }

  /** Wake from the input event's clock without counting preceding idle time. */
  startClock(timestamp: number) {
    if (this.previous === null && Number.isFinite(timestamp)) {
      this.previous = timestamp;
      this.waitingForFirstFrame = true;
    }
  }

  stopClock() {
    this.previous = null;
    this.waitingForFirstFrame = false;
  }

  setKey(code: string, down: boolean, repeat = false): boolean {
    if (!keys.has(code)) return false;
    if (down && repeat && !this.held.has(code)) return true;
    if (down) this.held.add(code);
    else this.held.delete(code);
    return true;
  }

  reset() {
    this.held.clear();
    this.stopClock();
    this.rightVelocity = 0;
    this.forwardVelocity = 0;
    this.verticalVelocity = 0;
  }

  /** Apply pointer drag look delta (in CSS pixels) when pointer lock isn't active. */
  lookDelta(dx: number, dy: number, camera: Camera, sensitivity = 0.0025) {
    this.rotation.setFromQuaternion(camera.quaternion, 'YXZ');
    this.rotation.y -= dx * sensitivity;
    this.rotation.x = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.rotation.x - dy * sensitivity));
    camera.quaternion.setFromEuler(this.rotation);
  }

  advance(timestamp: number, camera: Camera, settings: FreeFlySettings) {
    if (!Number.isFinite(timestamp)) {
      this.reset();
      return;
    }
    if (this.previous === null) {
      this.previous = timestamp;
      return;
    }
    if (timestamp <= this.previous) {
      if (timestamp < this.previous && !this.waitingForFirstFrame) this.reset();
      return;
    }
    this.waitingForFirstFrame = false;

    const delta = Math.min((timestamp - this.previous) / 1000, 0.25);
    this.previous = timestamp;

    const isHeld = (code: string) => this.held.has(code);
    const rightInput = Number(isHeld('KeyD') || isHeld('ArrowRight')) - Number(isHeld('KeyA') || isHeld('ArrowLeft'));
    const forwardInput = Number(isHeld('KeyW') || isHeld('ArrowUp')) - Number(isHeld('KeyS') || isHeld('ArrowDown'));
    const verticalInput = Number(isHeld('Space') || isHeld('KeyE'))
      - Number(isHeld('ShiftLeft') || isHeld('ShiftRight') || isHeld('KeyC') || isHeld('KeyQ'));

    if (!rightInput && !forwardInput && !verticalInput
      && !this.rightVelocity && !this.forwardVelocity && !this.verticalVelocity) {
      return;
    }

    const horizLen = Math.hypot(rightInput, forwardInput) || 1;
    const speed = Math.max(50, settings.flySpeed);
    const targetRight = (rightInput / horizLen) * speed;
    const targetForward = (forwardInput / horizLen) * speed;
    const targetVertical = verticalInput * speed;

    const decay = Math.exp(-DAMPING * delta);
    const integral = -Math.expm1(-DAMPING * delta) / DAMPING;

    const rightDistance = targetRight * delta + (this.rightVelocity - targetRight) * integral;
    const forwardDistance = targetForward * delta + (this.forwardVelocity - targetForward) * integral;
    const verticalDistance = targetVertical * delta + (this.verticalVelocity - targetVertical) * integral;

    this.rightVelocity = targetRight + (this.rightVelocity - targetRight) * decay;
    this.forwardVelocity = targetForward + (this.forwardVelocity - targetForward) * decay;
    this.verticalVelocity = targetVertical + (this.verticalVelocity - targetVertical) * decay;

    if (Math.abs(this.rightVelocity) < 0.5 && rightInput === 0) this.rightVelocity = 0;
    if (Math.abs(this.forwardVelocity) < 0.5 && forwardInput === 0) this.forwardVelocity = 0;
    if (Math.abs(this.verticalVelocity) < 0.5 && verticalInput === 0) this.verticalVelocity = 0;

    this.rotation.setFromQuaternion(camera.quaternion, 'YXZ');
    const yaw = this.rotation.y;

    camera.position.x += Math.cos(yaw) * rightDistance - Math.sin(yaw) * forwardDistance;
    camera.position.z -= Math.sin(yaw) * rightDistance + Math.cos(yaw) * forwardDistance;
    camera.position.y += verticalDistance;
  }
}
