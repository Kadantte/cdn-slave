const knexLib = require("knex");
const { config: Global } = require("../Global.js");
const { ensureDatabaseDirectory, getKnexConfig } = require("../db.js");

async function ensureSchema() {
  const knex = knexLib(getKnexConfig(Global));
  try {
    const hasTable = await knex.schema.hasTable("message_ids");
    if (!hasTable) {
      await knex.schema.createTable("message_ids", (table) => {
        table.text("ahid").primary();
        table.text("mid").notNullable().index();
      });
      console.log('Created table "message_ids".');
    } else {
      console.log('Table "message_ids" already exists.');
    }
  } finally {
    await knex.destroy();
  }
}

async function run() {
  try {
    ensureDatabaseDirectory(Global);
    await ensureSchema();
  } catch (error) {
    console.error("Database init failed:", error);
    process.exit(1);
  }
}

run();
