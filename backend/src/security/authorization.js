const CHILD_ROLES = new Set(['public_child', 'delegate']);

function sendError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

// req.auth must be populated by server-side session resolution only.
// Never construct it from request body, query parameters or client-supplied headers.
export function requireAuthenticated(req, res, next) {
  const actor = req.auth;

  if (!actor?.userId || !actor?.role || actor.status !== 'active') {
    return sendError(res, 401, 'AUTHENTICATION_REQUIRED', 'Please sign in to continue.');
  }

  if (CHILD_ROLES.has(actor.role) && actor.guardianConsentStatus !== 'approved') {
    return sendError(
      res,
      403,
      'GUARDIAN_CONSENT_REQUIRED',
      'Access is restricted until guardian consent is verified.'
    );
  }

  return next();
}

export function requireRoles(...allowedRoles) {
  if (!allowedRoles.length) throw new TypeError('At least one role is required');

  return (req, res, next) => {
    const actor = req.auth;

    if (!actor?.userId || !actor?.role || actor.status !== 'active') {
      return sendError(res, 401, 'AUTHENTICATION_REQUIRED', 'Please sign in to continue.');
    }

    if (CHILD_ROLES.has(actor.role) && actor.guardianConsentStatus !== 'approved') {
      return sendError(
        res,
        403,
        'GUARDIAN_CONSENT_REQUIRED',
        'Access is restricted until guardian consent is verified.'
      );
    }

    if (!allowedRoles.includes(actor.role)) {
      return sendError(res, 403, 'INSUFFICIENT_ROLE', 'You do not have permission to perform this action.');
    }

    return next();
  };
}
