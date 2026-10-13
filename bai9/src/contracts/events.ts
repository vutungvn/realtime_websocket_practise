// HOP DONG SU KIEN - khop 1:1 voi bang trong README. Gateway va moi client deu dung file nay.
import {
  Alert,
  AlertStatus,
  CustomerOrderView,
  DispatcherOrderView,
  DriverOrderView,
  DriverView,
  OfferView,
  Role,
  SessionUser,
  Snapshot,
} from "./models";
import {
  AlertAckInput,
  DispatchAssignInput,
  DispatchCancelInput,
  DriverLocationInput,
  DriverShiftInput,
  OfferRespondInput,
  OrderPlaceInput,
  OrderProgressInput,
} from "./schemas";

/** Ten su kien: dung hang so thay vi chuoi rai rac khap noi. */
export const C2S = {
  ORDER_PLACE: "order:place",
  DRIVER_SHIFT: "driver:shift",
  DRIVER_LOCATION: "driver:location",
  OFFER_RESPOND: "offer:respond",
  ORDER_PROGRESS: "order:progress",
  DISPATCH_ASSIGN: "dispatch:assign",
  DISPATCH_CANCEL: "dispatch:cancel",
  ALERT_ACK: "alert:ack",
} as const;

export const S2C = {
  SESSION_READY: "session:ready",
  ORDER_UPDATED: "order:updated",
  OFFER_NEW: "offer:new",
  OFFER_CLOSED: "offer:closed",
  COURIER_LOCATION: "courier:location",
  DRIVER_UPDATED: "driver:updated",
  ALERT_RAISED: "alert:raised",
  ALERT_UPDATED: "alert:updated",
} as const;

/** Vai nao duoc phep gui su kien nao (kiem tra o gateway truoc khi goi nghiep vu). */
export const ALLOWED_ROLES: Record<(typeof C2S)[keyof typeof C2S], Role[]> = {
  "order:place": ["customer"],
  "driver:shift": ["driver"],
  "driver:location": ["driver"],
  "offer:respond": ["driver"],
  "order:progress": ["driver"],
  "dispatch:assign": ["dispatcher"],
  "dispatch:cancel": ["dispatcher"],
  "alert:ack": ["dispatcher"],
};

export type ErrorCode =
  | "INVALID" // du lieu sai dinh dang
  | "FORBIDDEN" // vai khong duoc phep / khong phai don cua minh
  | "NOT_FOUND"
  | "CONFLICT" // trang thai don khong cho phep thao tac (vd giao lai don da lay hang)
  | "DRIVER_UNAVAILABLE"
  | "RATE_LIMITED"
  | "INTERNAL"; // loi khong luong truoc - da duoc bat, server khong sap

export type Fail = { ok: false; code: ErrorCode; error: string };
export type Ack<T = unknown> = ({ ok: true } & T) | Fail;
type Reply<T> = (r: Ack<T>) => void;

export type OfferCloseReason = "accepted" | "rejected" | "expired" | "revoked" | "driver_lost" | "cancelled";

/** Ma loi khi bat tay that bai (client nhan qua connect_error.message). */
export type HandshakeError = "AUTH_REQUIRED" | "AUTH_INVALID" | "AUTH_EXPIRED";

// ---------------------------------------------------------------- client -> server
export interface ClientToServerEvents {
  "order:place": (p: OrderPlaceInput, ack: Reply<{ order: CustomerOrderView }>) => void;
  "driver:shift": (p: DriverShiftInput, ack: Reply<{ driver: DriverView }>) => void;
  "driver:location": (p: DriverLocationInput, ack?: Reply<{ accepted: boolean }>) => void;
  "offer:respond": (p: OfferRespondInput, ack: Reply<{ order: DriverOrderView | null }>) => void;
  "order:progress": (p: OrderProgressInput, ack: Reply<{ order: DriverOrderView }>) => void;
  "dispatch:assign": (p: DispatchAssignInput, ack: Reply<{ order: DispatcherOrderView }>) => void;
  "dispatch:cancel": (p: DispatchCancelInput, ack: Reply<{ order: DispatcherOrderView }>) => void;
  "alert:ack": (p: AlertAckInput, ack: Reply<{ alert: Alert }>) => void;
}

// ---------------------------------------------------------------- server -> client
export interface ServerToClientEvents {
  /** Moi vai, ngay sau bat tay: thong tin dang nhap + snapshot dung pham vi. */
  "session:ready": (p: { user: SessionUser; snapshot: Snapshot }) => void;
  /** Khach (don cua minh) / tai xe (don duoc giao) / dieu phoi (moi don) - payload la view theo vai. */
  "order:updated": (p: { order: CustomerOrderView | DriverOrderView | DispatcherOrderView }) => void;
  /** Chi tai xe duoc moi. */
  "offer:new": (p: { offer: OfferView }) => void;
  /** Chi tai xe duoc moi: loi moi het hieu luc. */
  "offer:closed": (p: { orderId: string; reason: OfferCloseReason }) => void;
  /** Chi khach co don dang duoc giao boi tai xe do. */
  "courier:location": (p: { orderId: string; lat: number; lng: number; at: number }) => void;
  /** Chi dieu phoi. */
  "driver:updated": (p: { driver: DriverView }) => void;
  "alert:raised": (p: { alert: Alert }) => void;
  "alert:updated": (p: { alertId: string; status: AlertStatus; handledBy: string | null }) => void;
}

export interface SocketData {
  user: SessionUser;
}
