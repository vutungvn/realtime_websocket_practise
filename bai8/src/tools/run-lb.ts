// Chay bo can bang tai gia lap + dieu khien mang kho bang ban phim (go lenh + Enter):
//   d       -> mang kho rot          u      -> hoi phuc
//   o 5     -> rot 5 giay roi tu hoi phuc
//   r       -> cat ngang moi ket noi (nhu server khoi dong lai / LB chuyen node)
//   s       -> xem thong ke
// Bien moi truong: LB_PORT (8080), PORT server (4000), LB_IDLE_MS (60000)
import readline from "readline";
import { log, sleep } from "../log";
import { LoadBalancerSim } from "./lb-sim";

const lbPort = Number(process.env.LB_PORT ?? 8080);
const target = Number(process.env.PORT ?? 4000);
const idleMs = Number(process.env.LB_IDLE_MS ?? 60_000);

async function main() {
  const lb = new LoadBalancerSim(lbPort, { host: "127.0.0.1", port: target }, idleMs);
  await lb.start();
  log("LB", `bo can bang tai :${lbPort} -> server :${target}, cat ket noi im lang qua ${idleMs / 1000}s`);
  log("LB", "lenh: d (rot mang) | u (hoi phuc) | o <giay> (rot N giay) | r (cat ngang) | s (thong ke)");

  readline.createInterface({ input: process.stdin }).on("line", async (line) => {
    const [cmd, arg] = line.trim().split(/\s+/);
    if (cmd === "d") lb.cut();
    else if (cmd === "u") lb.restore();
    else if (cmd === "r") lb.dropAll();
    else if (cmd === "s") log("LB", `dang mo ${lb.openConnections} | ${JSON.stringify(lb.stats)}`);
    else if (cmd === "o") {
      const sec = Number(arg) || 5;
      lb.cut();
      await sleep(sec * 1000);
      lb.restore();
    }
  });
}
main();
