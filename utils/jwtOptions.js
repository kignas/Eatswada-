'use strict';

// Single source of truth for the JWT algorithm. Tokens are signed with it (utils/generateToken.js) and
// verified ONLY with it (middleware/authMiddleware.js), so a token naming any other algorithm is rejected.
const JWT_ALGORITHM = 'HS256';

module.exports = { JWT_ALGORITHM, JWT_VERIFY_OPTIONS: Object.freeze({ algorithms: Object.freeze([JWT_ALGORITHM]) }) };
