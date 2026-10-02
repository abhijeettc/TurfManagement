import { requireVenue } from './auth/guard.js';

/**
 * Resolve the venue a request is about.
 *
 * This used to return whichever venue was first in the table — single-tenant by
 * accident. It now proves the signed-in account holds a role on the venue, and
 * that the role carries the permission being exercised.
 *
 * Every caller already went through this function, which is why turning the
 * product multi-tenant was an access-layer change and not a rewrite.
 */
export async function resolveVenue(request, permission) {
  return requireVenue(request, permission);
}
