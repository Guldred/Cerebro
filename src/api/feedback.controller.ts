import { Body, Controller, Post } from '@nestjs/common';
import { Identity } from '../auth/auth.guard';
import { CallerIdentity } from '../auth/identity.types';
import { FeedbackDto } from './dto';
import { FeedbackService } from './feedback.service';

/** 👍/👎 answer-quality feedback (plan §6 / Plan_Review P2). Auth-gated like the
 *  query endpoints — the caller's identity is recorded, the query hashed. */
@Controller()
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Post('feedback')
  async submit(@Body() dto: FeedbackDto, @Identity() identity: CallerIdentity) {
    return this.feedback.record(identity, dto);
  }
}
