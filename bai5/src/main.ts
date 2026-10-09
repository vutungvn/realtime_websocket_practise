import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { join } from "path";
import { AppModule } from "./app.module";
import { GatewayVariant } from "./order/order-notifier";

async function bootstrap() {
  const variant: GatewayVariant =
    process.env.GATEWAY === "buggy" ? "buggy" : "fixed";
  const port = Number(process.env.PORT ?? 4000);

  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(variant),
  );
  app.useStaticAssets(join(__dirname, "..", "public"));
  await app.listen(port);

  Logger.log(
    `Gateway [${variant.toUpperCase()}] chay tai http://localhost:${port}`,
    "Bootstrap",
  );
}
bootstrap();
