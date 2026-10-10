// HOP DONG SU KIEN giua client va server - nguon duy nhat cho bang su kien trong README.
// Server (Nest gateway) va client (socket.io-client) deu dung cac kieu nay -> TypeScript bat loi lech thiet ke.

export type Role = "customer" | "agent";
export type SenderRole = Role | "system";

/**
 * Vong doi phien:  waiting (hang cho) <-> active (co nhan vien) -> closed
 */
export type SessionStatus = "waiting" | "active" | "closed";

export interface ChatMessage {
  id: string; // do server cap: "<sessionId>#<seq>"
  sessionId: string;
  seq: number; // so thu tu trong phien, tang dan tu 1 -> sap xep + "da xem den dau"
  senderRole: SenderRole;
  senderId: string | null; // null voi tin he thong
  text: string;
  createdAt: number; // epoch ms, gio server
  clientMsgId: string | null; // id do client tu sinh -> chong nhan doi khi gui lai / nhieu tab
  clientSentAt: number | null; // epoch ms luc client bam gui -> do do tre
}

export interface SessionView {
  id: string;
  customerId: string;
  agentId: string | null;
  status: SessionStatus;
  createdAt: number;
  lastSeq: number;
  /** Seq lon nhat moi ben da THUC SU xem */
  readUpTo: Record<Role, number>;
  lastMessage: { text: string; senderRole: SenderRole; createdAt: number } | null;
}

export type ErrorCode =
  | "INVALID" // payload sai kieu
  | "EMPTY" // tin rong / chi khoang trang
  | "TOO_LONG" // vuot gioi han ky tu
  | "NOT_FOUND"
  | "FORBIDDEN" // khong phai nguoi trong phien
  | "SESSION_CLOSED"
  | "TAKEN"; // phien da co nhan vien khac nhan

export type Fail = { ok: false; code: ErrorCode; error: string };
export type Ack<T> = ({ ok: true } & T) | Fail;

export type SessionChangeReason =
  | "agent_joined"
  | "agent_left" // nhan vien bam roi phien
  | "agent_disconnected" // nhan vien mat ket noi qua thoi gian an han
  | "closed";

// ---------------------------------------------------------------- client -> server
export interface ClientToServerEvents {
  /** Khach mo khung chat: tao phien moi hoac noi lai phien dang mo. */
  "chat:open": (p: { sinceSeq?: number }, ack: (r: Ack<{ session: SessionView; messages: ChatMessage[]; resumed: boolean }>) => void) => void;
  "message:send": (
    p: { sessionId: string; clientMsgId: string; text: string; sentAt?: number },
    ack: (r: Ack<{ message: ChatMessage; duplicate: boolean }>) => void,
  ) => void;
  "typing:start": (p: { sessionId: string }) => void;
  "typing:stop": (p: { sessionId: string }) => void;
  /** Gui khi nguoi dung THUC SU dang nhin khung chat (tab hien, khung mo). */
  "message:read": (p: { sessionId: string; upToSeq: number }) => void;
  "chat:close": (p: { sessionId: string }, ack: (r: Ack<{ session: SessionView }>) => void) => void;
  /** Chi nhan vien */
  "agent:join": (p: { sessionId: string }, ack: (r: Ack<{ session: SessionView; messages: ChatMessage[] }>) => void) => void;
  "agent:leave": (p: { sessionId: string }, ack: (r: Ack<{ session: SessionView }>) => void) => void;
}

// ---------------------------------------------------------------- server -> client
export interface ServerToClientEvents {
  "message:new": (m: ChatMessage) => void;
  "typing:updated": (p: { sessionId: string; role: Role; isTyping: boolean }) => void;
  "read:updated": (p: { sessionId: string; readerRole: Role; upToSeq: number; readAt: number }) => void;
  "session:updated": (p: { session: SessionView; reason: SessionChangeReason }) => void;
  /** Chi gui cho nhan vien: cac phien chua dong (hang cho + dang xu ly). */
  "queue:updated": (p: { sessions: SessionView[] }) => void;
}

export interface AuthUser {
  role: Role;
  id: string;
}

export interface SocketData {
  user: AuthUser;
}
