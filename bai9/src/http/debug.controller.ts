import { Controller, ForbiddenException, Get, Headers, UnauthorizedException } from "@nestjs/common";
import { TokenService } from "../auth/token.service";
import { DispatchGateway } from "../realtime/dispatch.gateway";

/** Kiem tra tai nguyen (chi dieu phoi vien, can Bearer token) - chung minh khong ro ri. */
@Controller("debug")
export class DebugController {
  constructor(
    private readonly tokens: TokenService,
    private readonly gateway: DispatchGateway,
  ) {}

  @Get("resources")
  resources(@Headers("authorization") auth?: string) {
    const result = this.tokens.verify(auth?.replace(/^Bearer\s+/i, ""));
    if (!result.ok) throw new UnauthorizedException(result.error);
    if (result.user.role !== "dispatcher") throw new ForbiddenException("Chi dieu phoi vien");
    return this.gateway.resources();
  }
}
