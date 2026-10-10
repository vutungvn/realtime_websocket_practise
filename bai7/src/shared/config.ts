// Cau hinh dung chung server + client (trinh duyet lay qua GET /config).
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const chatConfig = {
  port: num("PORT", 4000),

  /** Do dai toi da 1 tin nhan (dem theo ky tu that, emoji = 1). */
  messageMaxLength: num("MESSAGE_MAX_LENGTH", 2_000),
  /**
   * Tran kich thuoc 1 goi tin Socket.IO (mac dinh 1MB). Goi vuot tran bi NGAT KET NOI ngay,
   * nen dat du rong cho 20.000 ky tu tieng Viet (~60KB) de tang ung dung con tra loi than thien.
   */
  maxPayloadBytes: num("MAX_PAYLOAD_BYTES", 100_000),

  /** Client: het `typingIdleMs` khong go phim -> gui typing:stop. */
  typingIdleMs: num("TYPING_IDLE_MS", 3_000),
  /** Client: dang go lien tuc thi nhac lai typing:start toi da 1 lan / khoang nay. */
  typingThrottleMs: num("TYPING_THROTTLE_MS", 1_000),
  /** Server: luoi an toan - khong nghe gi them sau khoang nay thi tu tat (client chet / mat mang). */
  typingTtlMs: num("TYPING_TTL_MS", 4_000),

  /** Nhan vien mat ket noi (moi thiet bi) qua khoang nay -> phien ve hang cho. */
  agentGraceMs: num("AGENT_GRACE_MS", 15_000),
};
