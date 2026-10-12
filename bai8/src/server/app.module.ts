import { Module } from "@nestjs/common";
import { AdminController, ApiController, StreamController } from "./controllers";
import { DashboardStore } from "./dashboard.store";
import { SimulatorService } from "./simulator.service";
import { StreamHub } from "./stream.hub";

@Module({
  controllers: [StreamController, ApiController, AdminController],
  providers: [DashboardStore, StreamHub, SimulatorService],
})
export class AppModule {}
