// Gia lap hoat dong kho: cao diem ~5s co thay doi, ban dem ~2 phut moi co 1 thay doi.
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { log } from "../log";
import { config, SimMode } from "./config";
import { DashboardStore } from "./dashboard.store";

@Injectable()
export class SimulatorService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  mode: SimMode = config.simMode;

  constructor(private readonly store: DashboardStore) {}

  onModuleInit() {
    this.setMode(this.mode);
  }

  setMode(mode: SimMode) {
    this.mode = mode;
    clearTimeout(this.timer);
    log("SIM", `che do: ${mode}`);
    this.loop();
  }

  private loop() {
    if (this.mode === "off") return;
    const base = this.mode === "peak" ? config.peakIntervalMs : config.nightIntervalMs;
    const wait = base * (0.8 + Math.random() * 0.4);
    this.timer = setTimeout(() => {
      this.tick();
      this.loop();
    }, wait);
  }

  private tick() {
    const orders = this.mode === "peak" ? 1 + Math.floor(Math.random() * 3) : 1;
    for (let i = 0; i < orders; i++) this.store.recordOrder(Math.round(50_000 + Math.random() * 450_000));

    if (this.mode === "peak") {
      const items = this.store.stockList();
      const item = items[Math.floor(Math.random() * items.length)];
      // Ban hang lam giam ton; thinh thoang nhap them hang.
      const restock = item.qty <= item.threshold && Math.random() < 0.3;
      this.store.setStock(item.sku, restock ? item.qty + 30 : item.qty - (1 + Math.floor(Math.random() * 3)));
    }
  }

  onModuleDestroy() {
    clearTimeout(this.timer);
  }
}
