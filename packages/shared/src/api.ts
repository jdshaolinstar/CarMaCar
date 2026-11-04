// The wire contract between the sim and the platform.
// Deliberately has no field for occupancy going to the platform: FrameUpload is pixels and pose only.
import type { CameraPose } from './camera';
import type { Vec2 } from './city';
import type { DirectedEdge } from './route';
import type { SignalAxis, VehicleReport } from './tes';

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
  /** Trash found on this frame, as boxes. */
  trash?: [number, number, number, number][];
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
  /** Street id to how many times longer it takes than in free-flowing traffic. */
  traffic: Record<string, number>;
  /** Vehicles cameras counted on streets, which GPS alone would miss. */
  cameraTrafficCounts: number;
  /** Streets an operator goal is steering cars away from. */
  avoidedStreets: string[];
  /** Trash cameras have seen and no camera has yet seen gone. */
  trashPins: { id: string; x: number; z: number; category: string }[];
  /** The latest trash scan, in words, for the dashboard. */
  trashNote: string | null;
}

export interface FindParkingRequest {
  destinationId: string;
  carId: string;
  from: Vec2;
  /** The street the car is on. Lets the Traffic Efficiency System weigh the drive to each stall. */
  edge?: DirectedEdge;
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

export interface TelemetryUpload {
  vehicles: VehicleReport[];
}

export interface TelemetryReply {
  /** What smart lights should favor, when they are on. */
  signals: Record<string, SignalAxis>;
}

export interface RouteRequest {
  carId: string;
  from: DirectedEdge;
  goal: DirectedEdge;
}

export interface RouteReply {
  chain: DirectedEdge[] | null;
}

export type ParkingVision = 'sam' | 'spark';
export type TrashVision = 'spark' | 'sam' | 'sam+spark';

export interface TesSettings {
  enabled: boolean;
  smartLights: boolean;
  parkingVision: ParkingVision;
  trashVision: TrashVision;
  /** Muse Spark reviews the whole city on a regular cycle and steers TES. */
  strategist: boolean;
}

export interface OperatorRequest {
  text: string;
}
