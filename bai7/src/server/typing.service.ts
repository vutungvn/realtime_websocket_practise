// Trang thai "dang soan tin" theo tung BEN cua phien (khach / nhan vien).
//
// Ai quyet dinh "3 giay khong go"? -> CLIENT (chi client biet phim duoc go luc nao):
//   go phim  -> typing:start (nhac lai toi da 1 lan/giay khi go lien tuc)
//   3s im    -> typing:stop
// Server chi:
//   - phat su kien khi trang thai DOI (false->true, true->false), khong phat lai moi phim
//   - luoi an toan typingTtlMs: client chet/mat mang khong kip gui stop -> tu tat
//   - tu tat khi ben do gui tin, roi phien, hoac socket dang go bi ngat
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { chatConfig } from "../shared/config";
import { Role } from "../shared/contract";

type Emit = (sessionId: string, role: Role, isTyping: boolean) => void;

interface TypingEntry {
  timer: NodeJS.Timeout;
  socketId: string; // socket gui start gan nhat (khach co the go tren 2 tab)
}

@Injectable()
export class TypingService implements OnModuleDestroy {
  private readonly active = new Map<string, TypingEntry>();
  private emit: Emit = () => {};

  bind(emit: Emit) {
    this.emit = emit;
  }

  start(sessionId: string, role: Role, socketId: string) {
    const key = `${sessionId}|${role}`;
    const entry = this.active.get(key);
    if (entry) clearTimeout(entry.timer);
    else this.emit(sessionId, role, true);
    this.active.set(key, { socketId, timer: setTimeout(() => this.stop(sessionId, role), chatConfig.typingTtlMs) });
  }

  stop(sessionId: string, role: Role) {
    const key = `${sessionId}|${role}`;
    const entry = this.active.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.active.delete(key);
    this.emit(sessionId, role, false);
  }

  /** Socket bi ngat: tat moi trang thai go ma socket do dang giu. */
  socketGone(socketId: string) {
    for (const [key, entry] of this.active) {
      if (entry.socketId !== socketId) continue;
      const [sessionId, role] = key.split("|") as [string, Role];
      this.stop(sessionId, role);
    }
  }

  /** Ben nao dang go trong phien (gui cho tab vua mo de hien dung trang thai). */
  typingRoles(sessionId: string): Role[] {
    return (["customer", "agent"] as Role[]).filter((r) => this.active.has(`${sessionId}|${r}`));
  }

  clearSession(sessionId: string) {
    this.stop(sessionId, "customer");
    this.stop(sessionId, "agent");
  }

  onModuleDestroy() {
    this.active.forEach((e) => clearTimeout(e.timer));
    this.active.clear();
  }
}
