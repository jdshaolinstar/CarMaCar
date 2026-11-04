// City sound, synthesized as it plays. No recordings, so there is nothing to license. Browsers only allow
// audio after a click, which is why this starts from a dashboard switch and stays off by default.
import type { World } from './world';

const NOISE_SECONDS = 3;
/** How quickly sound follows the city, in seconds. */
const SMOOTHING = 0.6;
const MAX_ROAD_GAIN = 0.16;
const RAIN_GAIN = 0.1;
const ENGINE_GAIN = 0.05;
/** Moving cars at which road noise reaches its peak. */
const BUSY_CARS = 60;

export class CitySound {
  private context: AudioContext | null = null;
  private road!: GainNode;
  private rain!: GainNode;
  private engine!: GainNode;
  private engineLow!: OscillatorNode;
  private engineHigh!: OscillatorNode;
  private timer = 0;
  private raining = false;

  constructor(
    private readonly world: World,
    /** The car being followed, for its engine note. */
    private readonly followed: () => { speed: number } | null,
  ) {}

  setEnabled(on: boolean) {
    if (on && !this.context) this.build();
    if (on) {
      void this.context?.resume();
      this.timer = window.setInterval(() => this.update(), 250);
    } else {
      window.clearInterval(this.timer);
      void this.context?.suspend();
    }
  }

  setRaining(on: boolean) {
    this.raining = on;
  }

  private noise(context: AudioContext) {
    const buffer = context.createBuffer(1, context.sampleRate * NOISE_SECONDS, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.start();
    return source;
  }

  private build() {
    const context = new AudioContext();
    this.context = context;
    const filtered = (type: BiquadFilterType, frequency: number) => {
      const filter = context.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = frequency;
      const gain = context.createGain();
      gain.gain.value = 0;
      this.noise(context).connect(filter).connect(gain).connect(context.destination);
      return gain;
    };
    this.road = filtered('lowpass', 320);
    this.rain = filtered('bandpass', 3200);

    this.engine = context.createGain();
    this.engine.gain.value = 0;
    const lowpass = context.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 500;
    lowpass.connect(this.engine).connect(context.destination);
    const oscillator = (detune: number) => {
      const node = context.createOscillator();
      node.type = 'sawtooth';
      node.frequency.value = 50;
      node.detune.value = detune;
      node.connect(lowpass);
      node.start();
      return node;
    };
    this.engineLow = oscillator(0);
    this.engineHigh = oscillator(8);
  }

  private update() {
    const context = this.context;
    if (!context) return;
    const now = context.currentTime;
    let moving = 0;
    for (const car of this.world.cars.values()) if (car.speed > 0.5) moving++;
    this.road.gain.setTargetAtTime(Math.min(1, moving / BUSY_CARS) * MAX_ROAD_GAIN, now, SMOOTHING);
    this.rain.gain.setTargetAtTime(this.raining ? RAIN_GAIN : 0, now, SMOOTHING);
    const car = this.followed();
    const pitch = 48 + (car?.speed ?? 0) * 7;
    this.engineLow.frequency.setTargetAtTime(pitch, now, 0.2);
    this.engineHigh.frequency.setTargetAtTime(pitch * 2, now, 0.2);
    this.engine.gain.setTargetAtTime(car ? ENGINE_GAIN : 0, now, 0.3);
  }
}
