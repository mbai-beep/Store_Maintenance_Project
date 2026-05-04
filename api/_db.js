// api/_db.js - DEPRECATED, kept as shim. Use ../lib/db instead.
const { getDB, ensureSchema } = require('../lib/db');
module.exports = { getDB, ensureTable: ensureSchema };
