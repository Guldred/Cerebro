import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class QueryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  question!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sourceSystems?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  topK?: number;
}

export class SearchDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  query!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sourceSystems?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  topK?: number;
}

export class FeedbackDto {
  /** The original question — hashed server-side, never stored raw (Art. 9). */
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  query!: string;

  @IsIn(['up', 'down'])
  rating!: 'up' | 'down';

  /** Document ids that were shown in the rated answer. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  chunkIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}
