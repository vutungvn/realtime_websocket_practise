// NOI LUU TRANG THAI PHIEN: server la nguon su that duy nhat (client chi hien thi).
// Ban demo luu trong bo nho; thuc te: bang sessions + messages trong DB
// (UNIQUE(session_id, sender_id, client_msg_id) thay cho Map `byClientMsgId`).
import { Injectable } from "@nestjs/common";
import { AuthUser, ChatMessage, Role, SessionStatus, SessionView } from "../shared/contract";

interface ChatSession {
  id: string;
  customerId: string;
  agentId: string | null;
  status: SessionStatus;
  createdAt: number;
  readUpTo: Record<Role, number>;
  messages: ChatMessage[];
}

@Injectable()
export class ChatStore {
  private nextSessionNo = 0;
  private readonly sessions = new Map<string, ChatSession>();
  /** customerId -> phien DANG MO cua khach (moi khach toi da 1 phien mo) */
  private readonly openByCustomer = new Map<string, string>();
  /** "<sessionId>|<role>:<userId>|<clientMsgId>" -> tin da luu (idempotent) */
  private readonly byClientMsgId = new Map<string, ChatMessage>();

  /** Tao phien moi hoac tra lai phien dang mo cua chinh khach do. */
  openForCustomer(customerId: string): { session: ChatSession; resumed: boolean } {
    const openId = this.openByCustomer.get(customerId);
    const existing = openId && this.sessions.get(openId);
    if (existing && existing.status !== "closed") return { session: existing, resumed: true };

    const session: ChatSession = {
      id: `S-${String(++this.nextSessionNo).padStart(4, "0")}`,
      customerId,
      agentId: null,
      status: "waiting",
      createdAt: Date.now(),
      readUpTo: { customer: 0, agent: 0 },
      messages: [],
    };
    this.sessions.set(session.id, session);
    this.openByCustomer.set(customerId, session.id);
    return { session, resumed: false };
  }

  get(sessionId: unknown): ChatSession | undefined {
    return typeof sessionId === "string" ? this.sessions.get(sessionId) : undefined;
  }

  isParticipant(user: AuthUser, s: ChatSession) {
    return user.role === "customer" ? s.customerId === user.id : s.agentId === user.id;
  }

  /** Them tin; neu (nguoi gui, clientMsgId) da ton tai -> tra lai tin cu, KHONG tao ban sao. */
  addMessage(
    s: ChatSession,
    sender: AuthUser | null,
    text: string,
    clientMsgId: string | null = null,
    clientSentAt: number | null = null,
  ): { message: ChatMessage; duplicate: boolean } {
    const key = sender && clientMsgId ? `${s.id}|${sender.role}:${sender.id}|${clientMsgId}` : null;
    const existing = key && this.byClientMsgId.get(key);
    if (existing) return { message: existing, duplicate: true };

    const seq = s.messages.length + 1;
    const message: ChatMessage = {
      id: `${s.id}#${seq}`,
      sessionId: s.id,
      seq,
      senderRole: sender?.role ?? "system",
      senderId: sender?.id ?? null,
      text,
      createdAt: Date.now(),
      clientMsgId,
      clientSentAt,
    };
    s.messages.push(message);
    if (key) this.byClientMsgId.set(key, message);
    return { message, duplicate: false };
  }

  messagesSince(s: ChatSession, sinceSeq = 0) {
    return s.messages.filter((m) => m.seq > sinceSeq);
  }

  /** Cap nhat "da xem den seq". Tra ve true neu co thay doi (chi phat su kien khi can). */
  markRead(s: ChatSession, role: Role, upToSeq: number) {
    const next = Math.min(Math.max(s.readUpTo[role], upToSeq), s.messages.length);
    if (next === s.readUpTo[role]) return false;
    s.readUpTo[role] = next;
    return true;
  }

  assignAgent(s: ChatSession, agentId: string) {
    s.agentId = agentId;
    s.status = "active";
  }

  /** Nhan vien roi -> phien ve hang cho, giu nguyen lich su. */
  requeue(s: ChatSession) {
    s.agentId = null;
    s.status = "waiting";
  }

  close(s: ChatSession) {
    s.status = "closed";
    if (this.openByCustomer.get(s.customerId) === s.id) this.openByCustomer.delete(s.customerId);
  }

  activeOf(agentId: string) {
    return [...this.sessions.values()].filter((s) => s.status === "active" && s.agentId === agentId);
  }

  openSessions() {
    return [...this.sessions.values()].filter((s) => s.status !== "closed").map((s) => this.view(s));
  }

  allViews() {
    return [...this.sessions.values()].map((s) => ({ ...this.view(s), messageCount: s.messages.length }));
  }

  view(s: ChatSession): SessionView {
    const last = s.messages.at(-1);
    return {
      id: s.id,
      customerId: s.customerId,
      agentId: s.agentId,
      status: s.status,
      createdAt: s.createdAt,
      lastSeq: s.messages.length,
      readUpTo: { ...s.readUpTo },
      lastMessage: last ? { text: last.text.slice(0, 80), senderRole: last.senderRole, createdAt: last.createdAt } : null,
    };
  }
}

export type { ChatSession };
