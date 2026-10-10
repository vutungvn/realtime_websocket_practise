// Kich ban chay thu de NOP LOG: 1 phien chat day du tu luc khach mo toi luc dong.
//   npm run demo   -> in ra man hinh + ghi logs/chat-demo.log (moi dong co moc gio:phut:giay.mili-giay)
import { ChatClient, createChatClient } from "../client/chat-client";
import { startServer } from "../server/bootstrap";
import { chatConfig } from "../shared/config";
import { log, logToFile, sleep } from "../shared/log";

async function waitFor(cond: () => boolean, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && !cond()) await sleep(10);
  return cond();
}

async function main() {
  logToFile("logs/chat-demo.log");
  const step = (t: string) => log("DEMO", `========== ${t} ==========`);
  const { app, port } = await startServer(0);
  const url = `http://127.0.0.1:${port}`;
  const mk = async (token: string, tag: string) => {
    const c = createChatClient({ url, token, tag });
    await c.connected();
    return c;
  };

  step("1. Nhan vien An online; khach mo khung chat tren LAPTOP");
  const an = await mk("agent:an", "NV-AN");
  const laptop = await mk("customer:khach-01", "KHACH-LAPTOP");
  const opened = await laptop.open();
  const sid = opened.session.id;
  await waitFor(() => an.queue.some((s) => s.id === sid));
  log("DEMO", `hang cho cua nhan vien: ${an.queue.map((s) => `${s.id}(${s.status})`).join(", ")}`);

  step("2. Nhan vien An nhan phien");
  await an.join(sid);
  await waitFor(() => laptop.session(sid)?.status === "active");

  step(`3. Khach go phim ~1.5 giay roi dung -> 'dang soan tin' phai tu tat sau ${chatConfig.typingIdleMs / 1000} giay`);
  const firstKey = Date.now();
  let lastKey = 0;
  for (let i = 0; i < 6; i++) {
    laptop.keystroke();
    lastKey = Date.now();
    await sleep(250);
  }
  log("DEMO", "khach ngung go phim");
  await waitFor(() => an.typingEvents.some((e) => !e.isTyping), 6_000);
  const onAt = an.typingEvents.find((e) => e.isTyping)!.at;
  const offAt = an.typingEvents.find((e) => !e.isTyping)!.at;
  log("DEMO", `nhan vien thay 'dang soan' sau ${onAt - firstKey}ms ke tu phim dau; tu tat sau ${offAt - lastKey}ms ke tu phim cuoi`);

  step("4. Hoi dap hai chieu (do tre ghi o moi dong '<- nhan')");
  await laptop.send("Chao shop, don ORD-1024 cua minh bao gio giao vay?");
  await waitFor(() => an.received.length >= 1);
  an.markRead(sid); // nhan vien dang mo khung chat
  for (let i = 0; i < 4; i++) an.keystroke(sid), await sleep(200);
  await an.send("Chao chi, don ORD-1024 dang tren duong giao, du kien 15h chieu nay a.", sid);
  await waitFor(() => laptop.received.some((r) => r.message.senderRole === "agent"));
  laptop.markRead();
  await laptop.send("Ok cam on ban nhe");

  step("5. Khach mo them khung chat tren DIEN THOAI (cung tai khoan)");
  const phone = await mk("customer:khach-01", "KHACH-PHONE");
  const resumed = await phone.open();
  log("DEMO", `dien thoai: ${resumed.resumed ? "NOI LAI" : "TAO MOI"} phien ${resumed.session.id}, nhan ${resumed.messages.length} tin lich su`);
  await phone.send("Minh nhan tin tu dien thoai nhe");
  await an.send("Da em nhan duoc a", sid);
  await waitFor(() => [laptop, phone].every((c) => c.rendered(sid).some((m) => m.text === "Da em nhan duoc a")));

  step("6. 'Da xem': nhan vien NHAN tin nhung chua mo khung chat -> chua bao da xem");
  const ask = await phone.send("Shop co the giao truoc 14h duoc khong?");
  await waitFor(() => an.received.some((r) => r.message.text.startsWith("Shop co the")));
  await sleep(1_000);
  const seenEarly = laptop.readEvents.some((e) => e.readerRole === "agent" && e.upToSeq >= (ask as { message: { seq: number } }).message.seq);
  log("DEMO", `sau 1 giay ma nhan vien chua mo khung chat: ${seenEarly ? "DA XEM (sai)" : "CHUA XEM (dung)"}`);
  log("DEMO", "nhan vien bam vao phien de doc");
  an.markRead(sid);
  await waitFor(() => phone.readEvents.some((e) => e.readerRole === "agent" && e.upToSeq >= (ask as { message: { seq: number } }).message.seq));

  step("7. Bay du lieu: tin rong, chi khoang trang, 20.000 ky tu");
  await laptop.send("");
  await laptop.send("      \n\t  ");
  await laptop.send("x".repeat(20_000));
  log("DEMO", "gia lap client bi sua (bo qua kiem tra o trinh duyet), gui thang len server:");
  const raw = await laptop.sendRaw({ sessionId: sid, clientMsgId: "hack-1", text: "x".repeat(20_000) });
  log("DEMO", `server tra loi: ${JSON.stringify(raw)}`);
  log("DEMO", `ket noi cua khach van song: ${laptop.socket.connected}`);

  step("8. Nhan vien An roi phien -> khach duoc bao, phien ve hang cho; nhan vien Binh nhan tiep");
  const binh = await mk("agent:binh", "NV-BINH");
  await an.leave(sid);
  await waitFor(() => binh.queue.some((s) => s.id === sid && s.status === "waiting"));
  log("DEMO", `hang cho cua Binh: ${binh.queue.map((s) => `${s.id}(${s.status})`).join(", ")}`);
  await binh.join(sid);
  await binh.send("Chao chi, em la Binh, em ho tro tiep a.", sid);
  await waitFor(() => phone.rendered(sid).some((m) => m.text.startsWith("Chao chi, em la Binh")));

  step("9. Khach dong phien");
  await laptop.close(sid);
  await waitFor(() => phone.session(sid)?.status === "closed");

  step("KET QUA");
  const all: ChatClient[] = [laptop, phone, an, binh];
  const lat = all.flatMap((c) => c.received.map((r) => r.latencyMs));
  log("DEMO", `do tre ${lat.length} lan nhan tin: min ${Math.min(...lat)}ms, trung binh ${Math.round(lat.reduce((a, b) => a + b, 0) / lat.length)}ms, max ${Math.max(...lat)}ms -> ${Math.max(...lat) < 1000 ? "DAT (< 1 giay)" : "KHONG DAT"}`);
  for (const c of [laptop, phone]) {
    const msgs = c.rendered(sid);
    const dup = msgs.length - new Set(msgs.map((m) => m.text + m.senderId)).size;
    log("DEMO", `${c === laptop ? "laptop" : "dien thoai"}: ${msgs.length} tin, trung lap ${dup}`);
  }
  const same = JSON.stringify(laptop.rendered(sid).map((m) => m.id)) === JSON.stringify(phone.rendered(sid).map((m) => m.id));
  log("DEMO", `laptop va dien thoai hien GIONG HET nhau (cung id, cung thu tu): ${same ? "DUNG" : "SAI"}`);

  all.forEach((c) => c.disconnect());
  await app.close();
  process.exit(0);
}

main();
