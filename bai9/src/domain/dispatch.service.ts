// NGHIEP VU DIEU PHOI: vong doi don, moi tai xe, het han loi moi, can thiep cua dieu phoi, tai xe mat ket noi.
// Khong biet gi ve socket: chi doi trang thai + phat DomainEvents. Moi timer deu nam trong 2 Map de dem/don duoc.
import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { findUser } from "../auth/users";
import { config } from "../config";
import { OfferCloseReason } from "../contracts/events";
import { OrderStatus, Point } from "../contracts/models";
import {
  DispatchAssignInput,
  DispatchCancelInput,
  OfferRespondInput,
  OrderPlaceInput,
  OrderProgressInput,
} from "../contracts/schemas";
import { AlertService } from "./alert.service";
import { DomainEvents } from "./domain-events";
import { Driver, Order } from "./entities";
import { DomainError } from "./errors";
import { distanceKm, DriverRegistry, OrderRepository } from "./stores";

@Injectable()
export class DispatchService implements OnModuleDestroy {
  private readonly logger = new Logger("Dispatch");
  private readonly offerTimers = new Map<string, NodeJS.Timeout>(); // orderId -> het han loi moi
  private readonly graceTimers = new Map<string, NodeJS.Timeout>(); // driverId -> het an han mat ket noi

  constructor(
    private readonly orders: OrderRepository,
    private readonly drivers: DriverRegistry,
    private readonly alerts: AlertService,
    private readonly events: DomainEvents,
  ) {}

  // ================================================================ KHACH HANG
  placeOrder(customerId: string, input: OrderPlaceInput): Order {
    const user = findUser(customerId);
    if (!user || user.role !== "customer") throw new DomainError("FORBIDDEN", "Chỉ khách hàng mới đặt được đơn.");
    const order = this.orders.create({ id: user.id, name: user.name, phone: user.phone ?? "" }, input.pickup, input.dropoff);
    this.logger.log(`${order.id} moi tao boi ${customerId}`);
    this.changed(order, null);
    this.dispatch(order);
    return order;
  }

  // ================================================================ TAI XE
  setShift(driverId: string, onShift: boolean): Driver {
    const driver = this.mustDriver(driverId);
    if (!onShift && driver.activity === "busy") {
      throw new DomainError("CONFLICT", "Bạn đang có đơn, hãy giao xong trước khi nghỉ ca.");
    }
    driver.onShift = onShift;
    if (!onShift && driver.offeredOrderId) this.closeOffer(this.orders.get(driver.offeredOrderId)!, "rejected");
    this.events.emit("driver.changed", { driver });
    if (onShift) this.dispatchPending();
    return driver;
  }

  /** Tra ve false neu bi bo qua vi gui qua day (chong spam vi tri). */
  updateLocation(driverId: string, point: Point, now = Date.now()): boolean {
    const driver = this.mustDriver(driverId);
    if (now - driver.lastLocationAt < config.locationMinIntervalMs) return false;
    driver.location = { lat: point.lat, lng: point.lng };
    driver.lastLocationAt = now;
    driver.lastSeenAt = now;
    this.events.emit("driver.moved", { driver });
    return true;
  }

  respondOffer(driverId: string, { orderId, accept }: OfferRespondInput): Order | null {
    const order = this.mustOrder(orderId);
    if (!order.offer) throw new DomainError("CONFLICT", "Lời mời đã hết hiệu lực.");
    if (order.offer.driverId !== driverId) throw new DomainError("FORBIDDEN", "Đơn này không được mời bạn.");

    if (!accept) {
      this.closeOffer(order, "rejected");
      return null;
    }
    const driver = this.mustDriver(driverId);
    this.clearOfferTimer(order.id);
    order.offer = null;
    driver.offeredOrderId = null;
    driver.activity = "busy";
    driver.currentOrderId = order.id;
    this.setStatus(order, "assigned", driverId);
    this.events.emit("offer.closed", { orderId: order.id, driverId, reason: "accepted" });
    this.events.emit("driver.changed", { driver });
    return order;
  }

  progress(driverId: string, { orderId, status }: OrderProgressInput): Order {
    const order = this.mustOrder(orderId);
    if (order.driverId !== driverId || !["assigned", "picked_up"].includes(order.status)) {
      throw new DomainError("FORBIDDEN", "Đơn này không do bạn phụ trách.");
    }
    const next: Record<string, OrderStatus> = { assigned: "picked_up", picked_up: "delivered" };
    if (next[order.status] !== status) {
      throw new DomainError("CONFLICT", `Không thể chuyển đơn từ "${order.status}" sang "${status}".`);
    }
    this.setStatus(order, status, driverId);
    if (status === "delivered") {
      const driver = this.mustDriver(driverId);
      driver.activity = "idle";
      driver.currentOrderId = null;
      this.events.emit("driver.changed", { driver });
      this.dispatchPending();
    }
    return order;
  }

  // ================================================================ DIEU PHOI VIEN CAN THIEP
  /** Giao (lai) don cho tai xe chi dinh. Tai xe van phai bam nhan - co the ho dang khong nhan duoc. */
  assign(dispatcherId: string, { orderId, driverId }: DispatchAssignInput): Order {
    const order = this.mustOrder(orderId);
    if (!["pending", "offered", "assigned"].includes(order.status)) {
      throw new DomainError("CONFLICT", `Đơn đang "${order.status}", không thể giao cho tài xế khác.`);
    }
    const driver = this.mustDriver(driverId);
    if (order.driverId === driverId) throw new DomainError("CONFLICT", "Đơn đang ở chính tài xế này.");
    if (driver.presence !== "online" || !driver.onShift) {
      throw new DomainError("DRIVER_UNAVAILABLE", `Tài xế ${driver.name} đang ${driver.presence === "online" ? "nghỉ ca" : "mất kết nối"}.`);
    }
    if (driver.activity !== "idle") throw new DomainError("DRIVER_UNAVAILABLE", `Tài xế ${driver.name} đang bận.`);

    this.release(order, "revoked", dispatcherId);
    order.rejectedBy.delete(driverId);
    this.openOffer(order, driver, dispatcherId);
    this.logger.log(`${dispatcherId} giao ${order.id} cho ${driverId}`);
    return order;
  }

  cancel(dispatcherId: string, { orderId, reason }: DispatchCancelInput): Order {
    const order = this.mustOrder(orderId);
    if (!["pending", "offered", "assigned"].includes(order.status)) {
      throw new DomainError("CONFLICT", `Đơn đang "${order.status}", không thể huỷ.`);
    }
    this.release(order, "cancelled", dispatcherId);
    this.setStatus(order, "cancelled", `${dispatcherId}: ${reason}`);
    this.dispatchPending(); // tai xe vua duoc giai phong co the nhan don khac
    return order;
  }

  // ================================================================ KET NOI CUA TAI XE
  driverConnected(driverId: string, socketId: string) {
    const driver = this.mustDriver(driverId);
    driver.sockets.add(socketId);
    clearTimeout(this.graceTimers.get(driverId));
    this.graceTimers.delete(driverId);
    driver.presence = "online";
    driver.lastSeenAt = Date.now();
    this.alerts.resolve(`driver_lost:${driverId}`);
    this.events.emit("driver.changed", { driver });
    if (driver.onShift && driver.activity === "idle") this.dispatchPending();
    return driver;
  }

  /** Socket cua tai xe dong (ke ca dot ngot). Chi xu ly khi KHONG con socket nao cua tai xe do. */
  driverDisconnected(driverId: string, socketId: string) {
    const driver = this.drivers.get(driverId);
    if (!driver || !driver.sockets.delete(socketId) || driver.sockets.size > 0) return;

    driver.presence = "lost";
    this.events.emit("driver.changed", { driver });
    // Loi moi la viec gap: khong cho an han, chuyen ngay cho tai xe khac.
    if (driver.offeredOrderId) this.closeOffer(this.orders.get(driver.offeredOrderId)!, "driver_lost");

    this.graceTimers.set(
      driverId,
      setTimeout(() => this.driverGone(driverId), config.driverGraceMs),
    );
  }

  private driverGone(driverId: string) {
    this.graceTimers.delete(driverId);
    const driver = this.drivers.get(driverId);
    if (!driver || driver.sockets.size > 0) return;
    driver.presence = "offline";
    this.events.emit("driver.changed", { driver });
    if (driver.currentOrderId) {
      const order = this.orders.get(driver.currentOrderId)!;
      this.alerts.raise(`driver_lost:${driverId}`, "driver_lost", {
        orderId: order.id,
        driverId,
        message: `Tài xế ${driver.name} mất kết nối quá ${config.driverGraceMs / 1000}s khi đang ${order.status === "picked_up" ? "giao" : "đi lấy"} đơn ${order.id}.`,
      });
    }
  }

  // ================================================================ GIAO DON TU DONG
  /** Moi tai xe ranh GAN DIEM LAY HANG NHAT (bo qua nguoi da tu choi don nay). */
  private dispatch(order: Order) {
    if (order.status !== "pending") return;
    const candidates = this.drivers.available().filter((d) => !order.rejectedBy.has(d.id));
    if (candidates.length === 0) return;
    const nearest = candidates
      .map((d) => ({ d, km: d.location ? distanceKm(d.location, order.pickup) : Infinity }))
      .sort((a, b) => a.km - b.km)[0].d;
    this.openOffer(order, nearest, "auto");
  }

  private dispatchPending() {
    for (const order of this.orders.pending()) {
      if (this.drivers.available().length === 0) return;
      this.dispatch(order);
    }
  }

  private openOffer(order: Order, driver: Driver, by: string) {
    order.offer = { driverId: driver.id, expiresAt: Date.now() + config.offerTimeoutMs, byDispatcher: by !== "auto" };
    driver.activity = "offered";
    driver.offeredOrderId = order.id;
    this.setStatus(order, "offered", by, driver.id);
    this.offerTimers.set(
      order.id,
      setTimeout(() => this.closeOffer(order, "expired"), config.offerTimeoutMs),
    );
    this.events.emit("offer.opened", { order, driver });
    this.events.emit("driver.changed", { driver });
  }

  /** Dong loi moi chua duoc nhan; don quay ve hang cho va duoc moi tai xe khac (tru khi bi huy/thu hoi). */
  private closeOffer(order: Order, reason: OfferCloseReason) {
    if (!order.offer) return;
    const driverId = order.offer.driverId;
    this.clearOfferTimer(order.id);
    order.offer = null;
    this.freeDriver(driverId, order.id);
    if (reason === "rejected" || reason === "expired" || reason === "driver_lost") order.rejectedBy.add(driverId);
    this.events.emit("offer.closed", { orderId: order.id, driverId, reason });

    if (reason === "revoked" || reason === "cancelled") return; // nguoi goi tu xu ly buoc tiep theo
    this.setStatus(order, "pending", `system:${reason}`, null);
    this.dispatch(order);
    this.dispatchPending(); // tai xe vua tu choi co the hop voi don khac
  }

  /** Go don khoi tai xe hien tai (dang duoc moi hoac da nhan). */
  private release(order: Order, reason: "revoked" | "cancelled", by: string) {
    const wasAssigned = order.status === "assigned";
    if (order.status === "offered") {
      this.closeOffer(order, reason);
    } else if (order.status === "assigned" && order.driverId) {
      const driverId = order.driverId;
      this.freeDriver(driverId, order.id);
      this.alerts.resolve(`driver_lost:${driverId}`);
      this.events.emit("offer.closed", { orderId: order.id, driverId, reason });
    }
    // Don da co tai xe nhan ma bi thu hoi -> bat dau mot luot "cho tai xe" moi.
    // Don dang cho thi giu moc cu: khach da cho bao lau van tinh tiep.
    if (wasAssigned) order.waitingSince = Date.now();
    if (order.status !== "pending") this.setStatus(order, "pending", by, null);
  }

  private freeDriver(driverId: string, orderId: string) {
    const driver = this.drivers.get(driverId);
    if (!driver) return;
    if (driver.offeredOrderId === orderId) driver.offeredOrderId = null;
    if (driver.currentOrderId === orderId) driver.currentOrderId = null;
    if (!driver.offeredOrderId && !driver.currentOrderId) driver.activity = "idle";
    this.events.emit("driver.changed", { driver });
  }

  // ================================================================ tien ich
  private setStatus(order: Order, status: OrderStatus, by: string, driverId: string | null = order.driverId) {
    const previous = order.status;
    order.status = status;
    order.driverId = driverId;
    order.statusSince = Date.now();
    order.history.push({ status, at: order.statusSince, by });
    this.changed(order, previous);
  }

  private changed(order: Order, previousStatus: OrderStatus | null) {
    this.events.emit("order.changed", { order, previousStatus });
  }

  private clearOfferTimer(orderId: string) {
    clearTimeout(this.offerTimers.get(orderId));
    this.offerTimers.delete(orderId);
  }

  private mustOrder(id: string) {
    const order = this.orders.get(id);
    if (!order) throw new DomainError("NOT_FOUND", `Không tìm thấy đơn ${id}.`);
    return order;
  }

  private mustDriver(id: string) {
    const driver = this.drivers.get(id);
    if (!driver) throw new DomainError("NOT_FOUND", `Không tìm thấy tài xế ${id}.`);
    return driver;
  }

  resources() {
    return { offerTimers: this.offerTimers.size, graceTimers: this.graceTimers.size, driverSockets: this.drivers.socketCount() };
  }

  onModuleDestroy() {
    this.offerTimers.forEach(clearTimeout);
    this.graceTimers.forEach(clearTimeout);
  }
}
