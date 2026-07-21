/**
 * Redirect auth failures to the portal login page with a stable error code.
 */
import type { Response } from 'express';

export type LoginAuthErrorCode =
  | 'google_not_configured'
  | 'google_setup_failed'
  | 'missing_code'
  | 'google_access_denied'
  | 'google_oauth_error'
  | 'wrong_hosted_domain'
  | 'domain_not_permitted'
  | 'email_not_verified'
  | 'no_employee_record'
  | 'adaptive_blocked'
  | 'auth_failed';

export function redirectLoginAuthError(
  res: Response,
  code: LoginAuthErrorCode,
  returnTo = '/',
  detail?: string,
): void {
  const params = new URLSearchParams();
  if (returnTo && returnTo !== '/') params.set('returnTo', returnTo);
  params.set('authError', code);
  if (detail) {
    // Short, URL-safe hint (Google error codes like invalid_grant)
    params.set('authDetail', detail.slice(0, 80));
  }
  res.redirect(`/login?${params.toString()}`);
}
