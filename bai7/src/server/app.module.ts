import { Module } from "@nestjs/common";
import { ChatGateway } from "./chat.gateway";
import { ChatStore } from "./chat.store";
import { HttpController } from "./http.controller";
import { TypingService } from "./typing.service";

@Module({
  controllers: [HttpController],
  providers: [ChatGateway, ChatStore, TypingService],
})
export class AppModule {}
