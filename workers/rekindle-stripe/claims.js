/**
 * Merge custom auth claims without dropping unrelated ones.
 *
 * Identity Toolkit's `accounts:update.customAttributes` REPLACES the whole
 * claims object. The Pro flow used to send `{ pro: true }`, which silently
 * deleted `ageVerified`, `moderator`, etc. Keep this helper pure so it can be
 * unit-tested outside the Workers runtime.
 */
export function mergeClaims(existing, updates) {
    const result = Object.assign({}, existing && typeof existing === 'object' ? existing : {});
    const patch = updates && typeof updates === 'object' ? updates : {};

    Object.keys(patch).forEach(function (key) {
        if (patch[key] === null || patch[key] === undefined) {
            delete result[key];
        } else {
            result[key] = patch[key];
        }
    });

    return result;
}
