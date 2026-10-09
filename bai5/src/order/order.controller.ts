// Gia lap phia "he thong noi bo": admin/kho cap nhat trang thai don qua HTTP,
// sau khi "luu DB" thi goi gateway de day thong bao realtime.
import { Body, Controller, Get, Inject, Param, Patch } from '@nestjs/common';
import { ORDER_NOTIFIER, OrderNotifier } from './order-notifier';

@Controller()
export class OrderController {
  constructor(@Inject(ORDER_NOTIFIER) private readonly notifier: OrderNotifier) {}

  @Patch('orders/:id/status')
  updateStatus(@Param('id') orderId: string, @Body('status') status = 'UPDATED') {
    // (thuc te: orderRepository.update(...) o day)
    this.notifier.notifyStatusChanged(orderId, status);
    return { ok: true, orderId, status };
  }

  @Get('debug/state')
  debugState() {
    return this.notifier.getDebugState();
  }
}
