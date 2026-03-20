import { startAgentServer } from "./agent-server/app.js";

startAgentServer().catch((error) => {
  console.error("Runner failed to start", error);
  process.exit(1);
});
