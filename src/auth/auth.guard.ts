import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { SessionPayload } from './auth.service.js';

interface AuthenticatedRequest extends Request {
  wallet?: string;
}

/** Requires a valid session token (`Authorization: Bearer <jwt>`) issued by SIWE sign-in */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Missing session token');
    }

    try {
      const payload = await this.jwt.verifyAsync<SessionPayload>(token);
      request.wallet = payload.sub;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired session token');
    }
  }
}

/** The signed-in wallet address (lowercase); only valid on routes protected by SessionGuard */
export const SessionWallet = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const wallet = context.switchToHttp().getRequest<AuthenticatedRequest>().wallet;
    if (!wallet) throw new UnauthorizedException();
    return wallet;
  },
);
