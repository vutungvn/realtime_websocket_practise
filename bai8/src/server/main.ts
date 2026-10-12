import { log } from "../log";
import { startServer } from "./bootstrap";
import { config } from "./config";

startServer(config.port).then(({ port }) => {
  log("SERVER", `chay tai http://localhost:${port} | nhip tim ${config.heartbeatMs}ms | mo phong: ${config.simMode}`);
  log("SERVER", `bang dieu khien (qua bo can bang tai): http://localhost:8080/dashboard.html | dieu khien: http://localhost:${port}/admin.html`);
});
