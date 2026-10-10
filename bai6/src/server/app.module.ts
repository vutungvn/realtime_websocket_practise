import { Module } from "@nestjs/common";
import { DispatchController } from "./dispatch.controller";
import { DriverGateway } from "./driver.gateway";
import { OrderStore } from "./order.store";
import { PresenceService } from "./presence.service";

@Module({
  controllers: [DispatchController],
  providers: [DriverGateway, PresenceService, OrderStore],
})
export class AppModule {}
