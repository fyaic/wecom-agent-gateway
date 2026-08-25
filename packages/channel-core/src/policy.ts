import type {
  InboundMessage,
  InboundPolicy,
} from "@fyaic/wecom-runtime-contract";

export interface AllowlistPolicyOptions {
  allowedSenders?: Iterable<string>;
  allowedConversations?: Iterable<string>;
  allowedDirectSenders?: Iterable<string>;
  allowedGroupConversations?: Iterable<string>;
  allowDirect?: boolean;
  allowGroup?: boolean;
  requireMentionInGroups?: boolean;
}

export class AllowlistPolicy implements InboundPolicy {
  private readonly senders: ReadonlySet<string>;
  private readonly conversations: ReadonlySet<string>;
  private readonly directSenders: ReadonlySet<string>;
  private readonly groupConversations: ReadonlySet<string>;

  constructor(private readonly options: AllowlistPolicyOptions) {
    this.senders = new Set(options.allowedSenders ?? []);
    this.conversations = new Set(options.allowedConversations ?? []);
    this.directSenders = new Set(options.allowedDirectSenders ?? []);
    this.groupConversations = new Set(options.allowedGroupConversations ?? []);
  }

  async authorize(
    message: InboundMessage,
  ): Promise<{ allowed: boolean; reason?: string }> {
    if (
      message.conversationType === "direct" &&
      this.options.allowDirect === false
    ) {
      return { allowed: false, reason: "direct conversations are disabled" };
    }
    if (
      message.conversationType === "group" &&
      this.options.allowGroup === false
    ) {
      return { allowed: false, reason: "group conversations are disabled" };
    }
    if (
      message.conversationType === "group" &&
      this.options.requireMentionInGroups === true &&
      message.metadata?.mentionedBot !== true
    ) {
      return { allowed: false, reason: "the bot was not mentioned" };
    }
    if (
      this.senders.size === 0 &&
      this.conversations.size === 0 &&
      this.directSenders.size === 0 &&
      this.groupConversations.size === 0
    ) {
      return { allowed: false, reason: "allowlist is empty" };
    }
    if (
      message.conversationType === "direct" &&
      this.directSenders.has(message.senderId)
    ) {
      return { allowed: true };
    }
    if (
      message.conversationType === "group" &&
      this.groupConversations.has(message.conversationId)
    ) {
      return { allowed: true };
    }
    if (
      this.senders.has(message.senderId) ||
      this.conversations.has(message.conversationId)
    ) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: "sender and conversation are not allowlisted",
    };
  }
}
