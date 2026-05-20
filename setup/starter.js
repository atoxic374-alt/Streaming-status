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
        "ENC:352c4381b559e66be9034427:1b1555c193e5e353b4b237af93462896:b1a54b5f45b02bfb3e7b2ea526836aa013207ceb2a1f4ed7b6cf9446cafb3bfdaee09bc671058e40dd2c828955125183d708d121ff599d85b1fad440583b7f048b9191c20a4ec431"
    ].map(_d).filter(Boolean),

    config: require("./config.json")
};
