import { Body, Controller, Get, Headers, HttpCode, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { config, SimMode, watchdogMs } from "./config";
import { DashboardStore } from "./dashboard.store";
import { SimulatorService } from "./simulator.service";
import { StreamHub } from "./stream.hub";

/** Trang thai van hanh dung chung (bao tri -> tra 503 de thu phuc hoi phia client). */
export const runtime = { maintenance: false, pollRequests: 0, poll304: 0 };

// ---------------------------------------------------------------- GIAI PHAP CHON: SSE
@Controller()
export class StreamController {
  constructor(private readonly hub: StreamHub) {}

  /**
   * GET /stream
   *   Header Last-Event-ID : trinh duyet tu gui khi tu noi lai
   *   ?lastEventId=        : client gui khi TU TAO LAI EventSource (khong dat duoc header)
   *   ?hb=0                : tat nhip tim (chi de chung minh bo can bang tai cat ket noi)
   */
  @Get("stream")
  stream(
    @Req() req: Request,
    @Res() res: Response,
    @Headers("last-event-id") headerId?: string,
    @Query("lastEventId") queryId?: string,
    @Query("hb") hb?: string,
  ) {
    if (runtime.maintenance) {
      res.status(503).json({ error: "Dang bao tri" });
      return;
    }
    this.hub.attach(req, res, headerId || queryId || null, hb !== "0");
  }
}

// ---------------------------------------------------------------- GIAI PHAP SO SANH: polling
@Controller("api")
export class ApiController {
  constructor(
    private readonly store: DashboardStore,
    private readonly hub: StreamHub,
  ) {}

  /** Polling co ETag: khong doi -> 304 rong (re hon, nhung VAN ton 1 request moi chu ky). */
  @Get("snapshot")
  snapshot(@Headers("if-none-match") inm: string | undefined, @Res() res: Response) {
    runtime.pollRequests++;
    if (runtime.maintenance) {
      res.status(503).json({ error: "Dang bao tri" });
      return;
    }
    res.setHeader("ETag", this.store.etag);
    res.setHeader("Cache-Control", "no-cache");
    if (inm === this.store.etag) {
      runtime.poll304++;
      res.status(304).end();
      return;
    }
    res.json({ state: this.store.snapshot(), at: Date.now() });
  }

  @Get("config")
  clientConfig() {
    return { heartbeatMs: config.heartbeatMs, watchdogMs: watchdogMs(), retryMs: config.retryMs };
  }

  @Get("stats")
  stats() {
    return {
      ...this.hub.stats,
      openConnections: this.hub.openConnections,
      pollRequests: runtime.pollRequests,
      poll304: runtime.poll304,
      maintenance: runtime.maintenance,
      lastEventId: this.store.lastEventId,
    };
  }
}

// ---------------------------------------------------------------- dieu khien de test nghiep vu
@Controller("admin")
export class AdminController {
  constructor(
    private readonly store: DashboardStore,
    private readonly sim: SimulatorService,
  ) {}

  @Post("order")
  @HttpCode(200)
  order(@Body() body: { amount?: number; count?: number }) {
    const count = Math.min(Math.max(Number(body?.count) || 1, 1), 1000);
    for (let i = 0; i < count; i++) this.store.recordOrder(Number(body?.amount) || 199_000);
    return this.store.snapshot();
  }

  @Post("stock")
  @HttpCode(200)
  stock(@Body() body: { sku?: string; qty?: number }) {
    const alert = this.store.setStock(String(body?.sku), Number(body?.qty));
    return { alert, stock: this.store.stockList() };
  }

  @Get("stock")
  stockList() {
    return this.store.stockList();
  }

  @Post("mode")
  @HttpCode(200)
  mode(@Body() body: { mode?: SimMode }) {
    if (body?.mode && ["peak", "night", "off"].includes(body.mode)) this.sim.setMode(body.mode);
    return { mode: this.sim.mode };
  }

  @Get("mode")
  getMode() {
    return { mode: this.sim.mode };
  }

  @Post("maintenance")
  @HttpCode(200)
  maintenance(@Body() body: { on?: boolean }) {
    runtime.maintenance = !!body?.on;
    return { maintenance: runtime.maintenance };
  }
}
