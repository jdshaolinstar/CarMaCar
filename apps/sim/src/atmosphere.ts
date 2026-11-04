// Headlights and rain for graphics level 6. Everything here is on the display-only layer, so car and
// garage cameras keep rendering the frames vision was measured on. Rain in the viewer is not rain in the
// camera frames: testing SAM in real rain would be a separate experiment.
import { Color4, Constants, DynamicTexture, Mesh, MeshBuilder, ParticleSystem, StandardMaterial, Color3, Vector3 } from '@babylonjs/core';
import { DISPLAY_ONLY_LAYER, type CityScene, type TimeOfDay } from './scene';
import type { World } from './world';

export type Weather = 'clear' | 'rain';

const MAX_CARS = 500;
const MATRIX_SIZE = 16;
/** Metres from a car's center to its nose and tail. */
const NOSE = 2.05;
const TAIL = 2.1;
const LIGHT_SPREAD = 0.62;
const LIGHT_HEIGHT = 0.68;
const BEAM_REACH = 6.5;
const BEAM_HEIGHT = 0.05;
const RAIN_CAPACITY = 5000;
const RAIN_BOX = 45;
/** Longest particle step, in seconds. */
const MAX_RAIN_STEP = 0.1;

function beamTexture(view: CityScene) {
  const texture = new DynamicTexture('atmo-beam', { width: 128, height: 256 }, view.scene, true);
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, 128, 256);
  ctx.filter = 'blur(10px)';
  // Canvas top is the far end of the beam.
  const fade = ctx.createLinearGradient(0, 0, 0, 256);
  fade.addColorStop(0, 'rgba(255,255,255,0)');
  fade.addColorStop(0.65, 'rgba(255,255,255,0.55)');
  fade.addColorStop(1, 'rgba(255,255,255,0.95)');
  ctx.fillStyle = fade;
  ctx.beginPath();
  ctx.moveTo(4, 12);
  ctx.lineTo(124, 12);
  ctx.lineTo(82, 246);
  ctx.lineTo(46, 246);
  ctx.closePath();
  ctx.fill();
  ctx.filter = 'none';
  texture.update();
  texture.hasAlpha = true;
  return texture;
}

function glowTexture(view: CityScene, name: string) {
  const texture = new DynamicTexture(name, { width: 128, height: 128 }, view.scene, true);
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  const gradient = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.45)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  texture.update();
  texture.hasAlpha = true;
  return texture;
}

export class Atmosphere {
  private enabled = false;
  private time: TimeOfDay = 'day';
  private weather: Weather = 'clear';
  private built = false;
  private head!: Mesh;
  private tail!: Mesh;
  private beam!: Mesh;
  private rain: ParticleSystem | null = null;
  private readonly headMatrices = new Float32Array(MAX_CARS * 2 * MATRIX_SIZE);
  private readonly tailMatrices = new Float32Array(MAX_CARS * 2 * MATRIX_SIZE);
  private readonly beamMatrices = new Float32Array(MAX_CARS * MATRIX_SIZE);

  constructor(
    private readonly view: CityScene,
    private readonly world: World,
  ) {
    view.scene.onBeforeRenderObservable.add(() => this.update());
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (on) this.build();
    this.refresh();
  }

  setTime(time: TimeOfDay) {
    this.time = time;
    this.refresh();
  }

  setWeather(weather: Weather) {
    this.weather = weather;
    this.refresh();
  }

  get carsShowLights() {
    return this.enabled && (this.time !== 'day' || this.weather === 'rain');
  }

  private refresh() {
    if (!this.built) return;
    const lights = this.carsShowLights;
    this.head.setEnabled(lights);
    this.tail.setEnabled(lights);
    this.beam.setEnabled(lights && this.time !== 'day');
    const raining = this.enabled && this.weather === 'rain';
    if (raining && !this.rain) this.buildRain();
    if (raining) this.rain?.start();
    else this.rain?.stop();
  }

  private emissive(name: string, hex: string) {
    const material = new StandardMaterial(name, this.view.scene);
    material.diffuseColor = Color3.Black();
    material.specularColor = Color3.Black();
    material.emissiveColor = Color3.FromHexString(hex);
    material.disableLighting = true;
    material.fogEnabled = false;
    return material;
  }

  private prepare(mesh: Mesh, buffer: Float32Array) {
    mesh.layerMask = DISPLAY_ONLY_LAYER;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.receiveShadows = false;
    mesh.thinInstanceSetBuffer('matrix', buffer, MATRIX_SIZE, false);
    mesh.thinInstanceCount = 0;
  }

  private build() {
    if (this.built) return;
    this.built = true;
    const scene = this.view.scene;
    this.head = MeshBuilder.CreateBox('atmo-head', { width: 0.34, height: 0.16, depth: 0.05 }, scene);
    this.head.material = this.emissive('atmo-head', '#fff4d6');
    this.prepare(this.head, this.headMatrices);
    this.tail = MeshBuilder.CreateBox('atmo-tail', { width: 0.34, height: 0.14, depth: 0.05 }, scene);
    this.tail.material = this.emissive('atmo-tail', '#ff2a1c');
    this.prepare(this.tail, this.tailMatrices);

    // A soft pool of light on the road ahead of each car, drawn on top rather than lit properly.
    this.beam = MeshBuilder.CreateGround('atmo-beam', { width: 6, height: BEAM_REACH * 2 }, scene);
    const material = this.emissive('atmo-beam', '#fff0cc');
    const glow = beamTexture(this.view);
    material.emissiveTexture = glow;
    material.opacityTexture = glow;
    material.alpha = 0.32;
    material.alphaMode = Constants.ALPHA_ADD;
    material.disableDepthWrite = true;
    this.beam.material = material;
    this.prepare(this.beam, this.beamMatrices);
  }

  private buildRain() {
    const scene = this.view.scene;
    const rain = new ParticleSystem('atmo-rain', RAIN_CAPACITY, scene);
    rain.particleTexture = glowTexture(this.view, 'atmo-rain');
    rain.layerMask = DISPLAY_ONLY_LAYER;
    rain.emitter = Vector3.Zero();
    rain.minEmitBox = new Vector3(-RAIN_BOX, -4, -RAIN_BOX);
    rain.maxEmitBox = new Vector3(RAIN_BOX, 34, RAIN_BOX);
    rain.color1 = new Color4(0.85, 0.9, 1, 0.75);
    rain.color2 = new Color4(0.75, 0.82, 0.95, 0.5);
    rain.colorDead = new Color4(0.6, 0.7, 0.9, 0);
    rain.minSize = 0.06;
    rain.maxSize = 0.11;
    rain.minScaleY = 9;
    rain.maxScaleY = 15;
    rain.minLifeTime = 0.6;
    rain.maxLifeTime = 0.9;
    rain.emitRate = RAIN_CAPACITY / 0.75;
    rain.blendMode = ParticleSystem.BLENDMODE_ADD;
    rain.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
    rain.direction1 = new Vector3(-1.5, -42, 0.6);
    rain.direction2 = new Vector3(-0.6, -50, 1.4);
    rain.gravity = Vector3.Zero();
    rain.minEmitPower = 1;
    rain.maxEmitPower = 1;
    rain.updateSpeed = 1 / 60;
    this.rain = rain;
  }

  private update() {
    if (!this.enabled) return;
    const camera = this.view.scene.activeCamera;
    if (this.rain && camera) {
      (this.rain.emitter as Vector3).copyFrom(camera.globalPosition);
      // Particles step once per frame, so the step has to match real time or slow machines get slow rain.
      this.rain.updateSpeed = Math.min(MAX_RAIN_STEP, this.view.engine.getDeltaTime() / 1000);
    }
    if (!this.carsShowLights) return;
    let lit = 0;
    for (const car of this.world.cars.values()) {
      if (lit >= MAX_CARS) break;
      if (car.phase === 'parked' || !this.view.carIsVisible(car)) continue;
      const turn = Math.atan2(car.heading.x, car.heading.z);
      const c = Math.cos(turn);
      const s = Math.sin(turn);
      const y = this.view.carFloor(car) + LIGHT_HEIGHT;
      const place = (buffer: Float32Array, index: number, along: number, side: number, height: number) => {
        // A rotation about Y, then a translation, written out because this runs for every car, every frame.
        const at = index * MATRIX_SIZE;
        buffer[at] = c;
        buffer[at + 2] = -s;
        buffer[at + 5] = 1;
        buffer[at + 8] = s;
        buffer[at + 10] = c;
        buffer[at + 12] = car.pos.x + s * along + c * side;
        buffer[at + 13] = height;
        buffer[at + 14] = car.pos.z + c * along - s * side;
        buffer[at + 15] = 1;
      };
      place(this.headMatrices, lit * 2, NOSE, -LIGHT_SPREAD, y);
      place(this.headMatrices, lit * 2 + 1, NOSE, LIGHT_SPREAD, y);
      place(this.tailMatrices, lit * 2, -TAIL, -LIGHT_SPREAD, y + 0.08);
      place(this.tailMatrices, lit * 2 + 1, -TAIL, LIGHT_SPREAD, y + 0.08);
      place(this.beamMatrices, lit, NOSE + BEAM_REACH, 0, this.view.carFloor(car) + BEAM_HEIGHT);
      lit++;
    }
    this.head.thinInstanceCount = lit * 2;
    this.tail.thinInstanceCount = lit * 2;
    this.beam.thinInstanceCount = lit;
    this.head.thinInstanceBufferUpdated('matrix');
    this.tail.thinInstanceBufferUpdated('matrix');
    this.beam.thinInstanceBufferUpdated('matrix');
  }
}
