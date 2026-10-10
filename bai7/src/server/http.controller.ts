import { Controller, Get } from "@nestjs/common";
import { chatConfig } from "../shared/config";
import { ChatStore } from "./chat.store";

@Controller()
export class HttpController {
  constructor(private readonly store: ChatStore) {}

  /** Trinh duyet lay cung gioi han voi server (khong hard-code 2 noi). */
  @Get("config")
  config() {
    const { messageMaxLength, typingIdleMs, typingThrottleMs } = chatConfig;
    return { messageMaxLength, typingIdleMs, typingThrottleMs };
  }

  @Get("debug/sessions")
  sessions() {
    return this.store.allViews();
  }
}
