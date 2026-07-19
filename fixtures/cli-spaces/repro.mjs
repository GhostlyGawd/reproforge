import { readFile } from "node:fs/promises";

const configFlag = process.argv.indexOf("--config");
const requestedConfig = configFlag >= 0 ? process.argv[configFlag + 1] : undefined;

if (!requestedConfig) {
  console.error("Missing required --config path");
  process.exitCode = 2;
} else {
  // Intentional fixture bug: an argument containing spaces is truncated before use.
  const configPath = requestedConfig.split(/\s+/u)[0];

  try {
    const contents = await readFile(configPath, "utf8");
    const config = JSON.parse(contents);
    console.log(`Loaded config for ${config.project}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
