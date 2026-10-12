import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEthereumAddress, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';

export class ListAgentsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['active', 'suspended', 'slashed'] })
  @IsOptional()
  @IsIn(['active', 'suspended', 'slashed'])
  status?: 'active' | 'suspended' | 'slashed';

  @ApiPropertyOptional({ description: 'Owner wallet address' })
  @IsOptional()
  @IsEthereumAddress()
  owner?: string;

  @ApiPropertyOptional({ example: 'price_feed' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  capability?: string;

  @ApiPropertyOptional({ description: 'Case-insensitive search in agent names' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  search?: string;

  @ApiPropertyOptional({ enum: ['reputation', 'stake', 'newest'], default: 'reputation' })
  @IsOptional()
  @IsIn(['reputation', 'stake', 'newest'])
  sort?: 'reputation' | 'stake' | 'newest';
}
