// BUS SU KIEN NOI BO: tang nghiep vu bao "dieu gi vua xay ra", khong biet ai nghe / gui cho ai.
// Gateway dang ky nghe va tu quyet dinh pham vi phat (ai duoc nhan gi).
import { Injectable, Logger } from "@nestjs/common";
import { EventEmitter } from "events";
import { OfferCloseReason } from "../contracts/events";
import { Alert, OrderStatus } from "../contracts/models";
import { Driver, Order } from "./entities";

export interface DomainEventMap {
  "order.changed": { order: Order; previousStatus: OrderStatus | null };
  "offer.opened": { order: Order; driver: Driver };
  "offer.closed": { orderId: string; driverId: string; reason: OfferCloseReason };
  "driver.changed": { driver: Driver };
  "driver.moved": { driver: Driver };
  "alert.raised": { alert: Alert };
  "alert.updated": { alert: Alert };
}

@Injectable()
export class DomainEvents {
  private readonly emitter = new EventEmitter();
  private readonly logger = new Logger("DomainEvents");

  emit<K extends keyof DomainEventMap>(name: K, payload: DomainEventMap[K]) {
    this.emitter.emit(name, payload);
  }

  /** Loi trong 1 listener (vd gui socket that bai) KHONG duoc lam hong luong nghiep vu dang chay. */
  on<K extends keyof DomainEventMap>(name: K, listener: (payload: DomainEventMap[K]) => void) {
    const safe = (payload: DomainEventMap[K]) => {
      try {
        listener(payload);
      } catch (err) {
        this.logger.error(`listener cua ${name} loi: ${(err as Error).message}`);
      }
    };
    this.emitter.on(name, safe);
    return () => this.emitter.off(name, safe);
  }
}
