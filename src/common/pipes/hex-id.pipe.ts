import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

const HEX_PATTERN = /^[0-9a-fA-F]+$/;

/**
 * Validates hex identifiers in route params and normalizes them to lowercase.
 * `bytes` is the expected byte length; `prefixed` controls whether a `0x` prefix is required.
 */
@Injectable()
export class HexIdPipe implements PipeTransform<string, string> {
  constructor(
    private readonly bytes: number,
    private readonly prefixed = true,
  ) {}

  transform(value: string): string {
    const prefix = this.prefixed ? '0x' : '';
    const digits =
      typeof value === 'string' && value.startsWith(prefix) ? value.slice(prefix.length) : '';

    if (digits.length !== this.bytes * 2 || !HEX_PATTERN.test(digits)) {
      throw new BadRequestException(
        `Expected a ${this.bytes}-byte hex ${this.prefixed ? '0x-prefixed ' : ''}identifier`,
      );
    }
    return value.toLowerCase();
  }
}
