const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.join(__dirname, "..");
const globalPath = path.join(rootDir, "Global.js");
const globalExamplePath = path.join(rootDir, "Global.example.js");
const nodeModulesPath = path.join(rootDir, "node_modules");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, label) {
  if (label) {
    console.log(label);
  }
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

async function setup() {
  if (!fs.existsSync(globalPath)) {
    if (!fs.existsSync(globalExamplePath)) {
      console.error("Missing Global.example.js. Please create Global.js.");
      process.exit(1);
    }
    fs.copyFileSync(globalExamplePath, globalPath);
    console.log("Created Global.js from Global.example.js.");
  }

  if (!fs.existsSync(nodeModulesPath)) {
    run(npmCommand, ["install"], "Installing dependencies...");
  } else {
    console.log("Dependencies already installed.");
  }

  run(npmCommand, ["run", "build-css"], "Building CSS...");

  run(npmCommand, ["run", "db:init"], "Initializing database...");
  console.log("Setup complete.");
}

setup();
