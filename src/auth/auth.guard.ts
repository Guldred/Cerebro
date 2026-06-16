import {
  CanActivate,
  CustomDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IdentityService } from './identity.service';
import { CallerIdentity, IdentityError, PRINCIPALS_HEADER } from './identity.types';

const IS_PUBLIC = 'cerebro:public';

/** Marks an endpoint as identity-free (health checks only). */
export const Public = (): CustomDecorator => SetMetadata(IS_PUBLIC, true);

/** Injects the CallerIdentity the guard attached to the request. */
export const Identity = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CallerIdentity => {
    const identity = ctx.switchToHttp().getRequest().identity as CallerIdentity | undefined;
    if (!identity) {
      // Guard misconfiguration (e.g. an endpoint escaped APP_GUARD) — fail
      // loudly rather than serve an unfiltered query.
      throw new UnauthorizedException('No caller identity resolved for this request');
    }
    return identity;
  },
);

/**
 * Global REST identity guard. Every endpoint except @Public() ones gets a
 * CallerIdentity attached, minted by IdentityService — controllers never see
 * raw headers. In oidc modes a missing/invalid token is rejected HERE, before
 * any handler code runs.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly identityService: IdentityService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    try {
      request.identity = await this.identityService.resolve({
        authorization: request.headers['authorization'],
        devHeader: request.headers[PRINCIPALS_HEADER],
      });
    } catch (err) {
      if (err instanceof IdentityError) {
        if (err.code === 'GROUPS_UNRESOLVED' || err.code === 'DELEGATION_REQUIRED') {
          throw new ForbiddenException(err.message);
        }
        throw new UnauthorizedException(err.message);
      }
      throw err;
    }
    return true;
  }
}
