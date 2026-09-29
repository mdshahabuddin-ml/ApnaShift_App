// JWT sign/verify. Payload me sirf { id, role } — hash/phone kabhi nahi.
// Secret missing ho to throw (server.js start par bhi check karta hai).
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
