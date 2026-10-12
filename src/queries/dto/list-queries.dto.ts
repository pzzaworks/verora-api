import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEthereumAddress, IsIn, IsOptional, Matches } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';

export class ListQueriesDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Requester wallet address' })
  @IsOptional()
  @IsEthereumAddress()
  requester?: string;

  @ApiPropertyOptional({ description: 'Assigned agent ID (bytes32)' })
  @IsOptional()
  @Matches(/^0x[0-9a-fA-F]{64}$/)
  agentId?: string;

  @ApiPropertyOptional({ enum: ['pending', 'in_progress', 'completed', 'failed'] })
  @IsOptional()
  @IsIn(['pending', 'in_progress', 'completed', 'failed'])
  status?: string;
}
