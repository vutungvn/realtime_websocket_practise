import { AuthUser } from "../shared/contract";

/**
 * Gia lap xac thuc: token "customer:<id>" hoac "agent:<id>".
 * Thuc te: verify JWT trong handshake, lay role + id tu claim.
 * Danh tinh lay tu TOKEN chu khong tu socket -> 2 tab cua 1 nguoi = cung 1 user.
 */
export function verifyToken(token: unknown): AuthUser | null {
  if (typeof token !== "string") return null;
  const m = /^(customer|agent):([a-z0-9-]{1,32})$/.exec(token);
  return m ? { role: m[1] as AuthUser["role"], id: m[2] } : null;
}
