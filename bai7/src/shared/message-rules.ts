// Kiem tra noi dung tin nhan - CHAN BAY DU LIEU.
// Dung o ca client (chan som, khong ton request) va server (chot chan cuoi, vi client co the bi sua).
import { chatConfig } from "./config";
import { Fail } from "./contract";

// Ky tu "vo hinh": zero-width space/joiner, BOM... -> "tin chi co khoang trang" doi lot.
const INVISIBLE = /[​-‍⁠﻿]/g;

export type TextCheck = { ok: true; text: string } | Fail;

export const formatCount = (n: number) => n.toLocaleString("vi-VN");

export function checkMessageText(raw: unknown, max = chatConfig.messageMaxLength): TextCheck {
  if (typeof raw !== "string") {
    return { ok: false, code: "INVALID", error: "Tin nhắn không hợp lệ, bạn vui lòng thử lại." };
  }

  // Chuoi khong lo (vd 20.000 ky tu): bao loi ngay, khong can xu ly tung ky tu.
  if (raw.length > max * 4) return tooLong(raw.length, max);

  const text = raw.replace(/\r\n?/g, "\n").replace(INVISIBLE, "").trim();
  if (text.length === 0) {
    return { ok: false, code: "EMPTY", error: "Bạn chưa nhập nội dung. Hãy gõ vài chữ trước khi gửi nhé!" };
  }

  const length = [...text].length; // dem theo code point: emoji 😀 = 1 ky tu
  if (length > max) return tooLong(length, max);

  return { ok: true, text };
}

function tooLong(length: number, max: number): Fail {
  return {
    ok: false,
    code: "TOO_LONG",
    error:
      `Tin nhắn dài ${formatCount(length)} ký tự, vượt giới hạn ${formatCount(max)} ký tự. ` +
      `Bạn vui lòng rút gọn hoặc chia thành nhiều tin nhỏ hơn nhé.`,
  };
}

const CLIENT_MSG_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isClientMsgId = (v: unknown): v is string => typeof v === "string" && CLIENT_MSG_ID.test(v);
