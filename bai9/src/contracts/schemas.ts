// KIEM TRA DU LIEU client gui len (runtime). Moi su kien client->server deu di qua 1 schema.
// Client co the bi sua -> khong tin bat ky truong nao chua qua day.
import { z } from "zod";

// Gioi han vung phuc vu (Ha Noi mo rong) - toa do ngoai vung la du lieu rac.
const lat = z.number().finite().min(20.5).max(21.5);
const lng = z.number().finite().min(105.3).max(106.3);
const id = z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/);

export const PointSchema = z.object({ lat, lng });
export const PlaceSchema = z.object({ lat, lng, address: z.string().trim().min(3).max(200) });

export const OrderPlaceSchema = z.object({ pickup: PlaceSchema, dropoff: PlaceSchema });
export const DriverShiftSchema = z.object({ onShift: z.boolean() });
export const DriverLocationSchema = PointSchema;
export const OfferRespondSchema = z.object({ orderId: id, accept: z.boolean() });
export const OrderProgressSchema = z.object({ orderId: id, status: z.enum(["picked_up", "delivered"]) });
export const DispatchAssignSchema = z.object({ orderId: id, driverId: id });
export const DispatchCancelSchema = z.object({ orderId: id, reason: z.string().trim().min(3).max(200) });
export const AlertAckSchema = z.object({ alertId: id });

export type OrderPlaceInput = z.infer<typeof OrderPlaceSchema>;
export type DriverShiftInput = z.infer<typeof DriverShiftSchema>;
export type DriverLocationInput = z.infer<typeof DriverLocationSchema>;
export type OfferRespondInput = z.infer<typeof OfferRespondSchema>;
export type OrderProgressInput = z.infer<typeof OrderProgressSchema>;
export type DispatchAssignInput = z.infer<typeof DispatchAssignSchema>;
export type DispatchCancelInput = z.infer<typeof DispatchCancelSchema>;
export type AlertAckInput = z.infer<typeof AlertAckSchema>;
