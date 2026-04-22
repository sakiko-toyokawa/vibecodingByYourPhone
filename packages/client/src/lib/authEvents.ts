/**
 * Global auth event bus for signaling authentication state changes.
 *
 * This allows any part of the app (API calls, SSE connections, etc.) to
 * signal that login is required, which AuthContext can listen to and
 * redirect to the login page.
 *
 * This is needed because:
 * 1. Multiple components may be making API calls that could fail with 401
 * 2. SSE connections need to stop reconnecting when auth fails
 * 3. We need a central place to coordinate auth state across the app
 */

type AuthEventListener = () => void;

class AuthEventBus {
  private listeners = new Set<AuthEventListener>();
  private _loginRequired = false;

  /**
   * Whether login is currently required.
   * This is set when a 401 is detected and cleared when auth succeeds.
   */
  get loginRequired(): boolean {
    return this._loginRequired;
  }

  /**
   * Signal that login is required (e.g., after receiving a 401).
   * This will notify all listeners and prevent further connections from polling.
   */
  signalLoginRequired(): void {
    if (this._loginRequired) return; // Already signaled
    this._loginRequired = true;
    console.log("[AuthEvents] Login required signaled");
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error("[AuthEvents] Listener error:", err);
      }
    }
  }

  /**
   * Clear the login required state (e.g., after successful login).
   */
  clearLoginRequired(): void {
    if (!this._loginRequired) return;
    this._loginRequired = false;
    console.log("[AuthEvents] Login required cleared");
  }

  /**
   * Subscribe to login required events.
   * Returns an unsubscribe function.
   */
  onLoginRequired(callback: AuthEventListener): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }
}

export const authEvents = new AuthEventBus();
