import { Injectable } from "@nestjs/common";

export interface Order {
  seq: number;
  orderId: string;
  zone: string;
  address: string;
  createdAt: string;
}

const MAX_RECENT = 500;

/**
 * Luu cac don gan day theo so thu tu tang dan (seq).
 * Khi tai xe noi lai, client gui seq cuoi cung da dong bo -> server tra lai cac don bi lo
 * trong luc mat mang (don phat vao room luc tai xe khong co mat se mat han neu khong co buoc nay).
 */
@Injectable()
export class OrderStore {
  private seq = 0;
  private readonly recent: Order[] = [];

  create(zone: string, address: string): Order {
    const seq = ++this.seq;
    const order: Order = {
      seq,
      orderId: `ORD-${String(seq).padStart(4, "0")}`,
      zone,
      address,
      createdAt: new Date().toISOString(),
    };
    this.recent.push(order);
    if (this.recent.length > MAX_RECENT) this.recent.shift();
    return order;
  }

  get currentSeq() {
    return this.seq;
  }

  since(seq: number, zones: string[]): Order[] {
    return this.recent.filter((o) => o.seq > seq && zones.includes(o.zone));
  }
}
