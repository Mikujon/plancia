import { EventEmitter } from "node:events";

export type Change = { entity: "issue" | "staffing" | "chat" | "handover"; id?: string };

/** In-process change feed; the UI listens through /api/stream and refetches. */
export class Bus {
  private ee = new EventEmitter();
  constructor() {
    this.ee.setMaxListeners(500);
  }
  emit(c: Change) {
    this.ee.emit("change", c);
  }
  on(fn: (c: Change) => void) {
    this.ee.on("change", fn);
    return () => this.ee.off("change", fn);
  }
}
