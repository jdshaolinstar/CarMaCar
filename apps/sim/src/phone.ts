// The driver's phone app. Shows the same live data a real CarMaCar app would get.
import { distance, type CityMap, type TwinSnapshot, type Vec2 } from '@carmacar/shared';
import { navigate } from './nav';
import type { Car, World } from './world';

const VIEW_METRES = 170;
const ARROWS: Record<string, string> = { straight: '↑', left: '←', right: '→', arrive: '⚑', park: 'P' };

/** Lets people drag a floating panel by its handle, and keeps at least part of it on screen. */
export function makeDraggable(panel: HTMLElement, handle: HTMLElement) {
  const KEEP_VISIBLE = 48;
  let grab: { x: number; y: number } | null = null;
  handle.addEventListener('pointerdown', (e) => {
    const box = panel.getBoundingClientRect();
    grab = { x: e.clientX - box.left, y: e.clientY - box.top };
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!grab) return;
    const box = panel.getBoundingClientRect();
    const left = Math.min(window.innerWidth - KEEP_VISIBLE, Math.max(KEEP_VISIBLE - box.width, e.clientX - grab.x));
    const top = Math.min(window.innerHeight - KEEP_VISIBLE, Math.max(0, e.clientY - grab.y));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  });
  const release = () => (grab = null);
  handle.addEventListener('pointerup', release);
  handle.addEventListener('pointercancel', release);
}

export class PhoneApp {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly city: CityMap,
    private readonly world: World,
  ) {
    this.ctx = canvas.getContext('2d')!;
  }

  /** Fills the destination buttons. Each one sends a real request to the trip agent. */
  renderDestinations(root: HTMLElement, onPick: (name: string) => void) {
    root.replaceChildren();
    for (const d of this.city.destinations.slice(0, 5)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = d.name;
      button.addEventListener('click', () => onPick(d.name));
      root.append(button);
    }
  }

  update(car: Car | undefined, twin: TwinSnapshot | null) {
    const set = (id: string, text: string) => {
      document.getElementById(id)!.textContent = text;
    };
    if (!car) {
      set('phone-where', 'Pick a car to see its app');
      this.clear();
      return;
    }
    const step = navigate(this.world, car);
    const destination = this.city.destinations.find((d) => d.id === car.destinationId);
    const stall = car.targetStallId ? this.world.stalls.get(car.targetStallId) : null;
    const garage = stall?.garageId ? this.city.garages.find((g) => g.id === stall.garageId) : null;

    set('phone-where', destination ? `To ${destination.name}` : 'Where to?');
    set('phone-icon', step ? ARROWS[step.icon] : '');
    set('phone-turn', step ? `${step.distance}  ${step.instruction}` : 'No trip yet. Pick a place below.');
    set('phone-stall', stall ? `${stall.id}${garage ? `, ${garage.name} level ${(stall.level ?? 0) + 1}` : ', street parking'}` : 'Not reserved yet');
    set('phone-walk', stall && destination ? `${Math.round(distance(stall.center, destination))} m walk` : '');
    set('phone-karma', String(Object.values(twin?.karma ?? {}).reduce((sum, k) => sum + k, 0)));

    const target = destination ?? car.pos;
    const open = this.city.stalls.filter((s) => twin?.stalls[s.id]?.state === 'free' && distance(s.center, target) < 100).length;
    set('phone-spots', String(open));

    this.draw(car, twin, step?.path.points ?? null);
  }

  private clear() {
    this.ctx.fillStyle = '#EEF0EC';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private draw(car: Car, twin: TwinSnapshot | null, route: Vec2[] | null) {
    const { ctx, canvas, city } = this;
    const scale = canvas.width / VIEW_METRES;
    const cx = canvas.width / 2;
    const cy = canvas.height * 0.62;
    // Heading-up, like driving directions: the car always points up the screen.
    const angle = Math.atan2(car.heading.x, car.heading.z);
    const toScreen = (p: Vec2): [number, number] => {
      const dx = p.x - car.pos.x;
      const dz = p.z - car.pos.z;
      const rx = dx * Math.cos(angle) - dz * Math.sin(angle);
      const rz = dx * Math.sin(angle) + dz * Math.cos(angle);
      return [cx + rx * scale, cy - rz * scale];
    };

    this.clear();
    const nodes = new Map(city.nodes.map((n) => [n.id, n]));
    ctx.lineCap = 'round';
    ctx.lineWidth = 26;
    ctx.strokeStyle = '#FFFFFF';
    for (const seg of city.segments) {
      ctx.beginPath();
      ctx.moveTo(...toScreen(nodes.get(seg.a)!));
      ctx.lineTo(...toScreen(nodes.get(seg.b)!));
      ctx.stroke();
    }
    for (const seg of city.segments) {
      const level = twin?.traffic?.[seg.id] ?? 1;
      if (level < 2) continue;
      ctx.strokeStyle = level >= 3 ? '#D8392B' : '#F2B90F';
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(...toScreen(nodes.get(seg.a)!));
      ctx.lineTo(...toScreen(nodes.get(seg.b)!));
      ctx.stroke();
    }
    if (route && route.length > 1) {
      ctx.strokeStyle = '#0B4EA2';
      ctx.lineWidth = 9;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      route.forEach((p, i) => (i === 0 ? ctx.moveTo(...toScreen(p)) : ctx.lineTo(...toScreen(p))));
      ctx.stroke();
    }
    for (const stall of city.stalls) {
      if (stall.garageId || twin?.stalls[stall.id]?.state !== 'free') continue;
      const [x, y] = toScreen(stall.center);
      if (x < 0 || y < 0 || x > canvas.width || y > canvas.height) continue;
      ctx.fillStyle = '#1FA35C';
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.textAlign = 'center';
    ctx.font = '600 20px Overpass, Arial, sans-serif';
    ctx.fillStyle = '#2C3135';
    for (const place of [...city.destinations, ...city.garages]) {
      const [x, y] = toScreen(place);
      if (x > 0 && y > 0 && x < canvas.width && y < canvas.height) ctx.fillText(place.name, x, y);
    }
    ctx.fillStyle = '#FF8A1F';
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 20);
    ctx.lineTo(cx + 15, cy + 16);
    ctx.lineTo(cx, cy + 8);
    ctx.lineTo(cx - 15, cy + 16);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}
