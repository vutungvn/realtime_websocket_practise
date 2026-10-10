// Chay proxy mang gia lap va dieu khien bang ban phim (go lenh + Enter):
//   d        -> mat mang (vao ham)
//   u        -> co mang lai
//   o 15     -> mat mang 15 giay roi tu co lai
//   r        -> cat ngang moi ket noi (RST)
//   f        -> mang chap chon: bat/tat 10 lan trong 30 giay
import readline from "readline";
import { log, sleep } from "../common/log";
import { ChaosProxy } from "./chaos-proxy";

const listenPort = Number(process.env.PROXY_PORT ?? 4100);
const targetPort = Number(process.env.PORT ?? 4000);

async function main() {
  const proxy = new ChaosProxy(listenPort, { host: "127.0.0.1", port: targetPort });
  await proxy.start();
  log("NETWORK", `proxy :${listenPort} -> server :${targetPort}. Lenh: d | u | o <giay> | r | f`);

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    const [cmd, arg] = line.trim().split(/\s+/);
    if (cmd === "d") proxy.cut();
    else if (cmd === "u") proxy.restore();
    else if (cmd === "r") proxy.dropAll();
    else if (cmd === "o") {
      const sec = Number(arg) || 15;
      log("NETWORK", `=== mat mang ${sec} giay ===`);
      proxy.cut();
      await sleep(sec * 1000);
      proxy.restore();
    } else if (cmd === "f") {
      log("NETWORK", "=== mang chap chon: 10 lan trong 30 giay ===");
      for (let i = 1; i <= 10; i++) {
        log("NETWORK", `chap chon lan ${i}/10`);
        proxy.dropAll();
        proxy.cut();
        await sleep(1500);
        proxy.restore();
        await sleep(1500);
      }
      log("NETWORK", "=== het chap chon ===");
    }
  });
}
main();
