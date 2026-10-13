// CAT DU LIEU THEO VAI: noi DUY NHAT quyet dinh moi vai thay nhung truong nao.
// Tang nghiep vu giu thuc the day du; ra khoi server luon di qua day.
import { Injectable } from "@nestjs/common";
import { findUser } from "../auth/users";
import {
  CustomerOrderView,
  DispatcherOrderView,
  DriverOrderView,
  DriverView,
  OfferView,
  Snapshot,
  SessionUser,
} from "../contracts/models";
import { AlertService } from "../domain/alert.service";
import { Driver, Order } from "../domain/entities";
import { MonitorService } from "../domain/monitor.service";
import { distanceKm, DriverRegistry, OrderRepository } from "../domain/stores";

const maskPhone = (p: string) => (p.length > 4 ? `${p.slice(0, 3)}****${p.slice(-3)}` : "****");

@Injectable()
export class Projector {
  constructor(
    private readonly orders: OrderRepository,
    private readonly drivers: DriverRegistry,
    private readonly alerts: AlertService,
    private readonly monitor: MonitorService,
  ) {}

  forDispatcher(o: Order): DispatcherOrderView {
    const d = o.driverId ? this.drivers.get(o.driverId) : undefined;
    return {
      id: o.id,
      status: o.status,
      customer: { id: o.customerId, name: o.customerName, phone: o.customerPhone },
      driver: d ? { id: d.id, name: d.name } : null,
      pickup: o.pickup,
      dropoff: o.dropoff,
      createdAt: o.createdAt,
      statusSince: o.statusSince,
      rejectedBy: [...o.rejectedBy],
      stuck: this.monitor.isStuck(o.id),
      history: o.history,
    };
  }

  forCustomer(o: Order): CustomerOrderView {
    // Khach chi biet ten + xe cua tai xe KHI tai xe da nhan don (khong lo ai dang duoc moi / da tu choi).
    const visibleDriver = ["assigned", "picked_up", "delivered"].includes(o.status) && o.driverId ? this.drivers.get(o.driverId) : undefined;
    return {
      id: o.id,
      status: o.status === "offered" ? "pending" : o.status, // "dang moi tai xe" la chuyen noi bo
      pickup: o.pickup,
      dropoff: o.dropoff,
      createdAt: o.createdAt,
      statusSince: o.statusSince,
      driver: visibleDriver ? { name: visibleDriver.name, vehicle: visibleDriver.vehicle } : null,
    };
  }

  forDriver(o: Order): DriverOrderView {
    return {
      id: o.id,
      status: o.status,
      pickup: o.pickup,
      dropoff: o.dropoff,
      customer: { name: o.customerName, phoneMasked: maskPhone(o.customerPhone) },
    };
  }

  offer(o: Order, d: Driver): OfferView {
    return {
      orderId: o.id,
      pickup: o.pickup,
      dropoff: o.dropoff,
      distanceKm: d.location ? Math.round(distanceKm(d.location, o.pickup) * 10) / 10 : 0,
      expiresAt: o.offer?.expiresAt ?? Date.now(),
      byDispatcher: o.offer?.byDispatcher ?? false,
    };
  }

  driver(d: Driver): DriverView {
    return {
      id: d.id,
      name: d.name,
      vehicle: d.vehicle,
      onShift: d.onShift,
      presence: d.presence,
      activity: d.activity,
      location: d.location,
      lastSeenAt: d.lastSeenAt,
      currentOrderId: d.currentOrderId ?? d.offeredOrderId,
    };
  }

  /** Don nao duoc gui cho tai xe nao (chi tai xe dang thuc hien don). */
  isDriverOrder(o: Order) {
    return !!o.driverId && ["assigned", "picked_up", "delivered"].includes(o.status);
  }

  /** Khach duoc thay vi tri tai xe CHI khi tai xe dang thuc hien don cua chinh khach do. */
  isTrackable(o: Order) {
    return o.status === "assigned" || o.status === "picked_up";
  }

  snapshot(user: SessionUser): Snapshot {
    if (user.role === "customer") {
      return { role: "customer", orders: this.orders.ofCustomer(user.id).map((o) => this.forCustomer(o)) };
    }
    if (user.role === "driver") {
      const d = this.drivers.get(user.id)!;
      const current = d.currentOrderId ? this.orders.get(d.currentOrderId) : undefined;
      const offered = d.offeredOrderId ? this.orders.get(d.offeredOrderId) : undefined;
      return {
        role: "driver",
        driver: this.driver(d),
        currentOrder: current ? this.forDriver(current) : null,
        offer: offered ? this.offer(offered, d) : null,
      };
    }
    return {
      role: "dispatcher",
      orders: this.orders.all().map((o) => this.forDispatcher(o)),
      drivers: this.drivers.all().map((d) => this.driver(d)),
      alerts: this.alerts.list(),
    };
  }

  static displayName(userId: string) {
    return findUser(userId)?.name ?? userId;
  }
}
