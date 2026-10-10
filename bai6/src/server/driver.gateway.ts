import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { log } from "../common/log";
import { ConnectRateLimiter, verifyDriverToken } from "./auth";
import { serverConfig } from "./config";
import { Order, OrderStore } from "./order.store";
import { PresenceService } from "./presence.service";

const ZONE_PREFIX = "zone:";
export const zoneRoom = (zone: string) => `${ZONE_PREFIX}${zone}`;
export const driverRoom = (driverId: string) => `driver:${driverId}`;

const ZONE_RE = /^[a-z0-9-]{1,40}$/;
const MAX_ZONES = 10;

function parseSubscribe(body: unknown): { zones: string[]; sinceSeq: number | null } | null {
  if (typeof body !== "object" || body === null) return null;
  const { zones, sinceSeq } = body as { zones?: unknown; sinceSeq?: unknown };
  if (!Array.isArray(zones) || zones.length > MAX_ZONES) return null;
  if (!zones.every((z) => typeof z === "string" && ZONE_RE.test(z))) return null;
  const since = typeof sinceSeq === "number" && Number.isInteger(sinceSeq) && sinceSeq >= 0 ? sinceSeq : null;
  return { zones: [...new Set(zones as string[])], sinceSeq: since };
}

@WebSocketGateway({
  cors: { origin: "*" },
  // (5) Khoang thoi gian cho truoc khi coi la mat ket noi (xem giai thich trong config.ts)
  pingInterval: serverConfig.pingIntervalMs,
  pingTimeout: serverConfig.pingTimeoutMs,
})
export class DriverGateway implements OnGatewayInit, OnGatewayConnection {
  @WebSocketServer() server: Server;

  readonly stats = { handshakes: 0, rejectedAuth: 0, rejectedRateLimit: 0, connections: 0 };
  private readonly limiter = new ConnectRateLimiter(serverConfig.connectRateLimit, serverConfig.connectRateWindowMs);

  constructor(
    private readonly presence: PresenceService,
    private readonly orders: OrderStore,
  ) {}

  afterInit(server: Server) {
    log(
      "SERVER",
      `heartbeat: ping moi ${serverConfig.pingIntervalMs}ms, cho pong ${serverConfig.pingTimeoutMs}ms ` +
        `-> phat hien mat ket noi toi da ~${serverConfig.pingIntervalMs + serverConfig.pingTimeoutMs}ms; ` +
        `an han offline ${serverConfig.offlineGraceMs}ms`,
    );

    // Middleware handshake: chay cho MOI lan ket noi / noi lai, truoc khi vao handleConnection.
    server.use((socket, next) => {
      this.stats.handshakes++;
      const driverId = verifyDriverToken(socket.handshake.auth?.token);
      if (!driverId) {
        this.stats.rejectedAuth++;
        return next(new Error("unauthorized"));
      }
      const verdict = this.limiter.hit(driverId);
      if (!verdict.ok) {
        this.stats.rejectedRateLimit++;
        log("SERVER", `tu choi ${driverId}: ket noi qua day (rate limit), cho ${verdict.retryAfterMs}ms`);
        const err = new Error("rate_limited") as Error & { data?: unknown };
        err.data = { retryAfterMs: verdict.retryAfterMs };
        return next(err);
      }
      socket.data.driverId = driverId;
      next();
    });
  }

  handleConnection(client: Socket) {
    const driverId: string = client.data.driverId;
    this.stats.connections++;

    // Room ca nhan suy ra tu token -> server tu join, khong phu thuoc client.
    client.join(driverRoom(driverId));
    this.presence.markConnected(driverId, client.id);
    log("SERVER", `+ ${driverId} ket noi (socket ${client.id}, transport ${client.conn.transport.name})`);

    // Moi goi tin tu client (ke ca pong) = bang chung tai xe con song.
    client.conn.on("packet", () => this.presence.touch(driverId));
    // Dung listener rieng (thay vi handleDisconnect) de lay duoc LY DO ngat.
    client.on("disconnect", (reason) => {
      log("SERVER", `- ${driverId} ngat (socket ${client.id}, ly do: ${reason})`);
      this.presence.markDisconnected(driverId, client.id, reason);
    });
  }

  @SubscribeMessage("driver:subscribe")
  handleSubscribe(@MessageBody() body: unknown, @ConnectedSocket() client: Socket) {
    const parsed = parseSubscribe(body);
    if (!parsed) return { ok: false, error: "du lieu dang ky khong hop le" };
    const { zones, sinceSeq } = parsed;

    // Dat lai tap zone dung bang danh sach client gui (idempotent: goi bao nhieu lan cung ra 1 ket qua).
    for (const room of client.rooms) {
      if (room.startsWith(ZONE_PREFIX) && !zones.includes(room.slice(ZONE_PREFIX.length))) client.leave(room);
    }
    zones.forEach((z) => client.join(zoneRoom(z)));

    const missed = sinceSeq === null ? [] : this.orders.since(sinceSeq, zones);
    const rooms = this.roomsOf(client.id);
    log(
      "SERVER",
      `${client.data.driverId} (socket ${client.id}) dang ky room: ${rooms.join(", ")}` +
        (sinceSeq === null ? "" : ` | bu ${missed.length} don bi lo tu seq ${sinceSeq}`),
    );
    return { ok: true, rooms, missed, serverSeq: this.orders.currentSeq };
  }

  /** Phat don moi toi tai xe trong zone. Tra ve so socket dang o trong room. */
  dispatchOrder(order: Order): number {
    this.server.to(zoneRoom(order.zone)).emit("order:new", order);
    return this.server.sockets.adapter.rooms.get(zoneRoom(order.zone))?.size ?? 0;
  }

  roomsOf(socketId: string): string[] {
    const socket = this.server.sockets.sockets.get(socketId);
    return socket ? [...socket.rooms].filter((r) => r !== socketId).sort() : [];
  }

  get connectedSockets() {
    return this.server.sockets.sockets.size;
  }
}
