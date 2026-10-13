// GIAM SAT "DON TAC": dinh ky xem don nao o qua lau trong 1 giai doan -> canh bao dieu phoi.
// Don chay tiep (doi giai doan / giao xong / huy) -> canh bao tu dong ket thuc.
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { config } from "../config";
import { AlertService } from "./alert.service";
import { DomainEvents } from "./domain-events";
import { Order } from "./entities";
import { OrderRepository } from "./stores";

type Phase = "waiting" | "assigned" | "picked_up";

const PHASE_OF: Partial<Record<Order["status"], Phase>> = {
  pending: "waiting",
  offered: "waiting",
  assigned: "assigned",
  picked_up: "picked_up",
};

const LABEL: Record<Phase, string> = {
  waiting: "chờ tài xế",
  assigned: "tài xế đã nhận nhưng chưa lấy hàng",
  picked_up: "đang giao",
};

@Injectable()
export class MonitorService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly orders: OrderRepository,
    private readonly alerts: AlertService,
    events: DomainEvents,
  ) {
    // Don doi giai doan -> canh bao cua giai doan cu khong con dung nua.
    this.unsubscribe = events.on("order.changed", ({ order }) => {
      const current = PHASE_OF[order.status];
      (["waiting", "assigned", "picked_up"] as Phase[])
        .filter((p) => p !== current)
        .forEach((p) => this.alerts.resolve(this.key(order.id, p)));
    });
  }

  onModuleInit() {
    this.timer = setInterval(() => this.scan(), config.monitorIntervalMs);
  }

  scan(now = Date.now()) {
    for (const order of this.orders.active()) {
      const phase = PHASE_OF[order.status]!;
      const since = phase === "waiting" ? order.waitingSince : order.statusSince;
      const limit = { waiting: config.stuck.waitingMs, assigned: config.stuck.assignedMs, picked_up: config.stuck.pickedUpMs }[phase];
      if (now - since < limit) continue;
      this.alerts.raise(this.key(order.id, phase), "order_stuck", {
        orderId: order.id,
        driverId: order.driverId ?? undefined,
        message: `Đơn ${order.id} ${LABEL[phase]} đã ${Math.round((now - since) / 1000)}s (ngưỡng ${limit / 1000}s).`,
      });
    }
  }

  isStuck(orderId: string) {
    return (["waiting", "assigned", "picked_up"] as Phase[]).some((p) => this.alerts.hasOpen(this.key(orderId, p)));
  }

  private key(orderId: string, phase: Phase) {
    return `stuck:${orderId}:${phase}`;
  }

  onModuleDestroy() {
    clearInterval(this.timer);
    this.unsubscribe();
  }
}
