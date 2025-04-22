import { Test, TestingModule } from '@nestjs/testing';
import { MessageBufferService } from './message-buffer.service';

describe('MessageBufferService', () => {
  let service: MessageBufferService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MessageBufferService],
    }).compile();

    service = module.get<MessageBufferService>(MessageBufferService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
