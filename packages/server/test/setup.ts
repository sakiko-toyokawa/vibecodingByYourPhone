import { registerAllProviders } from "../src/providers/index.js";

// Ensure provider descriptors are registered before any test runs.
// The registry is a global singleton; registerAllProviders is idempotent.
registerAllProviders();
