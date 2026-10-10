// Phia "dieu phoi / van hanh": tao don moi, xem trang thai tai xe, thong ke ket noi.
import { BadRequestException, Body, Controller, Get, Post } from "@nestjs/common";
import { log } from "../common/log";
import { DriverGateway } from "./driver.gateway";
import { OrderStore } from "./order.store";
import { PresenceService } from "./presence.service";

@Controller()
export class DispatchController {
  constructor(
    private readonly gateway: DriverGateway,
    private readonly presence: PresenceService,
    private readonly orders: OrderStore,
  ) {}

  @Post("orders")
  createOrder(@Body() body: { zone?: unknown; address?: unknown }) {
    const zone = typeof body?.zone === "string" ? body.zone : "";
    if (!/^[a-z0-9-]{1,40}$/.test(zone)) throw new BadRequestException("zone khong hop le");
    const address = typeof body.address === "string" && body.address ? body.address : "dia chi demo";

    const order = this.orders.create(zone, address);
    const deliveredTo = this.gateway.dispatchOrder(order);
    log("DISPATCH", `tao don ${order.orderId} (seq ${order.seq}) zone ${zone} -> phat vao room co ${deliveredTo} socket`);
    return { order, deliveredTo };
  }

  @Get("drivers")
  drivers() {
    return this.presence.list().map((d) => ({
      ...d,
      rooms: [...new Set(d.sockets.flatMap((s) => this.gateway.roomsOf(s)))].sort(),
    }));
  }

  @Get("stats")
  stats() {
    return { ...this.gateway.stats, connectedSockets: this.gateway.connectedSockets };
  }
}
