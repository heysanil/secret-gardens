/** Thrown by parseGardensConfig when .gardens.json is malformed or invalid. */
export class GardensConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GardensConfigError";
  }
}
