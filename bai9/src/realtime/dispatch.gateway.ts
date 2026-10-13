// GATEWAY: xac thuc khi bat tay, nhan su kien client -> goi nghiep vu, nghe DomainEvents -> phat dung pham vi.
//
// Room (pham vi nhan):
//   user:<id>         moi thiet bi cua 1 nguoi    -> don cua khach, loi moi/don cua tai xe
//   role:dispatcher   moi dieu phoi vien          -> toan canh: don, tai xe, canh bao
// Khong co room "tat ca": khong su kien nao phat cho moi nguoi.
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Logger, OnModuleDestroy } from "@nestjs/common";
import { Server, Socket } from "socket.io";
import { TokenService } from "../auth/token.service";
import { config } from "../config";
import { C2S, ClientToServerEvents, S2C, ServerToClientEvents, SocketData } from "../contracts/events";
import {
  AlertAckSchema,
  DispatchAssignSchema,
  DispatchCancelSchema,
  DriverLocationSchema,
  DriverShiftSchema,
  OfferRespondSchema,
  OrderPlaceSchema,
  OrderProgressSchema,
} from "../contracts/schemas";
import { AlertService } from "../domain/alert.service";
import { DispatchService } from "../domain/dispatch.service";
import { DomainEvents } from "../domain/domain-events";
import { OrderRepository } from "../domain/stores";
import { log } from "../log";
import { Projector } from "./projector";
import { runHandler } from "./ws-handler";

type IoServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type IoSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export const userRoom = (id: string) => `user:${id}`;
export const DISPATCHERS = "role:dispatcher";

@WebSocketGateway({
  cors: { origin: "*" },
  pingInterval: config.pingIntervalMs,
  pingTimeout: config.pingTimeoutMs,
  maxHttpBufferSize: config.maxPayloadBytes,
})
export class DispatchGateway implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy {
  @WebSocketServer() server: IoServer;
  private readonly logger = new Logger("Gateway");
  /** socketId -> timer ngat ket noi khi token het han (phai xoa khi socket dong). */
  private readonly sessionTimers = new Map<string, NodeJS.Timeout>();
  private readonly unsubscribers: (() => void)[] = [];
  readonly stats = { rejectedHandshakes: 0 };

  constructor(
    private readonly tokens: TokenService,
    private readonly dispatch: DispatchService,
    private readonly alerts: AlertService,
    private readonly orders: OrderRepository,
    private readonly view: Projector,
    private readonly events: DomainEvents,
  ) {}

  // ================================================================ BAT TAY
  afterInit(server: IoServer) {
    // Chay TRUOC khi co ket noi: khong token / token sai / het han -> tu choi, socket khong bao gio vao duoc room nao.
    server.use((socket, next) => {
      const result = this.tokens.verify(socket.handshake.auth?.token);
      if (!result.ok) {
        this.stats.rejectedHandshakes++;
        log("GATEWAY", `TU CHOI bat tay tu ${socket.handshake.address}: ${result.error}`);
        return next(new Error(result.error));
      }
      socket.data.user = result.user;
      (socket.data as SocketData & { expiresAt: number }).expiresAt = result.expiresAt;
      next();
    });
    this.subscribeDomainEvents();
  }

  handleConnection(client: IoSocket) {
    const user = client.data.user;
    client.join(userRoom(user.id));
    if (user.role === "dispatcher") client.join(DISPATCHERS);

    // Token het han giua chung -> ngat; timer duoc xoa khi socket dong (khong ro ri).
    const expiresAt = (client.data as SocketData & { expiresAt: number }).expiresAt;
    this.sessionTimers.set(
      client.id,
      setTimeout(() => client.disconnect(true), Math.max(0, Math.min(expiresAt - Date.now(), 2_147_000_000))),
    );

    client.on("disconnect", (reason) => this.onDisconnect(client, reason));
    if (user.role === "driver") this.dispatch.driverConnected(user.id, client.id);
    client.emit(S2C.SESSION_READY, { user, snapshot: this.view.snapshot(user) });
    log("GATEWAY", `+ ${user.role}:${user.id} (socket ${client.id})`);
  }

  private onDisconnect(client: IoSocket, reason: string) {
    const user = client.data.user;
    clearTimeout(this.sessionTimers.get(client.id));
    this.sessionTimers.delete(client.id);
    if (user.role === "driver") this.dispatch.driverDisconnected(user.id, client.id);
    log("GATEWAY", `- ${user.role}:${user.id} (socket ${client.id}, ly do: ${reason})`);
  }

  // ================================================================ CLIENT -> SERVER
  @SubscribeMessage(C2S.ORDER_PLACE)
  onOrderPlace(@ConnectedSocket() c: IoSocket, @MessageBody() body: unknown) {
    return runHandler(C2S.ORDER_PLACE, c.data.user, OrderPlaceSchema, body, (p) => ({
      order: this.view.forCustomer(this.dispatch.placeOrder(c.data.user.id, p)),
    }));
  }

  @SubscribeMessage(C2S.DRIVER_SHIFT)
  onDriverShift(@ConnectedSocket() c: IoSocket, @MessageBody() body: unknown) {
    return runHandler(C2S.DRIVER_SHIFT, c.data.user, DriverShiftSchema, body, (p) => ({
      driver: this.view.driver(this.dispatch.setShift(c.data.user.id, p.onShift)),
    }));
  }

  @SubscribeMessage(C2S.DRIVER_LOCATION)
  onDriverLocation(@ConnectedSocket() c: IoSocket, @MessageBody() body: unknown) {
    return runHandler(C2S.DRIVER_LOCATION, c.data.user, DriverLocationSchema, body, (p) => ({
      accepted: this.dispatch.updateLocation(c.data.user.id, p),
    }));
  }

  @SubscribeMessage(C2S.OFFER_RESPOND)
  onOfferRespond(@ConnectedSocket() c: IoSocket, @MessageBody() body: unknown) {
    return runHandler(C2S.OFFER_RESPOND, c.data.user, OfferRespondSchema, body, (p) => {
      const order = this.dispatch.respondOffer(c.data.user.id, p);
      return { order: order ? this.view.forDriver(order) : null };
    });
  }

  @SubscribeMessage(C2S.ORDER_PROGRESS)
  onOrderProgress(@ConnectedSocket() c: IoSocket, @MessageBody() body: unknown) {
    return runHandler(C2S.ORDER_PROGRESS, c.data.user, OrderProgressSchema, body, (p) => ({
      order: this.view.forDriver(this.dispatch.progress(c.data.user.id, p)),
    }));
  }

  @SubscribeMessage(C2S.DISPATCH_ASSIGN)
  onDispatchAssign(@ConnectedSocket() c: IoSocket, @MessageBody() body: unknown) {
    return runHandler(C2S.DISPATCH_ASSIGN, c.data.user, DispatchAssignSchema, body, (p) => ({
      order: this.view.forDispatcher(this.dispatch.assign(c.data.user.id, p)),
    }));
  }

  @SubscribeMessage(C2S.DISPATCH_CANCEL)
  onDispatchCancel(@ConnectedSocket() c: IoSocket, @MessageBody() body: unknown) {
    return runHandler(C2S.DISPATCH_CANCEL, c.data.user, DispatchCancelSchema, body, (p) => ({
      order: this.view.forDispatcher(this.dispatch.cancel(c.data.user.id, p)),
    }));
  }

  @SubscribeMessage(C2S.ALERT_ACK)
  onAlertAck(@ConnectedSocket() c: IoSocket, @MessageBody() body: unknown) {
    return runHandler(C2S.ALERT_ACK, c.data.user, AlertAckSchema, body, (p) => ({
      alert: this.alerts.acknowledge(p.alertId, c.data.user.id),
    }));
  }

  // ================================================================ SERVER -> CLIENT (dung pham vi)
  private subscribeDomainEvents() {
    const on = this.events.on.bind(this.events);
    this.unsubscribers.push(
      on("order.changed", ({ order }) => {
        this.server.to(DISPATCHERS).emit(S2C.ORDER_UPDATED, { order: this.view.forDispatcher(order) });
        this.server.to(userRoom(order.customerId)).emit(S2C.ORDER_UPDATED, { order: this.view.forCustomer(order) });
        if (this.view.isDriverOrder(order)) {
          this.server.to(userRoom(order.driverId!)).emit(S2C.ORDER_UPDATED, { order: this.view.forDriver(order) });
        }
      }),
      on("offer.opened", ({ order, driver }) => {
        this.server.to(userRoom(driver.id)).emit(S2C.OFFER_NEW, { offer: this.view.offer(order, driver) });
      }),
      on("offer.closed", ({ orderId, driverId, reason }) => {
        this.server.to(userRoom(driverId)).emit(S2C.OFFER_CLOSED, { orderId, reason });
      }),
      on("driver.changed", ({ driver }) => {
        this.server.to(DISPATCHERS).emit(S2C.DRIVER_UPDATED, { driver: this.view.driver(driver) });
      }),
      on("driver.moved", ({ driver }) => {
        this.server.to(DISPATCHERS).emit(S2C.DRIVER_UPDATED, { driver: this.view.driver(driver) });
        // Vi tri tai xe -> CHI khach co don dang duoc chinh tai xe nay giao.
        const order = driver.currentOrderId ? this.orders.get(driver.currentOrderId) : undefined;
        if (order && this.view.isTrackable(order) && driver.location) {
          this.server
            .to(userRoom(order.customerId))
            .emit(S2C.COURIER_LOCATION, { orderId: order.id, lat: driver.location.lat, lng: driver.location.lng, at: Date.now() });
        }
      }),
      on("alert.raised", ({ alert }) => {
        log("GATEWAY", `CANH BAO ${alert.kind}: ${alert.message}`);
        this.server.to(DISPATCHERS).emit(S2C.ALERT_RAISED, { alert });
        // Don tac -> trang thai "stuck" tren bang dieu phoi cung doi.
        const order = alert.orderId ? this.orders.get(alert.orderId) : undefined;
        if (order) this.server.to(DISPATCHERS).emit(S2C.ORDER_UPDATED, { order: this.view.forDispatcher(order) });
      }),
      on("alert.updated", ({ alert }) => {
        this.server.to(DISPATCHERS).emit(S2C.ALERT_UPDATED, { alertId: alert.id, status: alert.status, handledBy: alert.handledBy });
        const order = alert.orderId ? this.orders.get(alert.orderId) : undefined;
        if (order) this.server.to(DISPATCHERS).emit(S2C.ORDER_UPDATED, { order: this.view.forDispatcher(order) });
      }),
    );
  }

  /** So lieu tai nguyen de chung minh khong ro ri sau khi client mat ket noi. */
  resources() {
    const rooms = [...this.server.sockets.adapter.rooms.keys()].filter((r) => !this.server.sockets.sockets.has(r));
    return {
      sockets: this.server.sockets.sockets.size,
      rooms: rooms.length,
      sessionTimers: this.sessionTimers.size,
      ...this.dispatch.resources(),
      openAlerts: this.alerts.openCount,
      rejectedHandshakes: this.stats.rejectedHandshakes,
    };
  }

  onModuleDestroy() {
    this.sessionTimers.forEach(clearTimeout);
    this.unsubscribers.forEach((u) => u());
  }
}
