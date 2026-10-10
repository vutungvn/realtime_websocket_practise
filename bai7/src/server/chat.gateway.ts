// CHAT GATEWAY - hien thuc dung bang su kien trong README (src/shared/contract.ts).
//
// Room:
//   user:<role>:<id>   moi thiet bi cua 1 nguoi            -> dong bo da thiet bi, keo/day nhan vien vao phien
//   session:<id>       moi thiet bi cua khach + nhan vien  -> tin nhan / dang go / da xem / doi trang thai
//   agents             moi nhan vien dang online            -> hang cho
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { OnModuleDestroy } from "@nestjs/common";
import { Server, Socket } from "socket.io";
import { chatConfig } from "../shared/config";
import {
  AuthUser,
  ClientToServerEvents,
  ErrorCode,
  Fail,
  Role,
  ServerToClientEvents,
  SessionChangeReason,
  SocketData,
} from "../shared/contract";
import { log } from "../shared/log";
import { checkMessageText, isClientMsgId } from "../shared/message-rules";
import { verifyToken } from "./auth";
import { ChatSession, ChatStore } from "./chat.store";
import { TypingService } from "./typing.service";

type ChatServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type ChatSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export const userRoom = (role: Role, id: string) => `user:${role}:${id}`;
export const sessionRoom = (sessionId: string) => `session:${sessionId}`;
const AGENTS_ROOM = "agents";

const fail = (code: ErrorCode, error: string): Fail => ({ ok: false, code, error });
const who = (u: AuthUser) => `${u.role}:${u.id}`;
const bodyOf = (b: unknown) => (typeof b === "object" && b !== null ? (b as Record<string, unknown>) : {});

@WebSocketGateway({ cors: { origin: "*" }, maxHttpBufferSize: chatConfig.maxPayloadBytes })
export class ChatGateway implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy {
  @WebSocketServer() server: ChatServer;
  private readonly agentGraceTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly store: ChatStore,
    private readonly typing: TypingService,
  ) {}

  afterInit(server: ChatServer) {
    server.use((socket, next) => {
      const user = verifyToken(socket.handshake.auth?.token);
      if (!user) return next(new Error("unauthorized"));
      socket.data.user = user;
      next();
    });
    this.typing.bind((sessionId, role, isTyping) => {
      this.server.to(sessionRoom(sessionId)).emit("typing:updated", { sessionId, role, isTyping });
      log("SERVER", `typing ${sessionId} ${role}: ${isTyping ? "BAT" : "TAT"}`);
    });
  }

  // ------------------------------------------------------------------ ket noi
  handleConnection(client: ChatSocket) {
    const user = client.data.user;
    client.join(userRoom(user.role, user.id));
    log("SERVER", `+ ${who(user)} ket noi (socket ${client.id})`);

    if (user.role === "agent") {
      clearTimeout(this.agentGraceTimers.get(user.id));
      this.agentGraceTimers.delete(user.id);
      client.join(AGENTS_ROOM);
      // Thiet bi moi / noi lai cua nhan vien: vao lai moi phien dang phu trach.
      this.store.activeOf(user.id).forEach((s) => client.join(sessionRoom(s.id)));
      client.emit("queue:updated", { sessions: this.store.openSessions() });
    }

    client.on("disconnect", (reason) => this.onDisconnect(client, reason));
  }

  private onDisconnect(client: ChatSocket, reason: string) {
    const user = client.data.user;
    this.typing.socketGone(client.id);
    const remaining = this.server.sockets.adapter.rooms.get(userRoom(user.role, user.id))?.size ?? 0;
    log("SERVER", `- ${who(user)} ngat (socket ${client.id}, ${reason}), con ${remaining} thiet bi`);

    if (user.role === "agent" && remaining === 0 && this.store.activeOf(user.id).length > 0) {
      // Trang thai trung gian: cho nhan vien quay lai, het an han moi tra phien ve hang cho.
      this.agentGraceTimers.set(
        user.id,
        setTimeout(() => {
          this.agentGraceTimers.delete(user.id);
          this.store.activeOf(user.id).forEach((s) => this.requeue(s, "agent_disconnected"));
        }, chatConfig.agentGraceMs),
      );
    }
  }

  // ------------------------------------------------------------------ khach mo khung chat
  @SubscribeMessage("chat:open")
  handleOpen(@MessageBody() body: unknown, @ConnectedSocket() client: ChatSocket) {
    const user = client.data.user;
    if (user.role !== "customer") return fail("FORBIDDEN", "Chỉ khách hàng mới mở được khung chat.");

    const { session, resumed } = this.store.openForCustomer(user.id);
    client.join(sessionRoom(session.id));
    if (!resumed) {
      this.store.addMessage(session, null, "Xin chào! ShopFast đang kết nối bạn với nhân viên hỗ trợ, bạn vui lòng chờ trong giây lát nhé.");
      this.pushQueue();
    }
    // Tab vua mo can biet ngay ben kia co dang go khong.
    this.typing.typingRoles(session.id).forEach((role) => client.emit("typing:updated", { sessionId: session.id, role, isTyping: true }));

    const sinceSeq = typeof bodyOf(body).sinceSeq === "number" ? (bodyOf(body).sinceSeq as number) : 0;
    log("SERVER", `${who(user)} ${resumed ? "NOI LAI" : "TAO MOI"} phien ${session.id} (socket ${client.id}, trang thai ${session.status})`);
    return { ok: true as const, session: this.store.view(session), messages: this.store.messagesSince(session, sinceSeq), resumed };
  }

  // ------------------------------------------------------------------ gui tin
  @SubscribeMessage("message:send")
  handleSend(@MessageBody() body: unknown, @ConnectedSocket() client: ChatSocket) {
    const user = client.data.user;
    const p = bodyOf(body);
    const s = this.resolve(user, p.sessionId);
    if ("ok" in s) return s;
    if (s.status === "closed") {
      return fail("SESSION_CLOSED", "Cuộc trò chuyện đã kết thúc. Bạn hãy mở lại khung chat để bắt đầu cuộc trò chuyện mới nhé.");
    }
    if (!isClientMsgId(p.clientMsgId)) return fail("INVALID", "Tin nhắn không hợp lệ, bạn vui lòng thử lại.");

    // BAY DU LIEU: tin rong / chi khoang trang / qua dai -> tu choi kem thong bao than thien.
    const check = checkMessageText(p.text);
    if (!check.ok) {
      const len = typeof p.text === "string" ? p.text.length : 0;
      log("SERVER", `CHAN tin tu ${who(user)}: ${check.code} (do dai goc ${len})`);
      return check;
    }

    const sentAt = typeof p.sentAt === "number" ? p.sentAt : null;
    const { message, duplicate } = this.store.addMessage(s, user, check.text, p.clientMsgId, sentAt);
    if (duplicate) {
      // BAY DU LIEU: gui lai cung clientMsgId (mang chap chon / 2 tab) -> tra tin cu, KHONG phat lai.
      log("SERVER", `tin trung clientMsgId ${p.clientMsgId} tu ${who(user)} -> tra lai ${message.id}, khong phat lai`);
      return { ok: true as const, message, duplicate: true };
    }

    this.typing.stop(s.id, user.role);
    // Phat 1 lan vao room phien: moi socket (moi tab, moi thiet bi) nhan dung 1 ban.
    this.server.to(sessionRoom(s.id)).emit("message:new", message);
    if (s.status === "waiting") this.pushQueue();

    const sockets = this.server.sockets.adapter.rooms.get(sessionRoom(s.id))?.size ?? 0;
    const leg = sentAt ? ` | client->server ${message.createdAt - sentAt}ms` : "";
    log("SERVER", `tin ${message.id} tu ${who(user)}: "${preview(message.text)}" -> ${sockets} socket${leg}`);
    return { ok: true as const, message, duplicate: false };
  }

  // ------------------------------------------------------------------ dang soan tin
  @SubscribeMessage("typing:start")
  handleTypingStart(@MessageBody() body: unknown, @ConnectedSocket() client: ChatSocket) {
    const s = this.resolve(client.data.user, bodyOf(body).sessionId);
    if ("ok" in s || s.status === "closed") return;
    this.typing.start(s.id, client.data.user.role, client.id);
  }

  @SubscribeMessage("typing:stop")
  handleTypingStop(@MessageBody() body: unknown, @ConnectedSocket() client: ChatSocket) {
    const s = this.resolve(client.data.user, bodyOf(body).sessionId);
    if ("ok" in s) return;
    this.typing.stop(s.id, client.data.user.role);
  }

  // ------------------------------------------------------------------ da xem
  @SubscribeMessage("message:read")
  handleRead(@MessageBody() body: unknown, @ConnectedSocket() client: ChatSocket) {
    const user = client.data.user;
    const p = bodyOf(body);
    const s = this.resolve(user, p.sessionId);
    if ("ok" in s || !Number.isInteger(p.upToSeq)) return;
    if (!this.store.markRead(s, user.role, p.upToSeq as number)) return; // khong doi -> khong phat

    const upToSeq = s.readUpTo[user.role];
    this.server.to(sessionRoom(s.id)).emit("read:updated", { sessionId: s.id, readerRole: user.role, upToSeq, readAt: Date.now() });
    log("SERVER", `${who(user)} da xem ${s.id} den tin #${upToSeq}`);
  }

  // ------------------------------------------------------------------ nhan vien
  @SubscribeMessage("agent:join")
  handleAgentJoin(@MessageBody() body: unknown, @ConnectedSocket() client: ChatSocket) {
    const user = client.data.user;
    if (user.role !== "agent") return fail("FORBIDDEN", "Chỉ nhân viên mới nhận được phiên chat.");
    const s = this.store.get(bodyOf(body).sessionId);
    if (!s) return fail("NOT_FOUND", "Không tìm thấy cuộc trò chuyện.");
    if (s.status === "closed") return fail("SESSION_CLOSED", "Cuộc trò chuyện đã kết thúc.");
    if (s.status === "active" && s.agentId !== user.id) {
      return fail("TAKEN", `Phiên ${s.id} đã được nhân viên ${s.agentId} nhận.`);
    }

    if (s.status === "waiting") {
      this.store.assignAgent(s, user.id);
      // Keo MOI thiet bi cua nhan vien vao phien, khong chi thiet bi vua bam.
      this.server.in(userRoom("agent", user.id)).socketsJoin(sessionRoom(s.id));
      this.systemMessage(s, `Nhân viên ${user.id} đã tham gia cuộc trò chuyện và sẽ hỗ trợ bạn.`);
      this.broadcastSession(s, "agent_joined");
      this.pushQueue();
      log("SERVER", `${who(user)} NHAN phien ${s.id}`);
    }
    return { ok: true as const, session: this.store.view(s), messages: this.store.messagesSince(s) };
  }

  @SubscribeMessage("agent:leave")
  handleAgentLeave(@MessageBody() body: unknown, @ConnectedSocket() client: ChatSocket) {
    const user = client.data.user;
    const s = this.resolve(user, bodyOf(body).sessionId);
    if ("ok" in s) return s;
    if (user.role !== "agent" || s.status !== "active") return fail("FORBIDDEN", "Bạn không phụ trách phiên này.");
    this.requeue(s, "agent_left");
    return { ok: true as const, session: this.store.view(s) };
  }

  // ------------------------------------------------------------------ dong phien
  @SubscribeMessage("chat:close")
  handleClose(@MessageBody() body: unknown, @ConnectedSocket() client: ChatSocket) {
    const user = client.data.user;
    const s = this.resolve(user, bodyOf(body).sessionId);
    if ("ok" in s) return s;
    if (s.status !== "closed") {
      this.store.close(s);
      this.typing.clearSession(s.id);
      this.systemMessage(s, `Cuộc trò chuyện đã được ${user.role === "agent" ? "nhân viên" : "khách hàng"} kết thúc. Cảm ơn bạn đã liên hệ ShopFast!`);
      this.broadcastSession(s, "closed");
      this.server.in(sessionRoom(s.id)).socketsLeave(sessionRoom(s.id)); // don room
      this.pushQueue();
      log("SERVER", `${who(user)} DONG phien ${s.id}`);
    }
    return { ok: true as const, session: this.store.view(s) };
  }

  // ------------------------------------------------------------------ tien ich
  /** Phien ve hang cho: khach duoc bao, lich su giu nguyen, nhan vien khac nhan tiep. */
  private requeue(s: ChatSession, reason: SessionChangeReason) {
    const agentId = s.agentId!;
    this.typing.stop(s.id, "agent");
    this.store.requeue(s);
    this.server.in(userRoom("agent", agentId)).socketsLeave(sessionRoom(s.id));
    this.systemMessage(
      s,
      reason === "agent_left"
        ? `Nhân viên ${agentId} đã rời cuộc trò chuyện. Bạn đã được chuyển về hàng chờ, nhân viên khác sẽ hỗ trợ bạn ngay khi có thể.`
        : `Nhân viên ${agentId} bị mất kết nối. Bạn đã được chuyển về hàng chờ, nhân viên khác sẽ hỗ trợ bạn ngay khi có thể.`,
    );
    this.broadcastSession(s, reason);
    this.pushQueue();
    log("SERVER", `phien ${s.id} VE HANG CHO (${reason}, nhan vien cu ${agentId})`);
  }

  private resolve(user: AuthUser, sessionId: unknown): ChatSession | Fail {
    const s = this.store.get(sessionId);
    if (!s) return fail("NOT_FOUND", "Không tìm thấy cuộc trò chuyện.");
    if (!this.store.isParticipant(user, s)) return fail("FORBIDDEN", "Bạn không thuộc cuộc trò chuyện này.");
    return s;
  }

  private systemMessage(s: ChatSession, text: string) {
    const { message } = this.store.addMessage(s, null, text);
    this.server.to(sessionRoom(s.id)).emit("message:new", message);
  }

  private broadcastSession(s: ChatSession, reason: SessionChangeReason) {
    this.server.to(sessionRoom(s.id)).emit("session:updated", { session: this.store.view(s), reason });
  }

  private pushQueue() {
    this.server.to(AGENTS_ROOM).emit("queue:updated", { sessions: this.store.openSessions() });
  }

  onModuleDestroy() {
    this.agentGraceTimers.forEach((t) => clearTimeout(t));
  }
}

const preview = (text: string) => (text.length > 40 ? `${text.slice(0, 40)}...` : text).replace(/\n/g, " ");
