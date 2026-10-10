// Chay 1 "dien thoai tai xe" trong terminal.
//   npm run driver                                   -> tai xe driver-01, zone cau-giay + dong-da, qua proxy :4100
//   DRIVER=driver-02 ZONES=ba-dinh npm run driver
//   SERVER_URL=http://localhost:4000 npm run driver  -> noi thang server (khong qua mang gia lap)
import { log } from "../common/log";
import { createDriverApp } from "./driver-client";

const driverId = process.env.DRIVER ?? "driver-01";
const zones = (process.env.ZONES ?? "cau-giay,dong-da").split(",").map((z) => z.trim()).filter(Boolean);
const serverUrl = process.env.SERVER_URL ?? "http://localhost:4100";

log("DRIVER-APP", `khoi dong app: tai xe ${driverId}, khu vuc [${zones.join(", ")}], server ${serverUrl}`);
const app = createDriverApp({ serverUrl, token: `tok_${driverId}`, zones });

process.on("SIGINT", () => {
  log("DRIVER-APP", "tai xe tat app (Ctrl+C)");
  app.close();
  setTimeout(() => process.exit(0), 200);
});
