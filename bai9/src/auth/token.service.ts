// Token dang JWT HS256 (header.payload.chu-ky), tu hien thuc bang crypto de thay ro tung buoc.
import { Injectable } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "crypto";
import { config } from "../config";
import { HandshakeError } from "../contracts/events";
import { Role, SessionUser } from "../contracts/models";

interface TokenPayload {
  sub: string;
  role: Role;
  name: string;
  iat: number; // giay
  exp: number; // giay
}

export type VerifyResult = { ok: true; user: SessionUser; expiresAt: number } | { ok: false; error: HandshakeError };

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");
const HEADER = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));

@Injectable()
export class TokenService {
  sign(user: SessionUser, ttlMs = config.tokenTtlMs, now = Date.now()): string {
    const payload: TokenPayload = {
      sub: user.id,
      role: user.role,
      name: user.name,
      iat: Math.floor(now / 1000),
      exp: Math.floor((now + ttlMs) / 1000),
    };
    const body = `${HEADER}.${b64url(JSON.stringify(payload))}`;
    return `${body}.${this.signature(body)}`;
  }

  verify(token: unknown, now = Date.now()): VerifyResult {
    if (typeof token !== "string" || token.length === 0) return { ok: false, error: "AUTH_REQUIRED" };
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== HEADER) return { ok: false, error: "AUTH_INVALID" };

    // So sanh chu ky voi thoi gian hang so -> khong lo thong tin qua do tre phan hoi.
    const expected = Buffer.from(this.signature(`${parts[0]}.${parts[1]}`));
    const actual = Buffer.from(parts[2]);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, error: "AUTH_INVALID" };

    let payload: TokenPayload;
    try {
      payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      return { ok: false, error: "AUTH_INVALID" };
    }
    if (!["customer", "driver", "dispatcher"].includes(payload.role) || typeof payload.sub !== "string") {
      return { ok: false, error: "AUTH_INVALID" };
    }
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return { ok: false, error: "AUTH_EXPIRED" };

    return { ok: true, user: { id: payload.sub, role: payload.role, name: payload.name }, expiresAt: payload.exp * 1000 };
  }

  private signature(body: string) {
    return createHmac("sha256", config.jwtSecret).update(body).digest("base64url");
  }
}
