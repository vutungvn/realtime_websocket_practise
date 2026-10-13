// Thuc the noi bo cua tang nghiep vu (KHONG gui thang ra ngoai - luon di qua projection theo vai).
import { DriverActivity, DriverPresence, OrderStatus, Place, Point } from "../contracts/models";

export interface Offer {
  driverId: string;
  expiresAt: number;
  byDispatcher: boolean;
}

export interface Order {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  pickup: Place;
  dropoff: Place;
  status: OrderStatus;
  driverId: string | null; // tai xe dang duoc moi / dang giao
  offer: Offer | null;
  createdAt: number;
  statusSince: number;
  /** Bat dau giai doan "cho tai xe" hien tai (pending <-> offered xoay vong van tinh chung). */
  waitingSince: number;
  rejectedBy: Set<string>;
  history: { status: OrderStatus; at: number; by: string }[];
}

export interface Driver {
  id: string;
  name: string;
  vehicle: string;
  onShift: boolean;
  presence: DriverPresence;
  activity: DriverActivity;
  location: Point | null;
  lastSeenAt: number | null;
  lastLocationAt: number;
  currentOrderId: string | null;
  offeredOrderId: string | null;
  /** Cac socket dang mo cua tai xe (1 tai xe co the dang nhap 2 may). Rong = mat ket noi. */
  sockets: Set<string>;
}

export const ACTIVE_STATUSES: OrderStatus[] = ["pending", "offered", "assigned", "picked_up"];
