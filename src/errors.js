/* eslint-disable max-classes-per-file */
const BaseError = require('base-error');

/**
 * Retires the browser when this is thrown
 */
class RetireError extends BaseError { }

/**
 * Omits from log when not in debugLog
 */
class OmitError extends BaseError { }

module.exports = {
    RetireError,
    OmitError,
};
