import { log } from "../common/log";
import { startServer } from "./bootstrap";
import { serverConfig } from "./config";

startServer(serverConfig.port).then(({ port }) => {
  log("SERVER", `chay tai http://localhost:${port}  (trang van hanh: /ops.html)`);
});
