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
        "ENC:1375822ded778760a33c1eca:fb5c6bcbffb471c2e0b7fcaf11d3e644:dc65779d99decfc3a2ed2e01283934c5739b260ee2bd25ebc67c7d9cbfca5b6bf5732819f3ce2edf4b484b2a85e89d41b874d3e0a1a0a2bfe35b991847817a361a75dfe7d9fe",
        "ENC:42e38b840fb3650c90dc9d1a:e444bd81822315c0f8e40cff7abd7a9e:e1ef04ae7a0e7f04c45f89f06fa7e1c10659e309a9f404fadf338b81ff9e8b53512214fa77e9cb0d31bbb2b09db1b5fe3f5c5070ed83b2adc41d68358d75fdddb511bf029b9b"
    ].map(_d).filter(Boolean),

    config: require("./config.json")
};
