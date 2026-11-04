// HTTP client for the platform. This is the sim's only way of talking to it.
import type { FindParkingResponse, FrameUpload, TripRequest, TwinSnapshot, Vec2 } from '@carmacar/shared';
import type { ParkingService } from './world';

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://127.0.0.1:8787';

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export class PlatformClient implements ParkingService {
  private constructor(readonly sessionId: string) {}

  static async connect(): Promise<PlatformClient> {
    const res = await fetch(`${API}/v1/sessions`, { method: 'POST' });
    if (!res.ok) throw new Error(`Platform refused a session (${res.status})`);
    const { sessionId } = await res.json();
    return new PlatformClient(sessionId);
  }

  private url(path: string) {
    return `${API}/v1/sessions/${this.sessionId}${path}`;
  }

  /** Pixels and pose only. Returns false if the platform declined the frame. */
  async sendFrame(frame: FrameUpload): Promise<boolean> {
    const res = await fetch(this.url('/frames'), json(frame));
    return res.ok;
  }

  async twin(): Promise<TwinSnapshot | null> {
    const res = await fetch(this.url('/twin'));
    return res.ok ? res.json() : null;
  }

  async find(carId: string, destinationId: string, from: Vec2, exclude: string[]): Promise<string | null> {
    const res = await fetch(this.url('/parking/find'), json({ carId, destinationId, from, exclude }));
    if (!res.ok) return null;
    const body = (await res.json()) as FindParkingResponse;
    return body.stallId;
  }

  release(carId: string) {
    void fetch(this.url('/parking/release'), json({ carId }));
  }

  arrived(carId: string) {
    void fetch(this.url('/parking/arrived'), json({ carId }));
  }

  async requestTrip(request: TripRequest): Promise<string | null> {
    const res = await fetch(this.url('/trips'), json(request));
    if (!res.ok) return null;
    return (await res.json()).tripId;
  }
}
