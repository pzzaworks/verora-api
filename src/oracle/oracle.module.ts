import { Module } from '@nestjs/common';
import { OracleService } from './oracle.service.js';

@Module({
  providers: [OracleService],
})
export class OracleModule {}
