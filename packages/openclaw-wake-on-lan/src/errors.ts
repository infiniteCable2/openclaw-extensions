export class WakeOnLanError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WakeOnLanError";
  }
}
