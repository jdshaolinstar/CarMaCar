// A vision provider finds vehicles in a frame. Stall logic never depends on which model ran.
// SAM 3.1 is the per-frame path; see .docs-private/PLAN.md for why Spark is not.

export interface VehicleMask {
  objectId: string;
  box: [number, number, number, number];
  /** Row-major 0/1 raster, cropped to the box. */
  raster: Uint8Array;
  width: number;
  height: number;
  svgPath: string;
}

export interface VisionProvider {
  readonly model: string;
  findVehicles(jpeg: Buffer): Promise<VehicleMask[]>;
}
