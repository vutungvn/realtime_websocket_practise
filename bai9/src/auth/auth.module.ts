import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { TokenService } from "./token.service";

@Module({
  controllers: [AuthController],
  providers: [TokenService],
  exports: [TokenService],
})
export class AuthModule {}
