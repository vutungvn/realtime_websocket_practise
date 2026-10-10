import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { fmtMs, log, timestamp } from "../common/log";
import { serverConfig } from "./config";

export type PresenceStatus = "online" | "reconnecting" | "offline";

interface DriverRecord {
  driverId: string;
  status: PresenceStatus;
  statusSince: number;
  sockets: Set<string>;
  /** Lan cuoi server nhan duoc bat ky goi tin nao (ke ca pong) tu tai xe */
  lastSeenAt: number;
  lastDisconnectReason?: string;
  offlineTimer?: NodeJS.Timeout;
}

export interface DriverPresence {
  driverId: string;
  status: PresenceStatus;
  statusSince: string;
  lastSeenAt: string;
  lastDisconnectReason?: string;
  sockets: string[];
}

/**
 * Trang thai tai xe cho doi van hanh:
 *   online --(mat socket cuoi cung)--> reconnecting --(het offlineGraceMs)--> offline
 *      ^                                   |
 *      +------(noi lai trong an han)-------+
 *
 * So ban ghi bi chan boi so tai xe (khong phai so ket noi), socket cu duoc xoa khi disconnect.
 */
@Injectable()
export class PresenceService implements OnModuleDestroy {
  private readonly drivers = new Map<string, DriverRecord>();

  markConnected(driverId: string, socketId: string) {
    const d = this.getOrCreate(driverId);
    clearTimeout(d.offlineTimer);
    d.offlineTimer = undefined;
    d.sockets.add(socketId);
    d.lastSeenAt = Date.now();
    if (d.status !== "online") this.setStatus(d, "online", `socket ${socketId}`);
  }

  touch(driverId: string) {
    const d = this.drivers.get(driverId);
    if (d) d.lastSeenAt = Date.now();
  }

  markDisconnected(driverId: string, socketId: string, reason: string) {
    const d = this.drivers.get(driverId);
    if (!d || !d.sockets.delete(socketId)) return;
    d.lastDisconnectReason = reason;
    if (d.sockets.size > 0) return; // van con ket noi khac (vd socket moi da noi lai truoc khi socket cu bi phat hien chet)

    this.setStatus(d, "reconnecting", `ly do: ${reason}, tin hieu cuoi luc ${timestamp(new Date(d.lastSeenAt))}`);
    d.offlineTimer = setTimeout(() => {
      d.offlineTimer = undefined;
      this.setStatus(
        d,
        "offline",
        `khong quay lai sau ${fmtMs(serverConfig.offlineGraceMs)} an han ` +
          `(mat tin hieu tu ${timestamp(new Date(d.lastSeenAt))}, ${fmtMs(Date.now() - d.lastSeenAt)} truoc)`,
      );
    }, serverConfig.offlineGraceMs);
  }

  get(driverId: string): DriverPresence | undefined {
    const d = this.drivers.get(driverId);
    return d && this.toView(d);
  }

  list(): DriverPresence[] {
    return [...this.drivers.values()].map((d) => this.toView(d));
  }

  onModuleDestroy() {
    for (const d of this.drivers.values()) clearTimeout(d.offlineTimer);
  }

  private getOrCreate(driverId: string): DriverRecord {
    let d = this.drivers.get(driverId);
    if (!d) {
      d = { driverId, status: "offline", statusSince: Date.now(), sockets: new Set(), lastSeenAt: Date.now() };
      this.drivers.set(driverId, d);
    }
    return d;
  }

  private setStatus(d: DriverRecord, status: PresenceStatus, detail: string) {
    const label = { online: "ONLINE", reconnecting: "DANG CHO NOI LAI", offline: "OFFLINE" }[status];
    log("SERVER", `tai xe ${d.driverId}: ${d.status.toUpperCase()} -> ${label} (${detail})`);
    d.status = status;
    d.statusSince = Date.now();
  }

  private toView(d: DriverRecord): DriverPresence {
    return {
      driverId: d.driverId,
      status: d.status,
      statusSince: new Date(d.statusSince).toISOString(),
      lastSeenAt: new Date(d.lastSeenAt).toISOString(),
      lastDisconnectReason: d.lastDisconnectReason,
      sockets: [...d.sockets],
    };
  }
}
