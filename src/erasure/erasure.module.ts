import { Module } from '@nestjs/common';
import { ErasureService } from './erasure.service';

/** GDPR erasure (Plan_Review P1.4). DatabaseService + CONFIG are global. */
@Module({
  providers: [ErasureService],
  exports: [ErasureService],
})
export class ErasureModule {}
