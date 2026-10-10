// Kiem thu end-to-end: server NestJS that + nhieu client socket.io that (moi client = 1 tab / thiet bi).
import { INestApplication } from "@nestjs/common";
import { ChatClient, createChatClient } from "../src/client/chat-client";
import { startServer } from "../src/server/bootstrap";
import { chatConfig } from "../src/shared/config";
import { ChatMessage } from "../src/shared/contract";
import { sleep } from "../src/shared/log";

let app: INestApplication;
let url: string;
const clients: ChatClient[] = [];

beforeEach(async () => {
  const s = await startServer(0);
  app = s.app;
  url = `http://127.0.0.1:${s.port}`;
});

afterEach(async () => {
  clients.splice(0).forEach((c) => c.disconnect());
  await app.close();
});

async function client(token: string) {
  const c = createChatClient({ url, token, silent: true });
  clients.push(c);
  await c.connected();
  return c;
}

async function waitFor(cond: () => boolean, timeoutMs = 3_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(10);
  }
  throw new Error(`het ${timeoutMs}ms ma dieu kien chua dung`);
}

/** Khach mo chat + nhan vien nhan phien. */
async function activeSession(customer = "customer:khach-01", agent = "agent:an") {
  const c = await client(customer);
  const a = await client(agent);
  const { session } = (await c.open()) as { session: { id: string } };
  await a.join(session.id);
  await waitFor(() => c.session(session.id)?.status === "active");
  return { c, a, sid: session.id };
}

const texts = (msgs: ChatMessage[]) => msgs.map((m) => m.text);

// ===========================================================================
describe("vong doi phien", () => {
  it("TC1: mo chat tao phien moi; thiet bi thu 2 NOI LAI dung phien do; dong roi mo lai -> phien moi", async () => {
    const laptop = await client("customer:khach-01");
    const phone = await client("customer:khach-01");

    const first = await laptop.open();
    const second = await phone.open();
    expect(first.resumed).toBe(false);
    expect(second.resumed).toBe(true);
    expect(second.session.id).toBe(first.session.id);
    expect(first.session.status).toBe("waiting");

    await laptop.close(first.session.id);
    const third = await laptop.open();
    expect(third.resumed).toBe(false);
    expect(third.session.id).not.toBe(first.session.id);
  });

  it("TC2: nhan vien roi phien -> khach duoc bao, phien ve hang cho, nhan vien khac nhan tiep", async () => {
    const { c, a, sid } = await activeSession();
    const b = await client("agent:binh");
    expect((await b.join(sid)).ok).toBe(false); // dang co nguoi nhan -> TAKEN

    await a.leave(sid);
    await waitFor(() => c.session(sid)?.status === "waiting");
    expect(c.sessionEvents.at(-1)).toMatchObject({ status: "waiting", reason: "agent_left" });
    expect(c.rendered(sid).at(-1)!.text).toContain("đã rời cuộc trò chuyện");
    await waitFor(() => b.queue.some((s) => s.id === sid && s.status === "waiting"));

    expect((await b.join(sid)).ok).toBe(true);
    await waitFor(() => c.session(sid)?.agentId === "binh");
  });

  it("TC3: nhan vien mat ket noi moi thiet bi qua an han -> phien ve hang cho; quay lai trong an han -> giu phien", async () => {
    const { c, a, sid } = await activeSession();

    // Quay lai kip: socket moi cua nhan vien tu vao lai room phien.
    a.disconnect();
    const a2 = await client("agent:an");
    await sleep(chatConfig.agentGraceMs + 200);
    expect(c.session(sid)?.status).toBe("active");
    await c.send("con do khong?");
    await waitFor(() => a2.rendered(sid).some((m) => m.text === "con do khong?"));

    // Mat han: het an han -> hang cho.
    a2.disconnect();
    await waitFor(() => c.session(sid)?.status === "waiting", chatConfig.agentGraceMs + 1_000);
    expect(c.sessionEvents.at(-1)?.reason).toBe("agent_disconnected");
  });

  it("TC4: nguoi ngoai phien khong gui duoc tin vao phien", async () => {
    const { sid } = await activeSession();
    const stranger = await client("customer:khach-la");
    const r = await stranger.sendRaw({ sessionId: sid, clientMsgId: "x1", text: "hello" });
    expect(r).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
});

// ===========================================================================
describe("tin nhan thoi gian thuc", () => {
  it("TC5: hai chieu, do tre < 1 giay (do bang moc thoi gian clientSentAt -> luc nhan)", async () => {
    const { c, a, sid } = await activeSession();

    await c.send("Don hang cua toi bao gio giao?");
    await waitFor(() => a.received.some((r) => r.message.text.startsWith("Don hang")));
    await a.send("Chi oi, don se giao trong chieu nay a.", sid);
    await waitFor(() => c.received.some((r) => r.message.text.startsWith("Chi oi")));

    const c2a = a.received.find((r) => r.message.senderRole === "customer")!.latencyMs;
    const a2c = c.received.find((r) => r.message.senderRole === "agent")!.latencyMs;
    expect(c2a).toBeLessThan(1_000);
    expect(a2c).toBeLessThan(1_000);
  });
});

// ===========================================================================
describe("dang soan tin", () => {
  it("TC6: go 1 phim -> ben kia thay ngay; khong go nua -> TU TAT dung sau 3 giay", async () => {
    const { c, a } = await activeSession();
    const t0 = Date.now();
    c.keystroke();

    await waitFor(() => a.typingEvents.some((e) => e.isTyping));
    expect(a.typingEvents[0].at - t0).toBeLessThan(300);

    await waitFor(() => a.typingEvents.some((e) => !e.isTyping), 5_000);
    const offAfter = a.typingEvents.find((e) => !e.isTyping)!.at - t0;
    expect(offAfter).toBeGreaterThanOrEqual(chatConfig.typingIdleMs);
    expect(offAfter).toBeLessThan(chatConfig.typingIdleMs + 300);
  });

  it("TC7: go lien tuc 4 giay -> van hien, chi 1 su kien bat; tat 3 giay sau phim CUOI", async () => {
    const { c, a } = await activeSession();
    let lastKey = 0;
    for (let i = 0; i < 14; i++) {
      c.keystroke();
      lastKey = Date.now();
      await sleep(300);
    }
    expect(a.typingEvents.filter((e) => !e.isTyping)).toHaveLength(0); // chua tat giua chung
    await waitFor(() => a.typingEvents.some((e) => !e.isTyping), 5_000);

    expect(a.typingEvents.filter((e) => e.isTyping)).toHaveLength(1); // server chi phat khi DOI trang thai
    const offAfter = a.typingEvents.find((e) => !e.isTyping)!.at - lastKey;
    expect(offAfter).toBeGreaterThanOrEqual(chatConfig.typingIdleMs);
    expect(offAfter).toBeLessThan(chatConfig.typingIdleMs + 300);
  });

  it("TC8: gui tin -> tat 'dang soan' ngay; dong tab dang go -> cung tat ngay", async () => {
    const { c, a } = await activeSession();
    c.keystroke();
    await waitFor(() => a.typingEvents.length === 1);
    const t0 = Date.now();
    await c.send("xong");
    await waitFor(() => a.typingEvents.length === 2);
    expect(a.typingEvents[1].isTyping).toBe(false);
    expect(a.typingEvents[1].at - t0).toBeLessThan(300);

    a.keystroke(); // nhan vien go roi tat ngang tab
    await waitFor(() => c.typingEvents.length === 1);
    const t1 = Date.now();
    a.disconnect();
    await waitFor(() => c.typingEvents.length === 2);
    expect(c.typingEvents[1].at - t1).toBeLessThan(300);
  });
});

// ===========================================================================
describe("da xem", () => {
  it("TC9: nhan duoc tin CHUA phai la da xem; chi khi mo khung chat moi bao 'da xem' (ca 2 tab khach deu thay)", async () => {
    const { c, a, sid } = await activeSession();
    const phone = await client("customer:khach-01");
    await phone.open();

    const r = await c.send("Shop oi");
    const seq = (r as { message: ChatMessage }).message.seq;
    await waitFor(() => a.rendered(sid).some((m) => m.seq === seq));
    await sleep(300);
    expect(c.readEvents.filter((e) => e.readerRole === "agent")).toHaveLength(0);

    a.markRead(sid); // nhan vien mo khung chat phien nay
    await waitFor(() => c.readEvents.some((e) => e.readerRole === "agent"));
    await waitFor(() => phone.readEvents.some((e) => e.readerRole === "agent"));
    expect(c.session(sid)!.readUpTo.agent).toBe(seq);
  });
});

// ===========================================================================
describe("bay du lieu", () => {
  it("TC10: tin rong / chi khoang trang / ky tu vo hinh bi chan, thong bao than thien, khong luu gi", async () => {
    const { c, a, sid } = await activeSession();
    const before = c.rendered(sid).length;

    for (const bad of ["", "   ", "\n\t  \n", "​​"]) {
      const local = await c.send(bad);
      expect(local).toMatchObject({ ok: false, code: "EMPTY" });
      expect((local as { error: string }).error).toBe("Bạn chưa nhập nội dung. Hãy gõ vài chữ trước khi gửi nhé!");
      // Client bi sua, gui thang len server -> server van chan
      expect(await c.sendRaw({ sessionId: sid, clientMsgId: `raw${bad.length}`, text: bad })).toMatchObject({ ok: false, code: "EMPTY" });
    }
    await sleep(200);
    expect(c.rendered(sid)).toHaveLength(before);
    expect(a.received.filter((r) => r.message.senderRole === "customer")).toHaveLength(0);
  });

  it("TC11: tin 20.000 ky tu bi tu choi ro rang, ket noi van song; 2.000 ky tu (ke ca emoji) van gui duoc", async () => {
    const { c, sid } = await activeSession();
    const huge = "a".repeat(20_000);

    const local = await c.send(huge);
    expect(local).toMatchObject({ ok: false, code: "TOO_LONG" });
    expect((local as { error: string }).error).toBe(
      "Tin nhắn dài 20.000 ký tự, vượt giới hạn 2.000 ký tự. Bạn vui lòng rút gọn hoặc chia thành nhiều tin nhỏ hơn nhé.",
    );
    expect(await c.sendRaw({ sessionId: sid, clientMsgId: "huge", text: huge })).toMatchObject({ ok: false, code: "TOO_LONG" });
    expect(c.socket.connected).toBe(true);

    expect((await c.send("ă".repeat(2_000))).ok).toBe(true);
    expect((await c.send("😀".repeat(2_000))).ok).toBe(true); // 2000 emoji = 2000 ky tu (4000 don vi UTF-16)
    expect(await c.send("a".repeat(2_001))).toMatchObject({ ok: false, code: "TOO_LONG" });
  });

  it("TC12: 2 tab cung 1 khach -> tin xuat hien du o ca 2, KHONG nhan doi; gui lai cung clientMsgId khong tao ban sao", async () => {
    const { c: laptop, a, sid } = await activeSession();
    const phone = await client("customer:khach-01");
    await phone.open();

    await laptop.send("gui tu laptop");
    await phone.send("gui tu dien thoai");
    await a.send("nhan vien tra loi", sid);
    await waitFor(() => [laptop, phone, a].every((x) => x.rendered(sid).some((m) => m.text === "nhan vien tra loi")));
    await sleep(200);

    const expected = ["gui tu laptop", "gui tu dien thoai", "nhan vien tra loi"];
    for (const x of [laptop, phone, a]) {
      const userTexts = texts(x.rendered(sid)).filter((t) => expected.includes(t));
      expect(userTexts).toEqual(expected); // du, dung thu tu, moi tin 1 lan
      expect(x.pendingCount()).toBe(0);
    }

    // Mang chap chon: gui lai dung clientMsgId da gui
    const first = await laptop.send("chi gui 1 lan", sid, "fixed-id-123");
    const retry = await laptop.send("chi gui 1 lan", sid, "fixed-id-123");
    expect(retry).toMatchObject({ ok: true, duplicate: true });
    expect((retry as { message: ChatMessage }).message.id).toBe((first as { message: ChatMessage }).message.id);
    await sleep(200);
    expect(a.rendered(sid).filter((m) => m.text === "chi gui 1 lan")).toHaveLength(1);
    expect(phone.received.filter((r) => r.message.text === "chi gui 1 lan")).toHaveLength(1);

    // Tab thu 3 mo sau: lich su giong het
    const tablet = await client("customer:khach-01");
    await tablet.open();
    expect(tablet.rendered(sid).map((m) => m.id)).toEqual(laptop.rendered(sid).map((m) => m.id));
  });
});
