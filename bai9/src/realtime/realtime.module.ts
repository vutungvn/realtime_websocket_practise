import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DomainModule } from "../domain/domain.module";
import { DebugController } from "../http/debug.controller";
import { DispatchGateway } from "./dispatch.gateway";
import { Projector } from "./projector";

@Module({
  imports: [AuthModule, DomainModule],
  controllers: [DebugController],
  providers: [DispatchGateway, Projector],
})
export class RealtimeModule {}
