// MO HINH DU LIEU tren day (view) - moi vai nhan mot "lat cat" khac nhau cua cung 1 don hang.
export type Role = "customer" | "driver" | "dispatcher";

export interface Point {
  lat: number;
  lng: number;
}
export interface Place extends Point {
  address: string;
}

/**
 * Vong doi don:
 *   pending --(offer)--> offered --(tai xe nhan)--> assigned --> picked_up --> delivered
 *      ^                   |  (tu choi / het han / tai xe mat ket noi / dieu phoi thu hoi)
 *      +-------------------+
 *   pending|offered|assigned --(dieu phoi huy)--> cancelled
 */
export type OrderStatus = "pending" | "offered" | "assigned" | "picked_up" | "delivered" | "cancelled";

export type DriverPresence = "online" | "lost" | "offline"; // lost = vua mat ket noi, dang trong thoi gian an han
export type DriverActivity = "idle" | "offered" | "busy";

// ---------------------------------------------------------------- view theo vai
/** Dieu phoi vien: thay day du. */
export interface DispatcherOrderView {
  id: string;
  status: OrderStatus;
  customer: { id: string; name: string; phone: string };
  driver: { id: string; name: string } | null;
  pickup: Place;
  dropoff: Place;
  createdAt: number;
  statusSince: number;
  rejectedBy: string[];
  stuck: boolean;
  history: { status: OrderStatus; at: number; by: string }[];
}

/** Khach hang: chi don cua minh, khong co thong tin noi bo (ai tu choi, lich su dieu phoi...). */
export interface CustomerOrderView {
  id: string;
  status: OrderStatus;
  pickup: Place;
  dropoff: Place;
  createdAt: number;
  statusSince: number;
  driver: { name: string; vehicle: string } | null; // chi co khi da co tai xe nhan
}

/** Tai xe: chi don dang duoc giao cho minh; so dien thoai khach bi che. */
export interface DriverOrderView {
  id: string;
  status: OrderStatus;
  pickup: Place;
  dropoff: Place;
  customer: { name: string; phoneMasked: string };
}

export interface OfferView {
  orderId: string;
  pickup: Place;
  dropoff: Place;
  distanceKm: number; // tu vi tri tai xe toi diem lay hang
  expiresAt: number;
  byDispatcher: boolean;
}

export interface DriverView {
  id: string;
  name: string;
  vehicle: string;
  onShift: boolean;
  presence: DriverPresence;
  activity: DriverActivity;
  location: Point | null;
  lastSeenAt: number | null;
  currentOrderId: string | null;
}

export type AlertKind = "order_stuck" | "driver_lost";
export type AlertStatus = "open" | "acknowledged" | "resolved";

export interface Alert {
  id: string;
  kind: AlertKind;
  status: AlertStatus;
  orderId: string | null;
  driverId: string | null;
  message: string;
  createdAt: number;
  handledBy: string | null;
}

export interface SessionUser {
  id: string;
  role: Role;
  name: string;
}

/** Trang thai ban dau gui ngay sau khi bat tay thanh cong - dung pham vi tung vai. */
export type Snapshot =
  | { role: "customer"; orders: CustomerOrderView[] }
  | { role: "driver"; driver: DriverView; currentOrder: DriverOrderView | null; offer: OfferView | null }
  | { role: "dispatcher"; orders: DispatcherOrderView[]; drivers: DriverView[]; alerts: Alert[] };
