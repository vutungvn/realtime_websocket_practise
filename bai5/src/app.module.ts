import { DynamicModule, Module } from '@nestjs/common';
import { OrderController } from './order/order.controller';
import { OrderGateway } from './order/order.gateway';
import { BuggyOrderGateway } from './order/order.gateway.buggy';
import { GatewayVariant, ORDER_NOTIFIER } from './order/order-notifier';

@Module({})
export class AppModule {
  /** Chi dang ky 1 gateway: 'fixed' (mac dinh) hoac 'buggy' de tai hien loi. */
  static forRoot(variant: GatewayVariant = 'fixed'): DynamicModule {
    const gateway = variant === 'buggy' ? BuggyOrderGateway : OrderGateway;
    return {
      module: AppModule,
      controllers: [OrderController],
      providers: [gateway, { provide: ORDER_NOTIFIER, useExisting: gateway }],
    };
  }
}
