import type { TimerInterface, VisibilityInterface } from "../ConnectionManager";

/**
 * Mock timers for deterministic testing of ConnectionManager.
 * Tracks all scheduled timers and allows advancing time manually.
 */
export class MockTimers implements TimerInterface {
  private _now = 0;
  private _nextId = 1;
  private _timeouts = new Map<
    number,
    { fn: () => void; fireAt: number; interval?: number }
  >();

  now(): number {
    return this._now;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this._nextId++;
    this._timeouts.set(id, { fn, fireAt: this._now + ms });
    return id;
  }

  clearTimeout(id: number): void {
    this._timeouts.delete(id);
  }

  setInterval(fn: () => void, ms: number): number {
    const id = this._nextId++;
    this._timeouts.set(id, { fn, fireAt: this._now + ms, interval: ms });
    return id;
  }

  clearInterval(id: number): void {
    this._timeouts.delete(id);
  }

  /**
   * Advance time by `ms` milliseconds, firing all timers that are due.
   * Timers are fired in chronological order.
   */
  advance(ms: number): void {
    const target = this._now + ms;
    while (this._now < target) {
      // Find the next timer to fire
      let nextFireAt = target;
      for (const entry of this._timeouts.values()) {
        if (entry.fireAt <= target && entry.fireAt < nextFireAt) {
          nextFireAt = entry.fireAt;
        }
      }
      // If no timer fires before target, just jump to target
      if (nextFireAt > this._now) {
        this._now = Math.min(nextFireAt, target);
      }
      // Fire all timers due at this time
      const toFire: Array<{ id: number; fn: () => void; interval?: number }> =
        [];
      for (const [id, entry] of this._timeouts) {
        if (entry.fireAt <= this._now) {
          toFire.push({ id, fn: entry.fn, interval: entry.interval });
        }
      }
      for (const { id, fn, interval } of toFire) {
        if (interval !== undefined) {
          // Reschedule interval
          const entry = this._timeouts.get(id);
          if (entry) {
            entry.fireAt = this._now + interval;
          }
        } else {
          this._timeouts.delete(id);
        }
        fn();
      }
      // If nothing fired and we haven't reached target, break
      if (toFire.length === 0) {
        this._now = target;
        break;
      }
    }
  }

  /**
   * Get count of pending timers (useful for assertions).
   */
  get pendingCount(): number {
    return this._timeouts.size;
  }
}

/**
 * Mock visibility for testing ConnectionManager's page visibility behavior.
 */
export class MockVisibility implements VisibilityInterface {
  private _visible = true;
  private _listeners = new Set<(visible: boolean) => void>();

  isVisible(): boolean {
    return this._visible;
  }

  onVisibilityChange(cb: (visible: boolean) => void): () => void {
    this._listeners.add(cb);
    return () => {
      this._listeners.delete(cb);
    };
  }

  /** Simulate page going to background */
  hide(): void {
    this._visible = false;
    for (const cb of this._listeners) {
      cb(false);
    }
  }

  /** Simulate page coming back to foreground */
  show(): void {
    this._visible = true;
    for (const cb of this._listeners) {
      cb(true);
    }
  }
}

/**
 * Helper to create a ConnectionManager with mock timers and visibility
 * for deterministic testing.
 */
export function createTestDeps() {
  const timers = new MockTimers();
  const visibility = new MockVisibility();
  return { timers, visibility };
}
