// Client chat (Node) - cung logic voi public/customer.html & public/agent.html, dung cho test + demo.
import { randomUUID } from "crypto";
import { io, Socket } from "socket.io-client";
import { chatConfig } from "../shared/config";
import { Ack, ChatMessage, ClientToServerEvents, Fail, Role, ServerToClientEvents, SessionView } from "../shared/contract";
import { log } from "../shared/log";
import { checkMessageText } from "../shared/message-rules";

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface ChatClientOptions {
  url: string;
  token: string; // "customer:<id>" | "agent:<id>"
  tag?: string; // ten hien trong log, vd "KHACH-LAPTOP"
  silent?: boolean;
}

export function createChatClient(opts: ChatClientOptions) {
  const [role, myId] = opts.token.split(":") as [Role, string];
  const tag = opts.tag ?? `${role}:${myId}`;
  const say = (msg: string) => !opts.silent && log(tag, msg);

  const socket: ClientSocket = io(opts.url, { auth: { token: opts.token }, transports: ["websocket"] });

  const sessions = new Map<string, SessionView>();
  /** sessionId -> (message.id -> message): hien thi theo id => nhan bao nhieu lan cung chi 1 dong */
  const timelines = new Map<string, Map<string, ChatMessage>>();
  /** Tin dang gui (hien "dang gui..." ngay khi bam), key = clientMsgId */
  const pending = new Map<string, { sessionId: string; text: string }>();
  const typingEvents: { sessionId: string; role: Role; isTyping: boolean; at: number }[] = [];
  const readEvents: { sessionId: string; readerRole: Role; upToSeq: number; at: number }[] = [];
  const sessionEvents: { sessionId: string; status: string; reason: string; at: number }[] = [];
  /** Tin nhan duoc qua su kien (khong tinh tin chinh tab nay gui) + do tre */
  const received: { message: ChatMessage; latencyMs: number; from: "other-side" | "my-other-device" }[] = [];
  let queue: SessionView[] = [];
  let customerSessionId: string | null = null;

  const timeline = (sessionId: string) => {
    let t = timelines.get(sessionId);
    if (!t) timelines.set(sessionId, (t = new Map()));
    return t;
  };

  function upsert(m: ChatMessage, via: "event" | "ack" | "history") {
    const t = timeline(m.sessionId);
    if (t.has(m.id)) return; // da co -> bo qua, KHONG nhan doi
    t.set(m.id, m);
    const mine = m.clientMsgId !== null && pending.delete(m.clientMsgId); // thay bong "dang gui" bang tin that
    if (via !== "event" || mine) return;

    const latencyMs = Date.now() - (m.clientSentAt ?? m.createdAt);
    const from = m.senderRole === role && m.senderId === myId ? "my-other-device" : "other-side";
    received.push({ message: m, latencyMs, from });
    const label = m.senderRole === "system" ? "he thong" : `${m.senderRole}:${m.senderId}`;
    const note = from === "my-other-device" ? " (dong bo tu thiet bi khac cua minh)" : "";
    say(`<- nhan ${m.id} tu ${label}: "${short(m.text)}" | tre ${latencyMs}ms${note}`);
  }

  socket.on("message:new", (m) => upsert(m, "event"));
  socket.on("typing:updated", (p) => {
    if (p.role === role) return; // chi quan tam BEN KIA dang go
    typingEvents.push({ ...p, at: Date.now() });
    say(p.isTyping ? `... ${p.role} dang soan tin (${p.sessionId})` : `    ${p.role} ngung soan tin (${p.sessionId})`);
  });
  socket.on("read:updated", (p) => {
    const s = sessions.get(p.sessionId);
    if (s) s.readUpTo[p.readerRole] = p.upToSeq;
    readEvents.push({ ...p, at: Date.now() });
    if (p.readerRole !== role) say(`✓✓ ${p.readerRole} da xem den tin #${p.upToSeq} (${p.sessionId})`);
  });
  socket.on("session:updated", ({ session, reason }) => {
    sessions.set(session.id, session);
    sessionEvents.push({ sessionId: session.id, status: session.status, reason, at: Date.now() });
    say(`phien ${session.id}: ${session.status.toUpperCase()} (${reason})`);
  });
  socket.on("queue:updated", ({ sessions: list }) => {
    queue = list;
  });
  socket.on("connect", () => {
    say(`ket noi (socket ${socket.id})`);
    if (customerSessionId) void open(); // noi lai -> mo lai phien, lay tin bi lo
  });

  // ---------------------------------------------------------------- hanh dong
  async function open() {
    const last = customerSessionId ? Math.max(0, ...rendered(customerSessionId).map((m) => m.seq)) : 0;
    const r = await socket.timeout(5_000).emitWithAck("chat:open", { sinceSeq: last });
    if (!r.ok) throw new Error(r.error);
    customerSessionId = r.session.id;
    sessions.set(r.session.id, r.session);
    r.messages.forEach((m: ChatMessage) => upsert(m, "history"));
    say(`${r.resumed ? "NOI LAI" : "TAO MOI"} phien ${r.session.id} (${r.session.status}), ${timeline(r.session.id).size} tin trong lich su`);
    return r;
  }

  /** Gui tin. Kiem tra o client truoc (khong ton request), sau do server kiem tra lai. */
  async function send(text: string, sessionId = defaultSession(), clientMsgId: string = randomUUID()): Promise<Ack<{ message: ChatMessage }>> {
    const check = checkMessageText(text);
    if (!check.ok) {
      say(`(chan o client) ${check.error}`);
      return check;
    }
    stopTypingLocal();
    pending.set(clientMsgId, { sessionId, text: check.text });
    const sentAt = Date.now();
    say(`-> gui: "${short(check.text)}"`);

    // Mat ack (mang chap chon) -> gui LAI voi CUNG clientMsgId; server tra tin cu, khong tao ban sao.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await socket.timeout(3_000).emitWithAck("message:send", { sessionId, clientMsgId, text, sentAt });
        if (!r.ok) {
          pending.delete(clientMsgId);
          say(`(server tu choi ${r.code}) ${r.error}`);
          return r;
        }
        upsert(r.message, "ack");
        return r;
      } catch {
        say(`khong nhan duoc xac nhan, gui lai lan ${attempt + 1} (cung clientMsgId)`);
      }
    }
    return { ok: false, code: "INVALID", error: "Không gửi được tin nhắn, bạn kiểm tra kết nối mạng nhé." } satisfies Fail;
  }

  /** Gui tho (bo qua kiem tra client) - de chung minh server van chan khi client bi sua. */
  function sendRaw(payload: { sessionId: string; clientMsgId: string; text: unknown }) {
    return socket.timeout(3_000).emitWithAck("message:send", payload as never);
  }

  // Dang soan tin: start (toi da 1 lan / typingThrottleMs), stop sau typingIdleMs khong go.
  let lastStartSent = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  let typingSession: string | null = null;
  function keystroke(sessionId = defaultSession()) {
    const now = Date.now();
    if (now - lastStartSent >= chatConfig.typingThrottleMs || typingSession !== sessionId) {
      socket.emit("typing:start", { sessionId });
      lastStartSent = now;
    }
    typingSession = sessionId;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      socket.emit("typing:stop", { sessionId });
      stopTypingLocal();
    }, chatConfig.typingIdleMs);
  }
  function stopTypingLocal() {
    clearTimeout(idleTimer);
    lastStartSent = 0;
    typingSession = null;
  }

  /** Goi khi nguoi dung THUC SU dang nhin khung chat cua phien. */
  function markRead(sessionId = defaultSession()) {
    const upToSeq = Math.max(0, ...rendered(sessionId).map((m) => m.seq));
    socket.emit("message:read", { sessionId, upToSeq });
  }

  async function join(sessionId: string) {
    const r = await socket.timeout(5_000).emitWithAck("agent:join", { sessionId });
    if (r.ok) {
      sessions.set(r.session.id, r.session);
      r.messages.forEach((m: ChatMessage) => upsert(m, "history"));
      say(`nhan phien ${sessionId} (${r.messages.length} tin lich su)`);
    } else say(`khong nhan duoc phien ${sessionId}: ${r.error}`);
    return r;
  }

  async function leave(sessionId: string) {
    const r = await socket.timeout(5_000).emitWithAck("agent:leave", { sessionId });
    say(r.ok ? `roi phien ${sessionId}` : `roi phien loi: ${r.error}`);
    return r;
  }

  async function close(sessionId = defaultSession()) {
    return socket.timeout(5_000).emitWithAck("chat:close", { sessionId });
  }

  function rendered(sessionId: string) {
    return [...timeline(sessionId).values()].sort((a, b) => a.seq - b.seq);
  }

  function defaultSession() {
    if (customerSessionId) return customerSessionId;
    const active = [...sessions.values()].find((s) => s.status === "active" && s.agentId === myId);
    if (!active) throw new Error("chua co phien nao");
    return active.id;
  }

  return {
    socket,
    role,
    id: myId,
    connected: () => new Promise<void>((ok) => (socket.connected ? ok() : socket.once("connect", () => ok()))),
    open,
    send,
    sendRaw,
    keystroke,
    markRead,
    join,
    leave,
    close,
    rendered,
    pendingCount: () => pending.size,
    get sessionId() {
      return customerSessionId;
    },
    session: (id: string) => sessions.get(id),
    get queue() {
      return queue;
    },
    typingEvents,
    readEvents,
    sessionEvents,
    received,
    disconnect: () => {
      stopTypingLocal();
      socket.disconnect();
    },
  };
}

export type ChatClient = ReturnType<typeof createChatClient>;

const short = (t: string) => (t.length > 40 ? `${t.slice(0, 40)}...(${t.length} ky tu)` : t).replace(/\n/g, " ");
