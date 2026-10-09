// order.gateway.buggy.ts - BAN GOC tu staging, giu nguyen logic loi de doi chieu.
// Chi them getDebugState() de quan sat ben trong, KHONG sua hanh vi.
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { DebugState, OrderNotifier } from './order-notifier';

@WebSocketGateway({ cors: { origin: '*' } })
export class BuggyOrderGateway implements OrderNotifier {
  @WebSocketServer() server: Server;
  private tracked = new Map<string, string>();

  @SubscribeMessage('order:track')
  handleTrack(@MessageBody() orderId: string, @ConnectedSocket() client: Socket) {
    this.tracked.set(client.id, orderId); // LOI 3: ghi de, 1 socket chi theo doi duoc 1 don
    return { ok: true };
  }

  notifyStatusChanged(orderId: string, status: string) {
    this.server.emit('order:updated', { orderId, status }); // LOI 1: phat cho TAT CA socket
  }

  handleDisconnect(client: Socket) {
    console.log('client roi di:', client.id); // LOI 2: khong xoa entry trong `tracked`
  }

  getDebugState(): DebugState {
    const tracked: Record<string, string[]> = {};
    for (const [socketId, orderId] of this.tracked) tracked[socketId] = [orderId];
    return {
      variant: 'buggy',
      connectedSockets: this.server.sockets.sockets.size,
      trackedSize: this.tracked.size,
      tracked,
      orderRooms: {},
    };
  }
}
