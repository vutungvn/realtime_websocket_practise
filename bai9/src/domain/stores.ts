// Kho du lieu trong bo nho (thuc te: DB). Chi luu/tim, khong chua quy tac nghiep vu.
import { Injectable } from "@nestjs/common";
import { USERS } from "../auth/users";
import { Place, Point } from "../contracts/models";
import { ACTIVE_STATUSES, Driver, Order } from "./entities";

@Injectable()
export class OrderRepository {
  private readonly orders = new Map<string, Order>();
  private seq = 0;

  create(customer: { id: string; name: string; phone: string }, pickup: Place, dropoff: Place, now = Date.now()): Order {
    const order: Order = {
      id: `O-${String(++this.seq).padStart(4, "0")}`,
      customerId: customer.id,
      customerName: customer.name,
      customerPhone: customer.phone,
      pickup,
      dropoff,
      status: "pending",
      driverId: null,
      offer: null,
      createdAt: now,
      statusSince: now,
      waitingSince: now,
      rejectedBy: new Set(),
      history: [{ status: "pending", at: now, by: customer.id }],
    };
    this.orders.set(order.id, order);
    return order;
  }

  get(id: string) {
    return this.orders.get(id);
  }

  all() {
    return [...this.orders.values()];
  }

  active() {
    return this.all().filter((o) => ACTIVE_STATUSES.includes(o.status));
  }

  ofCustomer(customerId: string) {
    return this.all().filter((o) => o.customerId === customerId);
  }

  /** Don cho tai xe, cu nhat truoc (cong bang). */
  pending() {
    return this.all()
      .filter((o) => o.status === "pending")
      .sort((a, b) => a.waitingSince - b.waitingSince);
  }
}

@Injectable()
export class DriverRegistry {
  private readonly drivers = new Map<string, Driver>(
    USERS.filter((u) => u.role === "driver").map((u) => [
      u.id,
      {
        id: u.id,
        name: u.name,
        vehicle: u.vehicle ?? "",
        onShift: false,
        presence: "offline",
        activity: "idle",
        location: u.home ? { ...u.home } : null,
        lastSeenAt: null,
        lastLocationAt: 0,
        currentOrderId: null,
        offeredOrderId: null,
        sockets: new Set(),
      } satisfies Driver,
    ]),
  );

  get(id: string) {
    return this.drivers.get(id);
  }

  all() {
    return [...this.drivers.values()];
  }

  /** Tai xe nhan duoc don moi: dang ket noi + dang ca + khong co viec. */
  available() {
    return this.all().filter((d) => d.presence === "online" && d.onShift && d.activity === "idle");
  }

  socketCount() {
    return this.all().reduce((n, d) => n + d.sockets.size, 0);
  }
}

/** Khoang cach duong chim bay (km). */
export function distanceKm(a: Point, b: Point) {
  const R = 6371;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
