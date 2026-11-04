// The wire contract between the sim and the platform.
// Deliberately has no field for occupancy going to the platform: FrameUpload is pixels and pose only.
import type { CameraPose } from './camera';
import type { Vec2 } from './city';

export interface FrameUpload {
  scoutId: string;
  /** JPEG as base64. */
  jpeg: string;
  pose: CameraPose;
  capturedAt: number;
}

export type StallState = 'occupied' | 'free' | 'unknown';

export interface TwinStall {
  state: StallState;
  /** 0 to 1, how strongly recent evidence agrees. */
  confidence: number;
  updatedAt: number | null;
  reservedBy: string | null;
}

export interface FrameDetection {
  objectId: string;
  box: [number, number, number, number];
  /** SVG path in mask pixels. Scale by box size / mask size to overlay. */
  maskPath: string;
  maskWidth: number;
  maskHeight: number;
  stallId: string | null;
}

export interface FrameReport {
  frameId: string;
  scoutId: string;
  capturedAt: number;
  latencyMs: number;
  model: string;
  detections: FrameDetection[];
  stalls: { id: string; state: StallState }[];
}

export interface AgentEvent {
  at: number;
  tripId: string;
  kind: 'request' | 'thinking' | 'tool_call' | 'tool_result' | 'reply' | 'error';
  name?: string;
  detail: string;
}

export interface TripLeg {
  destinationId: string;
  destinationName: string;
  stallId: string | null;
  stayMinutes: number | null;
  arriveBy: string | null;
}

export interface TripPlan {
  tripId: string;
  carId: string;
  reply: string;
  legs: TripLeg[];
  status: 'planning' | 'ready' | 'failed';
}

export interface TwinSnapshot {
  now: number;
  stalls: Record<string, TwinStall>;
  frames: FrameReport[];
  agentEvents: AgentEvent[];
  trips: TripPlan[];
  karma: Record<string, number>;
  usage: { frames: number; frameLimit: number; budgetExhausted: boolean };
}

export interface FindParkingRequest {
  destinationId: string;
  carId: string;
  from: Vec2;
  exclude?: string[];
}

export interface FindParkingResponse {
  stallId: string | null;
  walkMeters: number | null;
}

export interface TripRequest {
  carId: string;
  text: string;
  position: Vec2;
}
