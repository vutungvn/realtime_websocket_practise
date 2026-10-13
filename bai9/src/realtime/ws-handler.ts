// KHUON XU LY MOI SU KIEN CLIENT -> SERVER:  quyen vai -> kiem du lieu -> nghiep vu -> bat MOI ngoai le.
// Ket qua luon la 1 ack co cau truc; khong ngoai le nao thoat ra lam sap socket hay server.
import { Logger } from "@nestjs/common";
import { z } from "zod";
import { Ack, ALLOWED_ROLES, C2S, Fail } from "../contracts/events";
import { SessionUser } from "../contracts/models";
import { DomainError } from "../domain/errors";

type C2SName = (typeof C2S)[keyof typeof C2S];
const logger = new Logger("WsHandler");

export function runHandler<S extends z.ZodType, R extends object>(
  event: C2SName,
  user: SessionUser,
  schema: S,
  body: unknown,
  action: (input: z.infer<S>) => R,
): Ack<R> {
  if (!ALLOWED_ROLES[event].includes(user.role)) {
    return fail("FORBIDDEN", `Vai trò "${user.role}" không được phép gửi "${event}".`);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.length ? ` ở trường "${issue.path.join(".")}"` : "";
    return fail("INVALID", `Dữ liệu không hợp lệ${where}: ${issue.message}`);
  }

  try {
    return { ok: true, ...action(parsed.data) };
  } catch (err) {
    if (err instanceof DomainError) return fail(err.code, err.message);
    logger.error(`${event} tu ${user.role}:${user.id} loi khong luong truoc: ${(err as Error)?.stack ?? err}`);
    return fail("INTERNAL", "Hệ thống gặp lỗi khi xử lý yêu cầu, bạn vui lòng thử lại.");
  }
}

const fail = (code: Fail["code"], error: string): Fail => ({ ok: false, code, error });
