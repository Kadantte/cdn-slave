const fs = require("fs");
const path = require("path");

const { config: Global } = require("./Global.js");

function getSqliteFilename(config = Global) {
  const database = config.database || {};
  const filename = database.filename || "data/cdn-slave.sqlite";
  if (filename === ":memory:") {
    return filename;
  }
  return path.resolve(__dirname, filename);
}

function ensureDatabaseDirectory(config = Global) {
  const filename = getSqliteFilename(config);
  if (filename === ":memory:") {
    return filename;
  }
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  return filename;
}

function getKnexConfig(config = Global) {
  const filename = getSqliteFilename(config);
  return {
    client: "sqlite3",
    connection: { filename },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
  };
}

module.exports = { ensureDatabaseDirectory, getKnexConfig, getSqliteFilename };
