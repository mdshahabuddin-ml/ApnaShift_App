// JWT sign/verify. Payload holds only { id, role } — never hash/phone.
// Throws if secret is missing (server.js also checks at startup).
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

function secret() {
  if (!config.jwtSecret) {
    throw new Error('JWT_SECRET missing hai — .env me set karo.');
  }
  return config.jwtSecret;
}

export function signToken({ id, role }) {
  return jwt.sign({ id, role }, secret(), { expiresIn: config.jwtExpiresIn });
}

export function verifyToken(token) {
  return jwt.verify(token, secret());
}
