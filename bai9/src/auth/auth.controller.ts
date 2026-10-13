import { Body, Controller, Get, HttpCode, NotFoundException, Post } from "@nestjs/common";
import { TokenService } from "./token.service";
import { findUser, USERS } from "./users";

/** Dang nhap DEMO (chon user, khong mat khau) - chi de chay thu. Thuc te thay bang dang nhap that. */
@Controller("auth")
export class AuthController {
  constructor(private readonly tokens: TokenService) {}

  @Get("users")
  users() {
    return USERS.map(({ id, role, name }) => ({ id, role, name }));
  }

  @Post("demo-login")
  @HttpCode(200)
  login(@Body() body: { userId?: unknown }) {
    const user = typeof body?.userId === "string" ? findUser(body.userId) : undefined;
    if (!user) throw new NotFoundException("Khong co nguoi dung nay");
    const session = { id: user.id, role: user.role, name: user.name };
    return { token: this.tokens.sign(session), user: session };
  }
}
