// Canh bao cho dieu phoi vien: mo -> (dieu phoi nhan xu ly) -> tu dong ket thuc khi su co het.
import { Injectable } from "@nestjs/common";
import { Alert, AlertKind } from "../contracts/models";
import { DomainEvents } from "./domain-events";
import { DomainError } from "./errors";

const KEEP_RESOLVED = 100;

@Injectable()
export class AlertService {
  private readonly alerts = new Map<string, Alert>();
  /** key su co (vd "stuck:O-0003:waiting") -> alertId dang mo, de khong bao trung 1 su co nhieu lan. */
  private readonly openByKey = new Map<string, string>();
  private seq = 0;

  constructor(private readonly events: DomainEvents) {}

  raise(key: string, kind: AlertKind, data: { orderId?: string; driverId?: string; message: string }) {
    if (this.openByKey.has(key)) return;
    const alert: Alert = {
      id: `A-${++this.seq}`,
      kind,
      status: "open",
      orderId: data.orderId ?? null,
      driverId: data.driverId ?? null,
      message: data.message,
      createdAt: Date.now(),
      handledBy: null,
    };
    this.alerts.set(alert.id, alert);
    this.openByKey.set(key, alert.id);
    this.events.emit("alert.raised", { alert });
  }

  /** Su co da het (don da chay tiep, tai xe da quay lai) -> dong canh bao. */
  resolve(key: string) {
    const id = this.openByKey.get(key);
    if (!id) return;
    this.openByKey.delete(key);
    const alert = this.alerts.get(id)!;
    alert.status = "resolved";
    this.events.emit("alert.updated", { alert });
    this.prune();
  }

  resolveWhere(prefix: string) {
    [...this.openByKey.keys()].filter((k) => k.startsWith(prefix)).forEach((k) => this.resolve(k));
  }

  /** Dieu phoi vien nhan xu ly -> cac dieu phoi vien khac thay "da co nguoi lo". */
  acknowledge(alertId: string, by: string) {
    const alert = this.alerts.get(alertId);
    if (!alert) throw new DomainError("NOT_FOUND", "Không tìm thấy cảnh báo.");
    if (alert.status === "resolved") throw new DomainError("CONFLICT", "Cảnh báo đã tự kết thúc.");
    alert.status = "acknowledged";
    alert.handledBy = by;
    this.events.emit("alert.updated", { alert });
    return alert;
  }

  hasOpen(key: string) {
    return this.openByKey.has(key);
  }

  list() {
    return [...this.alerts.values()];
  }

  get openCount() {
    return this.openByKey.size;
  }

  private prune() {
    const resolved = this.list().filter((a) => a.status === "resolved");
    resolved.slice(0, Math.max(0, resolved.length - KEEP_RESOLVED)).forEach((a) => this.alerts.delete(a.id));
  }
}
