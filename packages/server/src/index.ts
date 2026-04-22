import { startServer } from "./server.js";
import { initializeServices } from "./services-init.js";
import {
  registerShutdownHandlers,
  registerUnhandledRejectionHandler,
} from "./shutdown.js";

// Allow many concurrent Claude sessions without listener warnings.
// Each SDK session registers an exit handler; default limit is 10.
process.setMaxListeners(50);

registerUnhandledRejectionHandler();
registerShutdownHandlers();

const services = await initializeServices();
await startServer(services).catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
