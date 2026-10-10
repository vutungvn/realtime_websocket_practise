import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { AddressInfo } from "net";
import { join } from "path";
import { AppModule } from "./app.module";

/** Khoi dong server; port 0 = de he dieu hanh chon port trong (dung cho test/demo). */
export async function startServer(port: number) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ["error", "warn"] });
  app.useStaticAssets(join(__dirname, "..", "..", "public"));
  await app.listen(port, "0.0.0.0"); // 0.0.0.0 de dien thoai cung mang LAN truy cap duoc
  const actualPort = (app.getHttpServer().address() as AddressInfo).port;
  return { app, port: actualPort };
}
