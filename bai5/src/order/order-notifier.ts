// Hop dong chung cho ca 2 phien ban gateway (loi & da va),
// de controller / test dung chung ma khong can biet dang chay ban nao.

export const ORDER_NOTIFIER = Symbol('ORDER_NOTIFIER');

export type GatewayVariant = 'fixed' | 'buggy';

export interface DebugState {
  variant: GatewayVariant;
  /** So socket dang ket noi toi server */
  connectedSockets: number;
  /** So entry trong cau truc luu trang thai `tracked` cua gateway */
  trackedSize: number;
  /** socketId -> danh sach don dang theo doi */
  tracked: Record<string, string[]>;
  /** room "order:<id>" -> so socket trong room (chi ban da va dung room) */
  orderRooms: Record<string, number>;
}

export interface OrderNotifier {
  notifyStatusChanged(orderId: string, status: string): void;
  getDebugState(): DebugState;
}
