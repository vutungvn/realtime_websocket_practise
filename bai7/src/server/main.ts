import { chatConfig } from "../shared/config";
import { log } from "../shared/log";
import { startServer } from "./bootstrap";

startServer(chatConfig.port).then(({ port }) => {
  log("SERVER", `chay tai http://localhost:${port}  | khach: /customer.html?user=customer-01  | nhan vien: /agent.html?user=agent-an`);
});
