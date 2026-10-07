import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.cwd());
const manifest = JSON.parse(await readFile(resolve(root, "openclaw.plugin.json"), "utf8"));
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const entryPath = resolve(root, pkg.openclaw?.extensions?.[0] ?? "");
await access(entryPath);
const entry = (await import(pathToFileURL(entryPath).href)).default;
if (!entry || typeof entry.register !== "function") {
  throw new Error("Plugin entry must expose a register(api) function.");
}
if (entry.id !== manifest.id || entry.name !== manifest.name) {
  throw new Error("Runtime plugin identity does not match openclaw.plugin.json.");
}
if (JSON.stringify(entry.configSchema?.jsonSchema) !== JSON.stringify(manifest.configSchema)) {
  throw new Error("Runtime config schema does not match openclaw.plugin.json.");
}
const registeredTools = [];
entry.register({
  registrationMode: "tool-discovery",
  registerTool(tool, options) {
    const name = options?.name ?? (typeof tool === "object" ? tool.name : undefined);
    if (name) registeredTools.push(name);
  },
});
const declaredTools = manifest.contracts?.tools ?? [];
if (JSON.stringify(registeredTools) !== JSON.stringify(declaredTools)) {
  throw new Error(
    `Registered tools do not match manifest. Registered=${JSON.stringify(registeredTools)} declared=${JSON.stringify(declaredTools)}`,
  );
}
console.log(`Plugin ${manifest.id} is valid (${registeredTools.length} tools, mixed tool/service entry).`);
