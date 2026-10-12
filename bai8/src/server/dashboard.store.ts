// Trang thai bang dieu khien + nhat ky su kien (de phat bu khi client noi lai).
//
// Hai loai du lieu co ban chat khac nhau:
//   - SO LIEU (don moi, doanh thu): chi can GIA TRI MOI NHAT -> gop (throttle), mat 1 ban cap nhat khong sao.
//   - CANH BAO TON KHO: tung su kien deu quan trong -> phat ngay, khong gop, phai phat bu neu client lo.
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { log } from "../log";
import { config } from "./config";

export type AlertLevel = "low" | "out";

export interface StockItem {
  sku: string;
  name: string;
  qty: number;
  threshold: number; // qty <= threshold -> sap het
}

export interface StockAlert {
  alertId: string;
  sku: string;
  name: string;
  qty: number;
  level: AlertLevel;
  createdAt: number; // epoch ms luc phat sinh -> do "toi tay nhan vien trong 10s"
}

export interface Metrics {
  newOrders: number;
  revenue: number;
  lastOrderAt: number | null;
}

export interface DashboardState extends Metrics {
  alerts: StockAlert[]; // canh bao dang hieu luc
}

export type StreamEventType = "metrics" | "stock-alert" | "stock-cleared";

export interface StreamEvent {
  id: string; // "<bootId>-<seq>" -> server khoi dong lai thi bootId doi
  seq: number;
  type: StreamEventType;
  data: unknown;
}

const INITIAL_STOCK: StockItem[] = [
  { sku: "TN-BT01", name: "Tai nghe Bluetooth", qty: 40, threshold: 5 },
  { sku: "SAC-20W", name: "Cu sac nhanh 20W", qty: 25, threshold: 5 },
  { sku: "OP-IP15", name: "Op lung iPhone 15", qty: 12, threshold: 3 },
  { sku: "CAP-C1M", name: "Cap USB-C 1m", qty: 60, threshold: 10 },
];

@Injectable()
export class DashboardStore implements OnModuleDestroy {
  /** Doi moi lan server khoi dong -> Last-Event-ID cua phien truoc khong con dung. */
  readonly bootId = Date.now().toString(36);
  private seq = 0;
  /** Dem moi lan trang thai doi (cho ETag cua polling) - khac seq vi so lieu duoc gop. */
  private rev = 0;
  private readonly events: StreamEvent[] = [];
  private readonly listeners = new Set<(e: StreamEvent) => void>();

  private metrics: Metrics = { newOrders: 0, revenue: 0, lastOrderAt: null };
  private readonly stock = new Map(INITIAL_STOCK.map((s) => [s.sku, { ...s }]));
  private readonly activeAlerts = new Map<string, StockAlert>();
  private alertNo = 0;

  private lastMetricsEmit = 0;
  private metricsTimer?: NodeJS.Timeout;

  subscribe(fn: (e: StreamEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get lastEventId() {
    return `${this.bootId}-${this.seq}`;
  }

  get etag() {
    return `"${this.bootId}-${this.rev}"`;
  }

  snapshot(): DashboardState {
    return { ...this.metrics, alerts: [...this.activeAlerts.values()] };
  }

  stockList() {
    return [...this.stock.values()];
  }

  // ---------------------------------------------------------------- nghiep vu
  recordOrder(amount: number) {
    this.metrics.newOrders++;
    this.metrics.revenue += amount;
    this.metrics.lastOrderAt = Date.now();
    this.rev++;
    this.scheduleMetrics();
  }

  /** Dat lai ton kho. Vuot nguong -> canh bao NGAY; hoi phuc -> go canh bao. */
  setStock(sku: string, qty: number): StockAlert | null {
    const item = this.stock.get(sku);
    if (!item) return null;
    item.qty = Math.max(0, Math.floor(qty));
    this.rev++;

    const level: AlertLevel | null = item.qty === 0 ? "out" : item.qty <= item.threshold ? "low" : null;
    const current = this.activeAlerts.get(sku);
    if (level && current?.level !== level) {
      const alert: StockAlert = { alertId: `AL-${++this.alertNo}`, sku, name: item.name, qty: item.qty, level, createdAt: Date.now() };
      this.activeAlerts.set(sku, alert);
      this.emit("stock-alert", alert);
      return alert;
    }
    if (!level && current) {
      this.activeAlerts.delete(sku);
      this.emit("stock-cleared", { sku, name: item.name, qty: item.qty, clearedAt: Date.now() });
    }
    return null;
  }

  // ---------------------------------------------------------------- phat bu
  /**
   * Su kien sau `lastEventId` de phat bu. Tra ve null neu KHONG the phat bu chinh xac
   * (id cua lan khoi dong khac, id la, hoac qua cu da bi day khoi bo dem) -> phai gui snapshot.
   */
  eventsAfter(lastEventId: string | null): StreamEvent[] | null {
    if (!lastEventId) return null;
    const m = /^([a-z0-9]+)-(\d+)$/.exec(lastEventId);
    if (!m || m[1] !== this.bootId) return null;
    const after = Number(m[2]);
    if (after > this.seq) return null;
    if (after === this.seq) return [];
    const oldest = this.events[0]?.seq ?? this.seq + 1;
    if (after + 1 < oldest) return null; // da roi khoi bo dem
    return this.events.filter((e) => e.seq > after);
  }

  // ---------------------------------------------------------------- noi bo
  /** Gop so lieu: toi da 1 su kien / metricsThrottleMs, luon mang gia tri MOI NHAT. */
  private scheduleMetrics() {
    if (this.metricsTimer) return;
    const wait = Math.max(0, this.lastMetricsEmit + config.metricsThrottleMs - Date.now());
    this.metricsTimer = setTimeout(() => {
      this.metricsTimer = undefined;
      this.lastMetricsEmit = Date.now();
      this.emit("metrics", { ...this.metrics });
    }, wait);
  }

  private emit(type: StreamEventType, data: unknown) {
    const seq = ++this.seq;
    const event: StreamEvent = { id: `${this.bootId}-${seq}`, seq, type, data };
    this.events.push(event);
    if (this.events.length > config.replayBufferSize) this.events.shift();
    if (type !== "metrics") log("SERVER", `su kien #${seq} ${type}: ${JSON.stringify(data)}`);
    this.listeners.forEach((fn) => fn(event));
  }

  onModuleDestroy() {
    clearTimeout(this.metricsTimer);
  }
}
