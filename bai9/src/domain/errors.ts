import { ErrorCode } from "../contracts/events";

/**
 * Loi nghiep vu co chu dich (sai quyen, sai trang thai...). Gateway doi thanh ack { ok:false, code, error }.
 * Moi loi KHAC deu bi coi la loi he thong (INTERNAL): ghi log, tra loi chung chung, khong lam sap server.
 */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
