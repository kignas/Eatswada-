const jwt = require('jsonwebtoken');
const { JWT_ALGORITHM } = require('./jwtOptions');

/** Generate a signed JWT. tokenVersion lets the server revoke old sessions. */
const generateToken = (userId, role = 'user', tokenVersion = 0) => {
  return jwt.sign(
    { id: userId, role, tv: Number(tokenVersion) || 0 },
    process.env.JWT_SECRET,
    { algorithm: JWT_ALGORITHM, expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

module.exports = generateToken;
