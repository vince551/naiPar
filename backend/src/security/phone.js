export function normalizeKenyanPhone(rawPhone) {
  if (typeof rawPhone !== 'string') {
    throw new TypeError('Guardian phone number is invalid');
  }

  const compact = rawPhone.trim().replace(/[\s()-]/g, '');
  let normalized;

  if (/^0[17]\d{8}$/.test(compact)) {
    normalized = `+254${compact.slice(1)}`;
  } else if (/^254[17]\d{8}$/.test(compact)) {
    normalized = `+${compact}`;
  } else if (/^\+254[17]\d{8}$/.test(compact)) {
    normalized = compact;
  } else {
    throw new TypeError('Enter a valid Kenyan mobile number');
  }

  return normalized;
}
