'use strict';
const crypto = require('crypto');
const path   = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch {}

function _d(s) {
  if (!s || !s.startsWith('ENC:')) return s;
  try {
    const p = s.split(':');
    const k = Buffer.from(process.env.TOKEN_KEY || '', 'hex');
    if (k.length !== 32) return s;
    const dc = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(p[1], 'hex'));
    dc.setAuthTag(Buffer.from(p[2], 'hex'));
    return dc.update(Buffer.from(p[3], 'hex')) + dc.final('utf8');
  } catch { return null; }
}

module.exports = {
    tk: [
    ].map(_d).filter(Boolean),

    config: require("./config.json")
};
