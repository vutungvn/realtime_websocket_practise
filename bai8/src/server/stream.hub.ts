// SSE HUB: giu cac ket noi text/event-stream, phat su kien, nhip tim, phat bu.
//
// Dinh dang 1 su kien SSE tren day:
//   id: k3x9-42            <- trinh duyet nho lai, tu gui lai qua header Last-Event-ID khi noi lai
//   event: stock-alert     <- ten su kien (addEventListener("stock-alert"))
//   data: {...json...}
//   <dong trong>
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import type { Request, Response } from "express";
import { log } from "../log";
import { config } from "./config";
import { DashboardStore, StreamEvent } from "./dashboard.store";

interface SseClient {
  no: number;
  res: Response;
  heartbeat?: NodeJS.Timeout;
}

@Injectable()
export class StreamHub implements OnModuleDestroy {
  private readonly clients = new Set<SseClient>();
  private nextNo = 0;
  readonly stats = { connectionsTotal: 0, resumed: 0, snapshots: 0, heartbeatsSent: 0, eventsSent: 0 };
  private readonly unsubscribe: () => void;

  constructor(private readonly store: DashboardStore) {
    this.unsubscribe = store.subscribe((e) => this.broadcast(e));
  }

  get openConnections() {
    return this.clients.size;
  }

  attach(req: Request, res: Response, lastEventId: string | null, withHeartbeat: boolean) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform", // proxy/CDN khong duoc cache hay nen (nen = bi dem lai)
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // nginx: khong buffer, day tung su kien ra ngay
    });
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true, 30_000);

    const client: SseClient = { no: ++this.nextNo, res };
    this.clients.add(client);
    this.stats.connectionsTotal++;

    // Bao trinh duyet: rot ket noi thi cho retryMs roi tu noi lai.
    res.write(`retry: ${config.retryMs}\n\n`);

    const replay = this.store.eventsAfter(lastEventId);
    if (replay) {
      // Noi lai trong khoang bo dem con giu: phat bu DUNG nhung gi bi lo, khong thua khong thieu.
      this.stats.resumed++;
      replay.forEach((e) => this.send(client, e));
      log("SERVER", `+ man hinh #${client.no} NOI LAI tu ${lastEventId}: phat bu ${replay.length} su kien (dang mo ${this.clients.size})`);
    } else {
      // Lan dau / server vua khoi dong lai / mat qua lau: gui toan bo trang thai hien tai.
      this.stats.snapshots++;
      this.write(client, this.store.lastEventId, "snapshot", this.store.snapshot());
      const why = lastEventId ? `Last-Event-ID ${lastEventId} khong phat bu duoc` : "ket noi moi";
      log("SERVER", `+ man hinh #${client.no} nhan SNAPSHOT (${why}) (dang mo ${this.clients.size})`);
    }

    if (withHeartbeat) {
      // Nhip tim la su kien co ten (khong phai comment ":") de JS phia client nhin thay -> watchdog.
      // Khong co dong `id:` -> khong lam xe dich Last-Event-ID.
      client.heartbeat = setInterval(() => {
        this.stats.heartbeatsSent++;
        res.write(`event: heartbeat\ndata: ${Date.now()}\n\n`);
      }, config.heartbeatMs);
    }

    req.on("close", () => {
      clearInterval(client.heartbeat);
      this.clients.delete(client);
      log("SERVER", `- man hinh #${client.no} dong ket noi (con ${this.clients.size})`);
    });
  }

  private broadcast(e: StreamEvent) {
    this.clients.forEach((c) => this.send(c, e));
  }

  private send(c: SseClient, e: StreamEvent) {
    this.write(c, e.id, e.type, e.data);
  }

  private write(c: SseClient, id: string, type: string, data: unknown) {
    this.stats.eventsSent++;
    c.res.write(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  onModuleDestroy() {
    this.unsubscribe();
    this.clients.forEach((c) => {
      clearInterval(c.heartbeat);
      c.res.end();
    });
  }
}
