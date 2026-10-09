// order.gateway.ts - BAN DA VA
//
// Nguyen tac: moi don hang = 1 room Socket.IO ("order:<id>").
//  - order:track   -> socket join room cua don do
//  - notify        -> chi phat vao room cua don do (khong broadcast toan server)
//  - disconnect    -> Socket.IO tu roi moi room; gateway xoa entry trong `tracked`
import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { DebugState, OrderNotifier } from './order-notifier';

const ORDER_ROOM_PREFIX = 'order:';
const roomOf = (orderId: string) => `${ORDER_ROOM_PREFIX}${orderId}`;

/** Chap nhan "1024" hoac 1024; tu choi undefined, object, chuoi rong, ky tu la. */
function normalizeOrderId(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const id = String(raw).trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

@WebSocketGateway({ cors: { origin: '*' } })
export class OrderGateway implements OrderNotifier, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(OrderGateway.name);

  // socketId -> tap cac don socket do dang theo doi (1 socket theo doi duoc nhieu don).
  // Room da du de phat dung nguoi nhan; Map nay giu lai de quan sat/kiem chung viec don dep.
  private readonly tracked = new Map<string, Set<string>>();

  handleConnection(client: Socket) {
    this.logger.log(`client vao: ${client.id}`);
  }

  @SubscribeMessage('order:track')
  handleTrack(@MessageBody() rawOrderId: unknown, @ConnectedSocket() client: Socket) {
    const orderId = normalizeOrderId(rawOrderId);
    if (!orderId) return { ok: false, error: 'orderId khong hop le' };

    client.join(roomOf(orderId));
    let orders = this.tracked.get(client.id);
    if (!orders) {
      orders = new Set();
      this.tracked.set(client.id, orders);
    }
    orders.add(orderId);

    this.logger.log(`${client.id} theo doi don ${orderId}`);
    return { ok: true, orderId };
  }

  @SubscribeMessage('order:untrack')
  handleUntrack(@MessageBody() rawOrderId: unknown, @ConnectedSocket() client: Socket) {
    const orderId = normalizeOrderId(rawOrderId);
    if (!orderId) return { ok: false, error: 'orderId khong hop le' };

    client.leave(roomOf(orderId));
    const orders = this.tracked.get(client.id);
    orders?.delete(orderId);
    if (orders && orders.size === 0) this.tracked.delete(client.id);

    return { ok: true, orderId };
  }

  notifyStatusChanged(orderId: string, status: string) {
    this.server.to(roomOf(orderId)).emit('order:updated', { orderId, status });
  }

  handleDisconnect(client: Socket) {
    // Socket.IO da goi leaveAll() truoc khi phat 'disconnect' -> room tu sach.
    this.tracked.delete(client.id);
    this.logger.log(`client roi di: ${client.id} (con ${this.tracked.size} entry)`);
  }

  getDebugState(): DebugState {
    const tracked: Record<string, string[]> = {};
    for (const [socketId, orders] of this.tracked) tracked[socketId] = [...orders];

    const orderRooms: Record<string, number> = {};
    for (const [room, members] of this.server.sockets.adapter.rooms) {
      if (room.startsWith(ORDER_ROOM_PREFIX)) orderRooms[room] = members.size;
    }

    return {
      variant: 'fixed',
      connectedSockets: this.server.sockets.sockets.size,
      trackedSize: this.tracked.size,
      tracked,
      orderRooms,
    };
  }
}
