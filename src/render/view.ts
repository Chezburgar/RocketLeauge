import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { BALL_RADIUS, DT } from '../physics/constants';
import { MAX_CARS } from '../physics/world';
import { TEAM_COLORS, type Loadout } from '../game/types';
import { buildArena, type ArenaRefs } from './arena';
import { buildCar, type CarVisual } from './carModel';
import { Effects } from './effects';
import type { Frame } from './frame';
import { makeRadialTexture } from './textures';

export type CamMode = 'car' | 'menu' | 'garage' | 'replay' | 'goal' | 'spectate' | 'title';

export interface CameraSettings {
  fov: number; // horizontal degrees
  distance: number;
  height: number;
  angle: number; // degrees
  stiffness: number;
  swivel: number;
  shake: boolean;
}

export const DEFAULT_CAMERA: CameraSettings = { fov: 110, distance: 2.7, height: 1.0, angle: -4, stiffness: 0.45, swivel: 4.5, shake: true };

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

interface CarSlot {
  visual: CarVisual | null;
  key: string;
  wheelSpin: number;
  lastGround: boolean;
  loadout: Loadout | null;
  team: number;
}

export class GameView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly effects = new Effects();
  arena!: ArenaRefs;
  camSettings: CameraSettings = { ...DEFAULT_CAMERA };
  ballCam = true;
  camMode: CamMode = 'title';
  focusSlot = 0;
  quality = 2;
  private composer!: EffectComposer;
  private bloom!: UnrealBloomPass;
  private smaa: SMAAPass | null = null;
  private sun!: THREE.DirectionalLight;
  private cars: CarSlot[] = [];
  private ball!: THREE.Group;
  private ballQuat = new THREE.Quaternion();
  private ballShadow!: THREE.Mesh;
  private camPos = new THREE.Vector3(0, 10, -30);
  private camLook = new THREE.Vector3();
  private camUp = new THREE.Vector3(0, 1, 0);
  private time = 0;
  private menuAngle = 0;
  private replayCamPos = new THREE.Vector3(0, 8, 0);
  goalFocus = new THREE.Vector3();
  /** hide the ball (after a goal) */
  ballHidden = false;
  private width = 1;
  private height = 1;

  constructor(canvas: HTMLCanvasElement, quality: number) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.shadowMap.enabled = quality > 0;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 2500);
    this.scene.background = new THREE.Color(0x05070f);
    this.scene.fog = new THREE.Fog(0x0a0c1c, 250, 900);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();

    this.setupLights();
    this.arena = buildArena(this.renderer.capabilities.getMaxAnisotropy(), quality);
    this.scene.add(this.arena.group);
    this.scene.add(this.effects.group);
    this.effects.quality = quality;
    this.buildBall();
    for (let i = 0; i < MAX_CARS; i++) this.cars.push({ visual: null, key: '', wheelSpin: 0, lastGround: true, loadout: null, team: 0 });
    this.setupComposer();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private setupLights() {
    const hemi = new THREE.HemisphereLight(0xaac4ff, 0x20242c, 0.85);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff1dd, 1.7);
    sun.position.set(30, 60, -20);
    sun.castShadow = this.quality > 0;
    const s = sun.shadow;
    s.mapSize.set(this.quality > 1 ? 4096 : 2048, this.quality > 1 ? 4096 : 2048);
    s.camera.left = -62;
    s.camera.right = 62;
    s.camera.top = 70;
    s.camera.bottom = -70;
    s.camera.near = 10;
    s.camera.far = 160;
    s.bias = -0.0004;
    s.normalBias = 0.04;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;
    const fill = new THREE.DirectionalLight(0x88a0ff, 0.5);
    fill.position.set(-40, 30, 40);
    this.scene.add(fill);
  }

  private setupComposer() {
    const r = this.renderer;
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: this.quality > 1 ? 4 : 0 });
    this.composer = new EffectComposer(r, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.45, 1.6);
    this.bloom.enabled = this.quality > 0;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    if (this.quality === 1) {
      this.smaa = new SMAAPass();
      this.composer.addPass(this.smaa);
    }
  }

  private buildBall() {
    const g = new THREE.Group();
    // faceted panelled ball
    const geo = new THREE.IcosahedronGeometry(BALL_RADIUS, 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const ico = new THREE.IcosahedronGeometry(1, 0);
    const icoPos = ico.attributes.position;
    const centers: THREE.Vector3[] = [];
    for (let i = 0; i < icoPos.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(icoPos, i).normalize();
      if (!centers.some((c) => c.distanceTo(v) < 0.01)) centers.push(v);
    }
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i);
      b.fromBufferAttribute(pos, i + 1);
      c.fromBufferAttribute(pos, i + 2);
      const ctr = a.add(b).add(c).normalize();
      const near = centers.some((v) => v.dot(ctr) > 0.93);
      const shade = near ? 0.18 : 0.78 + Math.random() * 0.06;
      for (let k = 0; k < 3; k++) colors.set([shade, shade, shade * 1.03], (i + k) * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.45, metalness: 0.25 }));
    mesh.castShadow = true;
    g.add(mesh);
    // glowing seams
    const edges = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(BALL_RADIUS * 1.004, 1), 1);
    const seams = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: new THREE.Color(0.9, 1.8, 2.8), transparent: true, opacity: 0.6 }));
    g.add(seams);
    this.ball = g;
    this.scene.add(g);
    // blob shadow directly below the ball (helps judge height)
    const sh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: makeRadialTexture('rgba(0,0,0,0.85)', 'rgba(0,0,0,0)'), transparent: true, depthWrite: false }),
    );
    sh.rotation.x = -Math.PI / 2;
    sh.renderOrder = 1;
    this.ballShadow = sh;
    this.scene.add(sh);
  }

  setQuality(q: number) {
    this.quality = q;
    this.effects.quality = q;
    this.renderer.shadowMap.enabled = q > 0;
    this.sun.castShadow = q > 0;
    this.bloom.enabled = q > 0;
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.width = w;
    this.height = h;
    const pr = Math.min(window.devicePixelRatio || 1, this.quality > 1 ? 2 : this.quality === 1 ? 1.5 : 1);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
    this.camera.aspect = w / h;
    this.applyFov();
  }

  private applyFov() {
    const hfov = THREE.MathUtils.degToRad(this.camMode === 'car' ? this.camSettings.fov : 80);
    const vfov = 2 * Math.atan(Math.tan(hfov / 2) / this.camera.aspect);
    this.camera.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(vfov), 40, 100);
    this.camera.updateProjectionMatrix();
    this.effects.setViewport(this.height * this.renderer.getPixelRatio(), this.camera.fov);
  }

  setCamMode(m: CamMode) {
    if (this.camMode === m) return;
    this.camMode = m;
    this.applyFov();
  }

  /** Create / update car meshes for each slot. */
  setCar(slot: number, loadout: Loadout | null, team: number) {
    const s = this.cars[slot];
    const key = loadout ? JSON.stringify(loadout) + team : '';
    if (s.key === key) return;
    if (s.visual) {
      this.scene.remove(s.visual.root);
      s.visual.dispose();
      s.visual = null;
    }
    s.key = key;
    s.loadout = loadout;
    s.team = team;
    if (loadout) {
      s.visual = buildCar(loadout, team);
      this.scene.add(s.visual.root);
    }
  }

  getCarObject(slot: number) {
    return this.cars[slot]?.visual?.root ?? null;
  }

  /** Apply a (possibly interpolated) frame to the scene. */
  applyFrame(f: Frame, dt: number, emitEffects: boolean) {
    this.time += dt;
    // ball
    this.ball.visible = f.ballVisible && !this.ballHidden;
    this.ball.position.copy(f.ballPos);
    const w = f.ballAng.length();
    if (w > 1e-4) {
      _q.setFromAxisAngle(_v.copy(f.ballAng).multiplyScalar(1 / w), w * dt);
      this.ballQuat.premultiply(_q).normalize();
    }
    this.ball.quaternion.copy(this.ballQuat);
    const h = f.ballPos.y;
    this.ballShadow.visible = this.ball.visible && h < 18;
    this.ballShadow.position.set(f.ballPos.x, 0.03, f.ballPos.z);
    const s = BALL_RADIUS * 2.4 * (1 + h * 0.05);
    this.ballShadow.scale.set(s, s, s);
    (this.ballShadow.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.clamp(1 - h / 18, 0.15, 0.9);
    if (emitEffects && this.ball.visible) this.effects.ballTrail(f.ballPos, f.ballVel.length(), new THREE.Color(0.6, 0.85, 1.2));

    // cars
    for (let i = 0; i < MAX_CARS; i++) {
      const cf = f.cars[i];
      const slot = this.cars[i];
      const v = slot.visual;
      if (!v) continue;
      v.root.visible = cf.present && !cf.demolished;
      if (!v.root.visible) continue;
      v.root.position.copy(cf.pos);
      v.root.quaternion.copy(cf.quat);
      // wheels
      const fwdSpeed = _v.set(1, 0, 0).applyQuaternion(cf.quat).dot(cf.vel);
      slot.wheelSpin += fwdSpeed * dt;
      for (let k = 0; k < 4; k++) {
        const wv = v.wheels[k];
        const len = cf.wheelLen[k] || 0.13;
        wv.pivot.position.y = THREE.MathUtils.clamp(0.1 - len, -0.12, 0.05);
        wv.pivot.rotation.y = wv.front ? -cf.steer : 0;
        wv.spin.rotation.z = -slot.wheelSpin / wv.radius;
      }
      // boost
      const boosting = cf.boosting;
      v.flame.visible = boosting;
      v.flameCore.visible = boosting;
      if (boosting) {
        const fl = 0.8 + Math.random() * 0.4;
        v.flame.scale.set(fl, 0.9 + Math.random() * 0.2, 0.9 + Math.random() * 0.2);
        v.flameCore.scale.set(fl, 1, 1);
        const lo = slot.loadout;
        if (lo) {
          const col = this.boostColor(lo, slot.team);
          (v.flame.material as THREE.MeshBasicMaterial).color.copy(col);
        }
      }
      if (emitEffects) {
        const exhaust = _v2.copy(v.exhaustLocal).applyQuaternion(cf.quat).add(cf.pos);
        const back = _v3.set(-1, 0, 0).applyQuaternion(cf.quat);
        if (boosting && slot.loadout)
          this.effects.boost(slot.loadout.boost, exhaust, back, cf.vel, new THREE.Color(TEAM_COLORS[slot.team as 0 | 1]), new THREE.Color(slot.loadout.accent), dt);
        if (cf.supersonic) this.effects.supersonic(exhaust, cf.vel);
        if (!slot.lastGround && cf.onGround && Math.abs(cf.vel.y) > 2) this.effects.landDust(cf.pos, 10);
      }
      slot.lastGround = cf.onGround;
    }
    // boost pads
    this.arena.update(this.time);
    this.effects.update(dt);
  }

  setPadStates(timers: number[]) {
    const pads = this.arena.pads;
    for (let i = 0; i < pads.length && i < timers.length; i++) {
      const active = timers[i] <= 0;
      pads[i].glow.visible = active;
    }
  }

  private boostColor(lo: Loadout, team: number) {
    switch (lo.boost) {
      case 'neon':
        return new THREE.Color(lo.accent).multiplyScalar(2);
      case 'plasma':
        return new THREE.Color(0.6, 0.3, 1.5);
      case 'lightning':
        return new THREE.Color(0.6, 0.9, 1.8);
      case 'bubbles':
        return new THREE.Color(0.5, 0.8, 1.2);
      case 'rainbow':
        return new THREE.Color().setHSL((this.time * 0.8) % 1, 1, 0.6);
      case 'sparkle':
        return new THREE.Color(1.5, 1.3, 0.6);
      default:
        return new THREE.Color(1.4, 0.6, 0.15);
    }
  }

  /** Place the camera for this frame. */
  updateCamera(f: Frame, dt: number) {
    const cs = this.camSettings;
    const cam = this.camera;
    const shakeAmt = cs.shake ? this.effects.shake : 0;
    switch (this.camMode) {
      case 'title': {
        this.menuAngle += dt * 0.05;
        const r = 58;
        _v.set(Math.sin(this.menuAngle) * r, 16 + Math.sin(this.menuAngle * 0.7) * 3, Math.cos(this.menuAngle) * r * 0.85);
        this.camPos.lerp(_v, 1 - Math.exp(-dt * 2));
        this.camLook.lerp(_v2.set(0, 3, 0), 1 - Math.exp(-dt * 2));
        this.camUp.copy(WORLD_UP);
        break;
      }
      case 'menu':
      case 'garage': {
        const car = f.cars[this.focusSlot];
        const center = car.present ? car.pos : _v3.set(0, 0.2, 0);
        const garage = this.camMode === 'garage';
        // gentle swing around the front three-quarter view
        this.menuAngle += dt * (garage ? 0.25 : 0.12);
        const ang = 0.55 + Math.sin(this.menuAngle) * (garage ? 1.1 : 0.55);
        const r = garage ? 3.3 : 3.6;
        _v.set(center.x + Math.sin(ang) * r, center.y + (garage ? 0.75 : 0.85), center.z + Math.cos(ang) * r);
        this.camPos.lerp(_v, 1 - Math.exp(-dt * 3));
        // aim left of the car so it sits in the right half of the screen (menus are on the left)
        const toCar = _v2.subVectors(center, this.camPos).setY(0).normalize();
        const right = _v.crossVectors(toCar, WORLD_UP).normalize();
        const look = _v2.copy(center).addScaledVector(right, garage ? -1.25 : -1.05);
        look.y += 0.2;
        this.camLook.lerp(look, 1 - Math.exp(-dt * 3));
        this.camUp.copy(WORLD_UP);
        break;
      }
      case 'replay': {
        const b = f.ballPos;
        const side = b.x > 0 ? 1 : -1;
        _v.set(b.x + side * 12, Math.max(4, b.y + 5), b.z - Math.sign(b.z || 1) * 14);
        this.replayCamPos.lerp(_v, 1 - Math.exp(-dt * 1.5));
        this.camPos.copy(this.replayCamPos);
        this.camLook.lerp(b, 1 - Math.exp(-dt * 6));
        this.camUp.copy(WORLD_UP);
        break;
      }
      case 'goal': {
        this.menuAngle += dt * 0.3;
        const g = this.goalFocus;
        _v.set(g.x + Math.sin(this.menuAngle) * 22, 9, g.z - Math.sign(g.z || 1) * (18 + Math.cos(this.menuAngle) * 6));
        this.camPos.lerp(_v, 1 - Math.exp(-dt * 1.5));
        this.camLook.lerp(g, 1 - Math.exp(-dt * 3));
        this.camUp.copy(WORLD_UP);
        break;
      }
      case 'spectate': {
        const b = f.ballPos;
        _v.set(b.x * 0.6, 22, b.z - 30 * Math.sign(b.z + 0.001) * 0 - 30);
        this.camPos.lerp(_v, 1 - Math.exp(-dt * 2));
        this.camLook.lerp(b, 1 - Math.exp(-dt * 4));
        this.camUp.copy(WORLD_UP);
        break;
      }
      case 'car': {
        const car = f.cars[this.focusSlot];
        if (!car.present || car.demolished) {
          // demolished: hold position and watch the ball
          this.camLook.lerp(f.ballPos, 1 - Math.exp(-dt * 3));
          break;
        }
        const carUp = _v3.set(0, 1, 0).applyQuaternion(car.quat);
        // camera up follows the surface while driving, world-up in the air
        const targetUp = car.wheelsInContact >= 3 && !car.demolished ? carUp : WORLD_UP;
        this.camUp.lerp(targetUp, 1 - Math.exp(-dt * 5)).normalize();
        const up = this.camUp;
        let dir: THREE.Vector3;
        if (this.ballCam && !this.ballHidden && f.ballVisible) {
          dir = _v.subVectors(car.pos, f.ballPos);
          dir.addScaledVector(up, -dir.dot(up) * 0.85);
          if (dir.lengthSq() < 1e-4) dir.set(0, 0, -1);
          dir.normalize();
        } else {
          const fwd = _v.set(1, 0, 0).applyQuaternion(car.quat);
          if (car.wheelsInContact < 3 && car.vel.lengthSq() > 16) fwd.copy(car.vel).normalize().lerp(_v2.set(1, 0, 0).applyQuaternion(car.quat), 0.5);
          fwd.addScaledVector(up, -fwd.dot(up));
          if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, 1);
          dir = fwd.normalize().negate();
        }
        const desired = _v2.copy(car.pos).addScaledVector(dir, cs.distance).addScaledVector(up, cs.height);
        const k = 8 + cs.stiffness * 40;
        this.camPos.lerp(desired, 1 - Math.exp(-dt * k));
        // keep the camera inside the arena-ish (don't clip through the floor)
        if (this.camPos.y < 0.3) this.camPos.y = 0.3;
        let look: THREE.Vector3;
        if (this.ballCam && !this.ballHidden && f.ballVisible) {
          look = _v.copy(f.ballPos);
          // don't let the view swing too high: blend towards a point ahead of the car
          const ahead = _v3.copy(car.pos).addScaledVector(dir, -4).addScaledVector(up, 0.6);
          const toBall = look.clone().sub(this.camPos).normalize();
          const vertical = toBall.dot(up);
          if (vertical > 0.35) look.lerp(ahead, THREE.MathUtils.clamp((vertical - 0.35) * 2, 0, 0.8));
        } else {
          look = _v.copy(car.pos).addScaledVector(dir, -4).addScaledVector(up, cs.height * 0.4 + Math.tan(THREE.MathUtils.degToRad(cs.angle)) * 4);
        }
        this.camLook.lerp(look, 1 - Math.exp(-dt * (cs.swivel * 3 + 6)));
        break;
      }
    }
    cam.position.copy(this.camPos);
    if (shakeAmt > 0) {
      const s = shakeAmt * 0.25;
      cam.position.x += (Math.random() - 0.5) * s;
      cam.position.y += (Math.random() - 0.5) * s;
      cam.position.z += (Math.random() - 0.5) * s;
    }
    cam.up.copy(this.camUp);
    cam.lookAt(this.camLook);
    if (this.camMode === 'car') {
      // tilt down by the configured angle
      cam.rotateX(THREE.MathUtils.degToRad(this.camSettings.angle * 0.25));
    }
  }

  snapCamera() {
    this.camPos.copy(this.camera.position);
  }

  /** Project a world point to screen pixels (null if behind the camera). */
  project(p: THREE.Vector3): { x: number; y: number } | null {
    _v.copy(p).project(this.camera);
    if (_v.z > 1) return null;
    return { x: (_v.x * 0.5 + 0.5) * this.width, y: (-_v.y * 0.5 + 0.5) * this.height };
  }

  render() {
    this.composer.render(DT);
  }
}
