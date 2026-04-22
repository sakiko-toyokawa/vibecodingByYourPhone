/**
 * Mock provider types for testing.
 *
 * These types extend the base provider interface to support
 * scenario-based testing with configurable delays and messages.
 */

import type { SDKMessage } from "../../types.js";
import type { AgentProvider, AuthStatus } from "../types.js";

/**
 * A scenario defines a sequence of messages to emit.
 * Used to simulate provider behavior in tests.
 */
export interface MockScenario {
  /** Messages to emit in sequence */
  messages: SDKMessage[];
  /** Delay between messages in ms (default: 10) */
  delayMs?: number;
  /** Session ID to use (optional - some messages may include their own) */
  sessionId?: string;
}

/**
 * Configuration for mock providers.
 */
export interface MockProviderConfig {
  /** Pre-configured scenarios */
  scenarios?: MockScenario[];
  /** Whether the provider should report as installed */
  installed?: boolean;
  /** Whether the provider should report as authenticated */
  authenticated?: boolean;
  /** Custom auth status to return */
  authStatus?: AuthStatus;
}

/**
 * Extended provider interface for mocks.
 * Adds methods for configuring test scenarios.
 */
export interface MockAgentProvider extends AgentProvider {
  /** Add a scenario for the next session */
  addScenario(scenario: MockScenario): void;

  /** Set multiple scenarios */
  setScenarios(scenarios: MockScenario[]): void;

  /** Reset all scenarios and state */
  reset(): void;

  /** Get the current scenario index */
  get scenarioIndex(): number;

  /** Get total number of sessions started */
  get sessionCount(): number;
}
