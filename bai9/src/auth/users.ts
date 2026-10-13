// Danh ba nguoi dung demo. Thuc te: bang users trong DB + dang nhap bang mat khau/OTP.
import { Point, Role } from "../contracts/models";

export interface UserRecord {
  id: string;
  role: Role;
  name: string;
  phone?: string;
  vehicle?: string;
  home?: Point; // vi tri xuat phat cua tai xe
}

export const USERS: UserRecord[] = [
  { id: "c-lan", role: "customer", name: "Chi Lan", phone: "0912345678" },
  { id: "c-minh", role: "customer", name: "Anh Minh", phone: "0987654321" },
  { id: "d-hung", role: "driver", name: "Hung", vehicle: "Wave 29X1-123.45", home: { lat: 21.028, lng: 105.85 } },
  { id: "d-tuan", role: "driver", name: "Tuan", vehicle: "Vision 29B2-678.90", home: { lat: 21.005, lng: 105.82 } },
  { id: "d-mai", role: "driver", name: "Mai", vehicle: "Lead 30H1-246.80", home: { lat: 21.04, lng: 105.8 } },
  { id: "op-ha", role: "dispatcher", name: "Ha (dieu phoi)" },
  { id: "op-nam", role: "dispatcher", name: "Nam (dieu phoi)" },
];

export const findUser = (id: string) => USERS.find((u) => u.id === id);
