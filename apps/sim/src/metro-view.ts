// Plays back a precomputed metro study on two synchronized maps. WebGL, because a metro area has a
// couple of hundred thousand road segments and a canvas 2D path would crawl.
// Nothing here simulates: every frame was computed offline by apps/metro and stored as data.

interface Summary {
  city: string;
  drivers: number;
  simulatedCars: number;
  sampleRate: number;
  startHour: number;
  frameMinutes: number;
  frames: number;
  nodes: number;
  edges: number;
  note: string;
  runs: RunSummary[];
}

interface RunSummary {
  id: string;
  label: string;
  tesShare: number;
  meanMinutes: number;
  rushMeanMinutes: number;
  vehicleHours: number;
  delayHours: number;
  vehicleKm: number;
  fuelLitres: number;
  cruisingHours: number;
  finishedShare: number;
  perFrame: { moving: number; arrived: number; kph: number }[];
}

const $ = (id: string) => document.getElementById(id)!;
const BASE = `${import.meta.env.BASE_URL}metro/`;
const COLORS: [number, number, number][] = [
  [0.27, 0.33, 0.38],
  [0.12, 0.7, 0.42],
  [0.95, 0.73, 0.06],
  [0.93, 0.36, 0.13],
  [0.86, 0.14, 0.17],
  // Parked cars at the curb, then lots, then garages.
  [0.55, 0.62, 0.72],
  [0.25, 0.55, 0.95],
  [0.72, 0.45, 0.95],
];
/** Share of the morning played per second, at speed 1. */
const PLAYBACK_RATE = 0.0012;
const CURB_DOT_METERS = 160;
const CURB_OFFSET_METERS = 28;
/** Levels of crowding, as a share of what the road can hold. */
const THRESHOLDS = [0.04, 0.22, 0.48, 0.75];

const VERTEX = `
attribute vec2 position;
attribute float tone;
uniform vec3 view;
uniform vec2 aspect;
uniform float size;
varying float vTone;
void main() {
  vec2 p = (position - view.xy) * view.z * aspect;
  gl_Position = vec4(p, 0.0, 1.0);
  gl_PointSize = size;
  vTone = tone;
}`;
const FRAGMENT = `
precision mediump float;
varying float vTone;
uniform vec3 colors[8];
uniform float alpha;
void main() {
  gl_FragColor = vec4(colors[int(vTone + 0.5)], alpha);
}`;

class MapLayer {
  readonly gl: WebGLRenderingContext;
  private readonly program: WebGLProgram;
  private readonly roadBuffer: WebGLBuffer;
  private readonly toneBuffer: WebGLBuffer;
  private readonly dotBuffer: WebGLBuffer;
  private readonly dotTone: WebGLBuffer;
  private readonly index: WebGLBuffer;
  private readonly indexCount: number;

  constructor(
    readonly canvas: HTMLCanvasElement,
    positions: Float32Array,
    edgeNodes: Uint32Array,
  ) {
    const gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: true })!;
    this.gl = gl;
    gl.getExtension('OES_element_index_uint');
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    gl.useProgram(program);
    this.program = program;
    // Each road gets its own two vertices, so it can have its own color.
    const vertices = new Float32Array((edgeNodes.length / 2) * 4);
    for (let e = 0; e < edgeNodes.length / 2; e++) {
      vertices.set(positions.subarray(edgeNodes[e * 2] * 2, edgeNodes[e * 2] * 2 + 2), e * 4);
      vertices.set(positions.subarray(edgeNodes[e * 2 + 1] * 2, edgeNodes[e * 2 + 1] * 2 + 2), e * 4 + 2);
    }
    this.roadBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.roadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    this.toneBuffer = gl.createBuffer()!;
    this.dotBuffer = gl.createBuffer()!;
    this.dotTone = gl.createBuffer()!;
    this.index = gl.createBuffer()!;
    this.indexCount = edgeNodes.length;
    const indices = new Uint32Array(this.indexCount);
    for (let i = 0; i < indices.length; i++) indices[i] = i;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform3fv(gl.getUniformLocation(program, 'colors'), COLORS.flat());
  }

  private attach(buffer: WebGLBuffer, name: string, size: number) {
    const { gl, program } = this;
    const location = gl.getAttribLocation(program, name);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
  }

  private parkedBuffer: WebGLBuffer | null = null;
  private parkedTone: WebGLBuffer | null = null;
  private parkedCount = 0;

  /** Parked cars and lots don't move, so they are uploaded once. */
  setParked(points: Float32Array, tones: Float32Array) {
    const { gl } = this;
    this.parkedBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.parkedBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, points, gl.STATIC_DRAW);
    this.parkedTone = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.parkedTone);
    gl.bufferData(gl.ARRAY_BUFFER, tones, gl.STATIC_DRAW);
    this.parkedCount = tones.length;
  }

  private drawParked(ratio: number, zoom: number) {
    if (!this.parkedBuffer || !this.parkedTone) return;
    const { gl, program } = this;
    this.attach(this.parkedBuffer, 'position', 2);
    this.attach(this.parkedTone, 'tone', 1);
    gl.uniform1f(gl.getUniformLocation(program, 'size'), Math.max(1.5, Math.min(4, zoom * 16000)) * ratio);
    gl.uniform1f(gl.getUniformLocation(program, 'alpha'), 0.75);
    gl.drawArrays(gl.POINTS, 0, this.parkedCount);
  }

  draw(view: { x: number; y: number; zoom: number }, tones: Float32Array, dots: Float32Array | null, dotTones: Float32Array | null, dotCount: number, parked: boolean) {
    const { gl, canvas, program } = this;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(canvas.clientWidth * ratio);
    const height = Math.round(canvas.clientHeight * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0.08, 0.09, 0.11, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform3f(gl.getUniformLocation(program, 'view'), view.x, view.y, view.zoom);
    gl.uniform2f(gl.getUniformLocation(program, 'aspect'), height / width, 1);
    gl.uniform1f(gl.getUniformLocation(program, 'alpha'), 1);
    gl.uniform1f(gl.getUniformLocation(program, 'size'), 1);
    this.attach(this.roadBuffer, 'position', 2);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.toneBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, tones, gl.DYNAMIC_DRAW);
    this.attach(this.toneBuffer, 'tone', 1);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.index);
    gl.drawElements(gl.LINES, this.indexCount, gl.UNSIGNED_INT, 0);
    if (parked) this.drawParked(ratio, view.zoom);
    if (dots && dotTones && dotCount > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.dotBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, dots.subarray(0, dotCount * 2), gl.DYNAMIC_DRAW);
      this.attach(this.dotBuffer, 'position', 2);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.dotTone);
      gl.bufferData(gl.ARRAY_BUFFER, dotTones.subarray(0, dotCount), gl.DYNAMIC_DRAW);
      this.attach(this.dotTone, 'tone', 1);
      gl.uniform1f(gl.getUniformLocation(program, 'size'), Math.max(1.6, Math.min(5, view.zoom * 18000)) * ratio);
      gl.uniform1f(gl.getUniformLocation(program, 'alpha'), 0.9);
      gl.drawArrays(gl.POINTS, 0, dotCount);
    }
  }
}

function formatHours(startHour: number, minutes: number) {
  const total = startHour * 60 + minutes;
  const h24 = Math.floor(total / 60) % 24;
  const h = h24 % 12 || 12;
  return `${h}:${String(Math.floor(total % 60)).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
}

const big = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(Math.round(n)));

async function fetchBinary(name: string) {
  const res = await fetch(`${BASE}${name}`);
  if (!res.ok) throw new Error(`Could not load ${name}`);
  return res.arrayBuffer();
}

async function main() {
  const summaryRes = await fetch(`${BASE}la-summary.json`);
  if (!summaryRes.ok) throw new Error('The study data is missing. Run apps/metro/scripts/study.ts first.');
  const summary = (await summaryRes.json()) as Summary;
  const raw = await fetchBinary('la-network.bin');
  const header = new Uint32Array(raw, 0, 2);
  const [nodeCount, edgeCount] = [header[0], header[1]];
  const packed = new Int16Array(raw, 8, nodeCount * 2);
  const positions = new Float32Array(nodeCount * 2);
  for (let i = 0; i < positions.length; i++) positions[i] = packed[i] * 4;
  const edgeOffset = 8 + nodeCount * 4;
  const aligned = edgeOffset + ((4 - (edgeOffset % 4)) % 4);
  const edgeNodes = new Uint32Array(raw, aligned, edgeCount * 2);
  const storage = new Uint16Array(raw, aligned + edgeCount * 8, edgeCount);
  const classes = new Uint8Array(raw, aligned + edgeCount * 10, edgeCount);
  $('scale').textContent = `${summary.city}: ${big(summary.edges)} road segments and ${big(summary.drivers)} commuters, each dot about ${Math.round(1 / summary.sampleRate)} cars`;
  $('note').textContent = summary.note;

  const left = new MapLayer($('left') as HTMLCanvasElement, positions, edgeNodes);
  const right = new MapLayer($('right') as HTMLCanvasElement, positions, edgeNodes);
  const view = { x: 0, y: 0, zoom: 1 / 42000 };

  // Placeholders for parked cars: dots down the side of each street, then the real lots and garages.
  const lots = new Int16Array(await fetchBinary('la-parking.bin'));
  const curb: number[] = [];
  for (let e = 0; e < edgeCount; e += 2) {
    if (classes[e] < 2) continue;
    const a = edgeNodes[e * 2] * 2;
    const b = edgeNodes[e * 2 + 1] * 2;
    const dx = positions[b] - positions[a];
    const dy = positions[b + 1] - positions[a + 1];
    const length = Math.hypot(dx, dy);
    const count = Math.floor(length / CURB_DOT_METERS);
    for (let k = 1; k <= count; k++) {
      const t = k / (count + 1);
      curb.push(positions[a] + dx * t + (dy / length) * CURB_OFFSET_METERS, positions[a + 1] + dy * t - (dx / length) * CURB_OFFSET_METERS);
    }
  }
  const parkedCount = curb.length / 2 + lots.length / 3;
  const parkedPoints = new Float32Array(parkedCount * 2);
  const parkedTones = new Float32Array(parkedCount).fill(5);
  parkedPoints.set(curb);
  for (let i = 0; i < lots.length / 3; i++) {
    const at = curb.length + i * 2;
    parkedPoints[at] = lots[i * 3] * 4;
    parkedPoints[at + 1] = lots[i * 3 + 1] * 4;
    parkedTones[curb.length / 2 + i] = lots[i * 3 + 2] ? 7 : 6;
  }
  left.setParked(parkedPoints, parkedTones);
  right.setParked(parkedPoints, parkedTones);
  const frames = new Map<string, Uint8Array>();
  const load = async (run: RunSummary) => {
    if (!frames.has(run.id)) frames.set(run.id, new Uint8Array(await fetchBinary(`la-run-${run.id}.bin`)));
    return frames.get(run.id)!;
  };

  const baseline = summary.runs.find((r) => r.tesShare === 0)!;
  const options = summary.runs.filter((r) => r.tesShare > 0);
  const select = $('adoption') as HTMLSelectElement;
  for (const run of options) {
    const option = document.createElement('option');
    option.value = run.id;
    option.textContent = run.label;
    select.append(option);
  }
  select.value = options[options.length - 1].id;
  let active = options[options.length - 1];
  await load(baseline);
  await load(active);
  $('left-name').textContent = baseline.label;

  function showSummary() {
    $('right-name').textContent = active.label;
    const hours = baseline.vehicleHours - active.vehicleHours;
    const items: [string, string][] = [
      [`${baseline.rushMeanMinutes.toFixed(0)} to ${active.rushMeanMinutes.toFixed(0)} min`, 'Average rush-hour trip'],
      [big(hours), 'Vehicle-hours saved this morning'],
      [`${big(baseline.fuelLitres - active.fuelLitres)} L`, 'Fuel saved, estimated'],
      [`${big(baseline.delayHours)} to ${big(active.delayHours)}`, 'Hours of delay'],
    ];
    $('summary').replaceChildren(
      ...items.map(([value, label]) => {
        const box = document.createElement('div');
        const b = document.createElement('b');
        b.textContent = value;
        const span = document.createElement('span');
        span.textContent = label;
        box.append(b, span);
        return box;
      }),
    );
  }
  showSummary();
  select.addEventListener('change', async () => {
    active = options.find((r) => r.id === select.value)!;
    await load(active);
    showSummary();
  });

  const MAX_DOTS = 160000;
  const makeDots = () => ({ positions: new Float32Array(MAX_DOTS * 2), tones: new Float32Array(MAX_DOTS) });
  const dotSets = [makeDots(), makeDots()];
  const roadTones = [new Float32Array(edgeCount * 2), new Float32Array(edgeCount * 2)];
  const toneOf = (share: number) => (share < THRESHOLDS[0] ? 0 : share < THRESHOLDS[1] ? 1 : share < THRESHOLDS[2] ? 2 : share < THRESHOLDS[3] ? 3 : 4);

  let time = 0;
  let playing = true;
  let last = performance.now();
  const timeInput = $('time') as HTMLInputElement;
  const speedInput = $('speed') as HTMLInputElement;
  const showDots = $('dots') as HTMLInputElement;
  const showParked = $('parked') as HTMLInputElement;

  function fill(data: Uint8Array, frame: number, setIndex: number, clock: number) {
    const tones = roadTones[setIndex];
    const dots = dotSets[setIndex];
    const offset = frame * edgeCount;
    let count = 0;
    for (let e = 0; e < edgeCount; e++) {
      const share = data[offset + e] / 255;
      const tone = toneOf(share);
      tones[e * 2] = tone;
      tones[e * 2 + 1] = tone;
      if (!showDots.checked || share === 0) continue;
      // Dots stand for cars on this road. They move slower where it's crowded.
      const cars = Math.min(40, Math.round((share * storage[e] * summary.sampleRate) + 0.35));
      const a = edgeNodes[e * 2] * 2;
      const b = edgeNodes[e * 2 + 1] * 2;
      for (let k = 0; k < cars && count < MAX_DOTS; k++) {
        const pace = 1 - Math.min(0.92, share);
        const t = (k / cars + clock * pace * 0.45 + (e % 17) / 17) % 1;
        dots.positions[count * 2] = positions[a] + (positions[b] - positions[a]) * t;
        dots.positions[count * 2 + 1] = positions[a + 1] + (positions[b + 1] - positions[a + 1]) * t;
        dots.tones[count] = tone;
        count++;
      }
    }
    return count;
  }

  function stats(id: string, run: RunSummary, frame: number) {
    const f = run.perFrame[Math.min(frame, run.perFrame.length - 1)];
    const rows: [string, string][] = [
      ['On the road', big(f.moving / summary.sampleRate)],
      ['Arrived', big(f.arrived / summary.sampleRate)],
    ];
    $(id).replaceChildren(
      ...rows.flatMap(([k, v]) => {
        const dt = document.createElement('dt');
        dt.textContent = k;
        const dd = document.createElement('dd');
        dd.textContent = v;
        return [dt, dd];
      }),
    );
  }

  function render(now: number) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (playing) {
      time += dt * Number(speedInput.value) * PLAYBACK_RATE;
      if (time > 1) time = 0;
      timeInput.value = String(Math.round(time * 1000));
    }
    const frame = Math.min(summary.frames - 1, Math.floor(time * summary.frames));
    const leftData = frames.get(baseline.id);
    const rightData = frames.get(active.id);
    if (leftData && rightData) {
      const clock = now / 1000;
      const a = fill(leftData, frame, 0, clock);
      const b = fill(rightData, frame, 1, clock);
      left.draw(view, roadTones[0], dotSets[0].positions, dotSets[0].tones, a, showParked.checked);
      right.draw(view, roadTones[1], dotSets[1].positions, dotSets[1].tones, b, showParked.checked);
      stats('left-stats', baseline, frame);
      stats('right-stats', active, frame);
    }
    $('clock').textContent = formatHours(summary.startHour, time * summary.frames * summary.frameMinutes);
    requestAnimationFrame(render);
  }

  $('play').addEventListener('click', () => {
    playing = !playing;
    $('play').textContent = playing ? 'Pause' : 'Play';
    $('play').setAttribute('aria-pressed', String(playing));
  });
  timeInput.addEventListener('input', () => {
    time = Number(timeInput.value) / 1000;
  });

  // Dragging and zooming move both maps together, so the same place is always compared.
  for (const canvas of [left.canvas, right.canvas]) {
    let dragging: { x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      dragging = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const scale = 2 / (canvas.clientHeight * view.zoom);
      view.x -= (e.clientX - dragging.x) * scale;
      view.y += (e.clientY - dragging.y) * scale;
      dragging = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('pointerup', () => (dragging = null));
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        view.zoom = Math.min(1 / 500, Math.max(1 / 80000, view.zoom * Math.exp(-e.deltaY * 0.0012)));
      },
      { passive: false },
    );
  }
  Object.assign(window, { metro: { view, setTime: (t: number) => (time = t), setPlaying: (p: boolean) => (playing = p), summary } });
  requestAnimationFrame(render);
}

main().catch((err) => {
  $('scale').textContent = (err as Error).message;
});
