/* Commons World: walking and flying.
 *
 * Desktop: pointer lock (the vendored PointerLockControls addon turns the mouse into
 * look), W A S D or arrows to move, Space and Shift for up and down while flying
 * (jump and run while walking), F to switch. Without pointer lock a mouse drag also
 * looks around. Touch: a joystick on the left, drag anywhere else to look, and
 * buttons for flying and for up and down.
 *
 * Walking uses the ground height straight from the decoded heights (groundAt), never
 * a raycast: eye height 1.7 m, gravity, and an automatic step up of at most 1.1 m.
 */
import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

export const EYE = 1.7;
const STEP_UP = 1.1;
const GRAVITY = 20;
const WALK = 4.2;
const RUN = 10;
const JUMP = 5.5;
const LOOK_DRAG = 0.0042;     // radians per CSS pixel, mouse drag
const LOOK_TOUCH = 0.0055;    // radians per CSS pixel, touch drag
const MAX_PITCH = Math.PI / 2 - 0.02;

function isTypingTarget(t) {
  if (!t || !t.closest) return false;
  return !!t.closest('input, textarea, select, [contenteditable="true"]');
}

export class Controls {
  constructor({ camera, canvas, groundAt, onChange, onModeChange, onTap, onLockChange }) {
    this.camera = camera;
    this.canvas = canvas;
    this.groundAt = groundAt;
    this.onChange = onChange || (() => {});
    this.onModeChange = onModeChange || (() => {});
    this.onTap = onTap || (() => {});
    this.onLockChange = onLockChange || (() => {});
    this.mode = 'walk';
    this.feet = new THREE.Vector3();
    this.vy = 0;
    this.onGround = false;
    this.eyeY = null;
    this.keys = new Set();
    this.stick = { x: 0, y: 0, active: false };
    this.buttonsVertical = 0;
    this.euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this.moving = false;

    this.lock = new PointerLockControls(camera, canvas);
    this.lock.addEventListener('change', () => this.onChange());
    this.lock.addEventListener('lock', () => this.onLockChange(true));
    this.lock.addEventListener('unlock', () => this.onLockChange(false));

    this._keys();
    this._pointer();
  }

  // ---------------------------------------------------------- orientation
  get yaw() { this.euler.setFromQuaternion(this.camera.quaternion, 'YXZ'); return this.euler.y; }
  get pitch() { this.euler.setFromQuaternion(this.camera.quaternion, 'YXZ'); return this.euler.x; }

  setLook(yaw, pitch) {
    this.euler.set(Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch)), yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(this.euler);
  }

  addLook(dYaw, dPitch) {
    this.euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.setLook(this.euler.y + dYaw, this.euler.x + dPitch);
    this.onChange();
  }

  // Face a point: yaw from the horizontal direction, pitch from the height difference.
  lookAt(x, y, z) {
    const eye = this.camera.position;
    const dx = x - eye.x, dz = z - eye.z, dy = y - eye.y;
    this.setLook(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
  }

  place(x, y, z) {
    this.feet.set(x, y, z);
    this.vy = 0;
    this.eyeY = null;
    this.syncCamera();
  }

  syncCamera() {
    const target = this.feet.y + EYE;
    if (this.mode === 'walk' && this.eyeY !== null && target > this.eyeY) {
      this.eyeY = Math.min(target, this.eyeY + Math.max(0.05, (target - this.eyeY) * 0.35));
    } else {
      this.eyeY = target;
    }
    this.camera.position.set(this.feet.x, this.eyeY, this.feet.z);
  }

  setMode(mode) {
    if (mode !== 'walk' && mode !== 'fly') return;
    if (mode === this.mode) return;
    this.mode = mode;
    this.vy = 0;
    this.onModeChange(mode);
    this.onChange();
  }

  toggleMode() { this.setMode(this.mode === 'walk' ? 'fly' : 'walk'); }

  // ---------------------------------------------------------- input
  _keys() {
    const codes = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
                           'Space', 'ShiftLeft', 'ShiftRight', 'KeyQ', 'KeyE']);
    window.addEventListener('keydown', (ev) => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey || isTypingTarget(ev.target)) return;
      const t = ev.target && ev.target.closest ? ev.target : null;
      // panels keep their keys (scrolling, links); a focused button keeps Space and Enter
      if (t && t.closest('#specs, #help, #credits, #sun') && !this.lock.isLocked) return;
      if (t && t.closest('button, a, summary') && (ev.code === 'Space' || ev.code === 'Enter')) return;
      if (ev.code === 'KeyF' && !ev.repeat) { this.toggleMode(); ev.preventDefault(); return; }
      if (codes.has(ev.code)) {
        this.keys.add(ev.code);
        if (ev.code === 'Space' && this.mode === 'walk' && this.onGround) this.vy = JUMP;
        ev.preventDefault();
        this.onChange();
      }
    });
    window.addEventListener('keyup', (ev) => { if (this.keys.delete(ev.code)) this.onChange(); });
    window.addEventListener('blur', () => { this.keys.clear(); this.stick.x = this.stick.y = 0; });
  }

  _pointer() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 && ev.pointerType === 'mouse') return;
      drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, moved: 0, type: ev.pointerType, t: performance.now() };
      try { c.setPointerCapture(ev.pointerId); } catch (e) { /* not capturable: fine */ }
    });
    c.addEventListener('pointermove', (ev) => {
      if (!drag || ev.pointerId !== drag.id || this.lock.isLocked) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      drag.x = ev.clientX; drag.y = ev.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.moved > 4) {
        const k = drag.type === 'touch' ? LOOK_TOUCH : LOOK_DRAG;
        this.addLook(-dx * k, -dy * k);
      }
    });
    const end = (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      const tap = drag.moved <= 6 && performance.now() - drag.t < 600;
      const type = drag.type;
      drag = null;
      if (ev.type === 'pointerup' && tap) {
        if (this.lock.isLocked) this.onTap(null, type);
        else this.onTap({ x: ev.clientX, y: ev.clientY }, type);
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  requestLock() {
    try {
      const p = this.canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* pointer lock is not available here (iOS, some embeds) */ }
  }

  bindStick(base, knob) {
    let id = null, cx = 0, cy = 0;
    const R = 46;
    const set = (ev) => {
      let dx = ev.clientX - cx, dy = ev.clientY - cy;
      const len = Math.hypot(dx, dy);
      if (len > R) { dx *= R / len; dy *= R / len; }
      knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      this.stick.x = dx / R;
      this.stick.y = -dy / R;
      this.onChange();
    };
    base.addEventListener('pointerdown', (ev) => {
      id = ev.pointerId;
      const r = base.getBoundingClientRect();
      cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      try { base.setPointerCapture(id); } catch (e) { /* fine */ }
      this.stick.active = true;
      set(ev);
      ev.preventDefault();
    });
    base.addEventListener('pointermove', (ev) => { if (ev.pointerId === id) set(ev); });
    const stop = (ev) => {
      if (ev.pointerId !== id) return;
      id = null;
      this.stick.x = this.stick.y = 0;
      this.stick.active = false;
      knob.style.transform = '';
      this.onChange();
    };
    base.addEventListener('pointerup', stop);
    base.addEventListener('pointercancel', stop);
  }

  bindHold(button, dir) {
    const on = (ev) => { this.buttonsVertical = dir; this.onChange(); ev.preventDefault(); };
    const off = () => { if (this.buttonsVertical === dir) this.buttonsVertical = 0; this.onChange(); };
    button.addEventListener('pointerdown', on);
    button.addEventListener('pointerup', off);
    button.addEventListener('pointercancel', off);
    button.addEventListener('pointerleave', off);
    // and from the keyboard: Enter or Space held on the focused button, like a press
    const isKey = (ev) => ev.code === 'Space' || ev.key === 'Enter';
    button.addEventListener('keydown', (ev) => { if (!isKey(ev)) return; ev.preventDefault(); if (!ev.repeat) on(ev); });
    button.addEventListener('keyup', (ev) => { if (isKey(ev)) off(); });
    button.addEventListener('blur', off);
  }

  // ---------------------------------------------------------- physics
  ground(x, z) {
    const g = this.groundAt(x, z);
    return g ? g.y : null;
  }

  /* Advance by dt seconds. Returns true while anything is still moving. */
  update(dt) {
    dt = Math.min(dt, 0.1);
    const k = this.keys;
    let ix = 0, iz = 0, iy = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) iz += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) iz -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) ix += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) ix -= 1;
    ix += this.stick.x; iz += this.stick.y;
    const len = Math.hypot(ix, iz);
    if (len > 1) { ix /= len; iz /= len; }
    const shift = k.has('ShiftLeft') || k.has('ShiftRight');
    if (this.mode === 'fly') {
      if (k.has('Space') || k.has('KeyE')) iy += 1;
      if (shift || k.has('KeyQ')) iy -= 1;
      iy += this.buttonsVertical;
    }
    const yaw = this.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const g0 = this.ground(this.feet.x, this.feet.z);
    let moving = len > 0.001 || iy !== 0;

    if (this.mode === 'fly') {
      const agl = g0 === null ? 50 : Math.max(0, this.feet.y - g0);
      const speed = Math.min(320, 12 + 0.6 * agl);
      this.feet.x += (fx * iz + rx * ix) * speed * dt;
      this.feet.z += (fz * iz + rz * ix) * speed * dt;
      this.feet.y += iy * Math.max(6, speed * 0.6) * dt;
      // Where no ground is known (beyond the world's edge, or not loaded yet) the floor is
      // the water plane at 0, so flying never goes under the sea.
      const g = this.ground(this.feet.x, this.feet.z);
      const floor = g === null ? 0 : g;
      if (this.feet.y < floor + 0.3) this.feet.y = floor + 0.3;
      this.onGround = false;
    } else {
      const speed = shift ? RUN : WALK;
      const dx = (fx * iz + rx * ix) * speed * dt, dz = (fz * iz + rz * ix) * speed * dt;
      if (dx || dz) {
        if (!this._tryMove(dx, dz) && !this._tryMove(dx, 0)) this._tryMove(0, dz);
      }
      // gravity, only where the ground is known
      const g = this.ground(this.feet.x, this.feet.z);
      if (g !== null) {
        this.vy -= GRAVITY * dt;
        this.feet.y += this.vy * dt;
        if (this.feet.y <= g) {
          this.feet.y = g;
          this.vy = 0;
          this.onGround = true;
        } else {
          this.onGround = false;
          moving = true;
        }
      }
    }
    this.syncCamera();
    if (this.eyeY !== null && Math.abs(this.eyeY - (this.feet.y + EYE)) > 0.001) moving = true;
    this.moving = moving;
    return moving;
  }

  _tryMove(dx, dz) {
    const nx = this.feet.x + dx, nz = this.feet.z + dz;
    const g = this.ground(nx, nz);
    if (g === null) return false;                            // not loaded yet: wait at the edge
    if (g - this.feet.y > STEP_UP) return false;              // a wall higher than a step
    this.feet.x = nx;
    this.feet.z = nz;
    if (g > this.feet.y && this.onGround) this.feet.y = g;   // step up
    return true;
  }
}
