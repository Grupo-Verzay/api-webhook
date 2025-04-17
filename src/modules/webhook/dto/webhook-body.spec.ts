import { WebhookBodyDto } from "./webhook-body";

describe('WebhookBody', () => {
  it('should be defined', () => {
    expect(new WebhookBodyDto()).toBeDefined();
  });
});
