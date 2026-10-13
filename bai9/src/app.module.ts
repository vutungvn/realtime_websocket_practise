import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { DomainModule } from "./domain/domain.module";
import { RealtimeModule } from "./realtime/realtime.module";

@Module({ imports: [AuthModule, DomainModule, RealtimeModule] })
export class AppModule {}
