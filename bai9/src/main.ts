import { startServer } from "./bootstrap";
import { config } from "./config";
import { log } from "./log";

startServer(config.port).then(({ port }) => {
  log("SERVER", `chay tai http://localhost:${port} (profile: ${config.profile}) - mo http://localhost:${port}/ de chon vai`);
});
