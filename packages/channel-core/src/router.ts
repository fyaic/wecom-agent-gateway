import type {
  InboundMessage,
  RuntimeRouter,
} from "@fyaic/wecom-runtime-contract";

export class StaticRuntimeRouter implements RuntimeRouter {
  constructor(private readonly adapterId: string) {}

  async resolve(_message: InboundMessage): Promise<{ adapterId: string }> {
    return { adapterId: this.adapterId };
  }
}
