import { Module } from "@nestjs/common";
import { AlertService } from "./alert.service";
import { DispatchService } from "./dispatch.service";
import { DomainEvents } from "./domain-events";
import { MonitorService } from "./monitor.service";
import { DriverRegistry, OrderRepository } from "./stores";

/** Tang nghiep vu: khong phu thuoc socket / HTTP. */
@Module({
  providers: [DomainEvents, OrderRepository, DriverRegistry, AlertService, DispatchService, MonitorService],
  exports: [DomainEvents, OrderRepository, DriverRegistry, AlertService, DispatchService, MonitorService],
})
export class DomainModule {}
